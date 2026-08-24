import {
  createHttpTransport,
  type HttpResponse,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";

export const PADDLE_API_VERSION = "1";

export async function paddleRequest(
  context: ProviderContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  const apiKey = context.credentials.apiKey;
  if (apiKey === undefined || !matchesEnvironment(apiKey, context.connection.environment))
    throw new PolybillError("Paddle API key does not match the connection environment", {
      code: "authentication_failed",
      operation: "paddle.authenticate",
      provider: "paddle",
      connectionId: context.connection.id,
      retryable: false,
    });
  const base =
    context.connection.environment === "test"
      ? "https://sandbox-api.paddle.com"
      : "https://api.paddle.com";
  const response = await createHttpTransport({ fetch: context.fetch, provider: "paddle" }).send({
    url: `${base}${path}`,
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Paddle-Version": PADDLE_API_VERSION,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status >= 400)
    throw new PolybillError("Paddle Billing rejected the request", {
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
      operation: "paddle.request",
      provider: "paddle",
      connectionId: context.connection.id,
      retryable: response.status === 429 || response.status >= 500,
    });
  return response;
}

function matchesEnvironment(key: string, environment: "test" | "live"): boolean {
  return environment === "test" ? key.startsWith("pdl_sdbx_") : key.startsWith("pdl_live_");
}
