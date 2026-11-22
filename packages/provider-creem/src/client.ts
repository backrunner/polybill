import {
  assertCredentialEnvironment,
  createHttpTransport,
  providerIdempotencyKey,
  type HttpResponse,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";

export const CREEM_API_VERSION = "openapi-2026-11-21";

const creditErrorCodes = new Set([
  "insufficient_balance",
  "moderation_denied",
  "moderation_flagged",
  "moderation_result_already_used",
  "moderation_result_expired",
  "paid_grant_not_reversible",
]);

export async function creemRequest(
  context: ProviderContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  assertCredentialEnvironment(context, "creem.authenticate");
  const apiKey = context.credentials.apiKey;
  if (
    apiKey === undefined ||
    apiKey.length < 8 ||
    !apiKey.startsWith("creem_") ||
    apiKey.startsWith("creem_test_") !== (context.connection.environment === "test")
  )
    throw new PolybillError("Creem API key is missing or does not match the environment", {
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
  const key = await providerIdempotencyKey(context, method, path);
  const response = await createHttpTransport({
    fetch: context.fetch,
    provider: "creem",
    deadline: context.deadline,
    clock: context.clock,
  }).send({
    url: `${base}${path}`,
    method,
    headers: {
      "x-api-key": apiKey,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status >= 400) {
    const providerCode = path.startsWith("/v1/customer-credits/")
      ? creditErrorCode(response)
      : undefined;
    throw new PolybillError("Creem rejected the request", {
      code:
        response.status === 401
          ? "authentication_failed"
          : response.status === 403
            ? "permission_denied"
            : response.status === 404
              ? "not_found"
              : response.status === 409
                ? "conflict"
                : response.status === 429
                  ? "rate_limited"
                  : response.status >= 500
                    ? "provider_unavailable"
                    : "invalid_request",
      operation: "creem.request",
      provider: "creem",
      connectionId: context.connection.id,
      retryable: response.status === 429 || response.status >= 500,
      ...(providerCode === undefined ? {} : { providerCode }),
    });
  }
  return response;
}

function creditErrorCode(response: HttpResponse): string | undefined {
  try {
    const body = response.json();
    if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
    const error = body.error;
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    return typeof error.code === "string" && creditErrorCodes.has(error.code)
      ? error.code
      : undefined;
  } catch {
    return undefined;
  }
}
