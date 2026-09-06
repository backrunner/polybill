import type { ProviderAdapter } from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime } from "@polybill/core";
import {
  providerName,
  type InboxRecord,
  type WebhookConnectionResolver,
  type WebhookInboxStore,
  type WebhookQueue,
} from "./ports.js";

const ALLOWED = new Set([
  "stripe",
  "dodo",
  "polar",
  "creem",
  "waffo",
  "lemon-squeezy",
  "paddle",
  "x402",
]);

export interface WebhookHandlerOptions {
  readonly resolver: WebhookConnectionResolver;
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly inbox: WebhookInboxStore;
  readonly queue: WebhookQueue;
  readonly maxBodyBytes?: number;
  readonly now?: () => string;
}

export function createWebhookHandler(
  options: WebhookHandlerOptions,
): (request: Request) => Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1)
    throw new RangeError("Invalid webhook body limit");
  return async (request) => {
    try {
      if (request.method !== "POST") return response({ code: "method_not_allowed" }, 405);
      const route = /^\/webhooks\/polybill\/([^/]+)(?:\/([^/]+))?\/?$/.exec(
        new URL(request.url).pathname,
      );
      const providerSlug = route?.[1];
      const connectionId = route?.[2];
      if (providerSlug === undefined || !ALLOWED.has(providerSlug))
        return response({ code: "provider_not_found" }, 404);
      if (
        (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() !==
        "application/json"
      )
        return response({ code: "content_type_invalid" }, 415);
      const adapter = options.adapters.get(providerSlug);
      if (adapter === undefined) return response({ code: "provider_not_configured" }, 404);
      const resolved = await options.resolver.resolve({
        provider: providerSlug,
        ...(connectionId === undefined ? {} : { connectionId }),
        headers: request.headers,
      });
      if (resolved === undefined) return response({ code: "connection_ambiguous" }, 400);
      const expectedProvider = providerName(providerSlug);
      if (
        expectedProvider === undefined ||
        adapter.descriptor.name !== expectedProvider ||
        resolved.connection.provider !== expectedProvider ||
        resolved.connection.tenantId !== resolved.tenantId ||
        (connectionId !== undefined && connectionId !== resolved.connection.id)
      )
        return response({ code: "connection_provider_mismatch" }, 400);
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes)
        return response({ code: "body_too_large" }, 413);
      const body = await readBody(request, maxBodyBytes);
      if (body === undefined) return response({ code: "body_too_large" }, 413);
      const now = parseIsoDateTime((options.now ?? (() => new Date().toISOString()))());
      let verified;
      try {
        verified = await adapter.webhooks.verify({
          rawBody: body,
          headers: request.headers,
          secret: resolved.secret,
          environment: resolved.connection.environment,
          now,
          replayProtection: "inbox",
        });
        if (
          verified.provider !== expectedProvider ||
          verified.environment !== resolved.connection.environment
        )
          return response({ code: "connection_provider_mismatch" }, 400);
      } catch (error) {
        if (error instanceof PolybillError && error.code === "replay_rejected")
          return response({ code: error.code }, 401);
        return response({ code: "signature_invalid" }, 401);
      }
      const record: InboxRecord = {
        tenantId: resolved.tenantId,
        connection: resolved.connection,
        deliveryKey: verified.deliveryKey,
        ...(verified.providerEventId === undefined
          ? {}
          : { providerEventId: verified.providerEventId }),
        receivedAt: now,
        verified,
      };
      const claim = await options.inbox.claim(record);
      if (claim !== "claimed")
        return new Response(null, { status: claim === "duplicate_processing" ? 202 : 204 });
      try {
        await options.queue.send(record);
        await options.inbox.markQueued(record);
      } catch {
        await options.inbox.markFailed(record, "queue_dispatch_failed", true);
        return response({ code: "webhook_unavailable" }, 503);
      }
      return new Response(null, { status: 202 });
    } catch {
      return response({ code: "webhook_unavailable" }, 503);
    }
  };
}

async function readBody(request: Request, maximum: number): Promise<Uint8Array | undefined> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function response(body: Readonly<Record<string, string>>, status: number): Response {
  return Response.json(body, { status });
}
