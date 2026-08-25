import {
  assertCredentialEnvironment,
  createHttpTransport,
  type HttpResponse,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";

export const CREEM_API_VERSION = "openapi-2026-08-25";

export async function creemRequest(
  context: ProviderContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  assertCredentialEnvironment(context, "creem.authenticate");
  const apiKey = context.credentials.apiKey;
  if (apiKey === undefined || apiKey.length < 8)
    throw new PolybillError("Creem API key is missing", {
      code: "authentication_failed",
      operation: "creem.authenticate",
      provider: "creem",
      connectionId: context.connection.id,
      retryable: false,
    });
  const base =
    context.connection.environment === "test"
      ? "https://test-api.creem.io"
      : "https://api.creem.io";
  const response = await createHttpTransport({ fetch: context.fetch, provider: "creem" }).send({
    url: `${base}${path}`,
    method,
    headers: {
      "x-api-key": apiKey,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(context.idempotencyKey === undefined
        ? {}
        : { "Idempotency-Key": context.idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status >= 400)
    throw new PolybillError("Creem rejected the request", {
      code:
        response.status === 401
          ? "authentication_failed"
          : response.status === 403
            ? "permission_denied"
            : response.status === 404
              ? "not_found"
              : response.status === 429
                ? "rate_limited"
                : response.status >= 500
                  ? "provider_unavailable"
                  : "invalid_request",
      operation: "creem.request",
      provider: "creem",
      connectionId: context.connection.id,
      retryable: response.status === 429 || response.status >= 500,
    });
  return response;
}
