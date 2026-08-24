import {
  createHttpTransport,
  type HttpResponse,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";

export const POLAR_API_VERSION = "2026-04";

export async function polarRequest(
  context: ProviderContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  const token = context.credentials.accessToken;
  if (token === undefined || token.length < 8)
    throw new PolybillError("Polar access token is missing", {
      code: "authentication_failed",
      operation: "polar.authenticate",
      provider: "polar",
      connectionId: context.connection.id,
      retryable: false,
    });
  const base =
    context.connection.environment === "test"
      ? "https://sandbox-api.polar.sh"
      : "https://api.polar.sh";
  const response = await createHttpTransport({ fetch: context.fetch, provider: "polar" }).send({
    url: `${base}${path}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(context.idempotencyKey === undefined
        ? {}
        : { "Idempotency-Key": context.idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status >= 400)
    throw new PolybillError("Polar rejected the request", {
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
      operation: "polar.request",
      provider: "polar",
      connectionId: context.connection.id,
      retryable: response.status === 429 || response.status >= 500,
    });
  return response;
}
