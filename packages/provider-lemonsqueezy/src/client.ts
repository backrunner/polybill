import {
  assertCredentialEnvironment,
  createHttpTransport,
  type HttpResponse,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";

export const LEMON_API_VERSION = "v1-jsonapi-2026-08-25";

export async function lemonRequest(
  context: ProviderContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  assertCredentialEnvironment(context, "lemonSqueezy.authenticate");
  const apiKey = context.credentials.apiKey;
  if (apiKey === undefined || apiKey.length < 8)
    throw new PolybillError("Lemon Squeezy API key is missing", {
      code: "authentication_failed",
      operation: "lemonSqueezy.authenticate",
      provider: "lemonSqueezy",
      connectionId: context.connection.id,
      retryable: false,
    });
  const response = await createHttpTransport({
    fetch: context.fetch,
    provider: "lemonSqueezy",
  }).send({
    url: `https://api.lemonsqueezy.com/v1${path}`,
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
      ...(context.idempotencyKey === undefined
        ? {}
        : { "Idempotency-Key": context.idempotencyKey }),
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status >= 400)
    throw new PolybillError("Lemon Squeezy rejected the request", {
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
      operation: "lemonSqueezy.request",
      provider: "lemonSqueezy",
      connectionId: context.connection.id,
      retryable: response.status === 429 || response.status >= 500,
    });
  return response;
}
