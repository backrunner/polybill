import {
  createHttpTransport,
  type HttpResponse,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";

const API = "https://api.stripe.com";
export const STRIPE_API_VERSION = "2025-08-27.basil";

export async function stripeRequest(
  context: ProviderContext,
  method: "GET" | "POST",
  path: string,
  body?: URLSearchParams,
): Promise<HttpResponse> {
  const apiKey = context.credentials.apiKey;
  if (apiKey === undefined || !matchesEnvironment(apiKey, context.connection.environment)) {
    throw new PolybillError("Stripe credential does not match the connection environment", {
      code: "authentication_failed",
      operation: "stripe.authenticate",
      provider: "stripe",
      connectionId: context.connection.id,
      retryable: false,
    });
  }
  const response = await createHttpTransport({ fetch: context.fetch, provider: "stripe" }).send({
    url: `${API}${path}`,
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(context.idempotencyKey === undefined
        ? {}
        : { "Idempotency-Key": context.idempotencyKey }),
      ...(body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    ...(body === undefined ? {} : { body }),
  });
  if (response.status >= 400) throw stripeError(response.status, context);
  return response;
}

function matchesEnvironment(key: string, environment: "test" | "live"): boolean {
  return environment === "test" ? key.startsWith("sk_test_") : key.startsWith("sk_live_");
}

function stripeError(status: number, context: ProviderContext): PolybillError {
  const code =
    status === 401
      ? "authentication_failed"
      : status === 403
        ? "permission_denied"
        : status === 404
          ? "not_found"
          : status === 429
            ? "rate_limited"
            : status >= 500
              ? "provider_unavailable"
              : "invalid_request";
  return new PolybillError("Stripe rejected the request", {
    code,
    operation: "stripe.request",
    provider: "stripe",
    connectionId: context.connection.id,
    retryable: status === 429 || status >= 500,
  });
}
