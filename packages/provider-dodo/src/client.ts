import {
  assertCredentialEnvironment,
  createHttpTransport,
  providerIdempotencyKey,
  type HttpResponse,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";

export const DODO_API_VERSION = "1.113.6";

export async function dodoRequest(
  context: ProviderContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  assertCredentialEnvironment(context, "dodo.authenticate");
  const apiKey = context.credentials.apiKey;
  if (apiKey === undefined || apiKey.length < 8)
    throw new PolybillError("Dodo API key is missing", {
      code: "authentication_failed",
      operation: "dodo.authenticate",
      provider: "dodo",
      connectionId: context.connection.id,
      retryable: false,
    });
  const base =
    context.connection.environment === "test"
      ? "https://test.dodopayments.com"
      : "https://live.dodopayments.com";
  const key = await providerIdempotencyKey(context, method, path);
  const response = await createHttpTransport({
    fetch: context.fetch,
    provider: "dodo",
    deadline: context.deadline,
    clock: context.clock,
  }).send({
    url: `${base}${path}`,
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status >= 400) throw dodoError(response.status, context);
  return response;
}

function dodoError(status: number, context: ProviderContext): PolybillError {
  const code =
    status === 401
      ? "authentication_failed"
      : status === 403
        ? "permission_denied"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 429
              ? "rate_limited"
              : status >= 500
                ? "provider_unavailable"
                : "invalid_request";
  return new PolybillError("Dodo Payments rejected the request", {
    code,
    operation: "dodo.request",
    provider: "dodo",
    connectionId: context.connection.id,
    retryable: status === 429 || status >= 500,
  });
}
