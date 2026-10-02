import {
  assertCredentialEnvironment,
  createHttpTransport,
  providerIdempotencyKey,
  type HttpResponse,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import { POLAR_API_VERSION, assertPolarApiVersion, type PolarApiVersion } from "./api-version.js";

export type PolarRequest = (
  context: ProviderContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<HttpResponse>;

export function createPolarRequest(apiVersion: PolarApiVersion): PolarRequest {
  assertPolarApiVersion(apiVersion);
  return (context, method, path, body) => polarRequest(context, method, path, body, apiVersion);
}

export async function polarRequest(
  context: ProviderContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  apiVersion: PolarApiVersion = POLAR_API_VERSION,
): Promise<HttpResponse> {
  assertPolarApiVersion(apiVersion);
  assertCredentialEnvironment(context, "polar.authenticate");
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
  const key = await providerIdempotencyKey(context, method, path);
  const response = await createHttpTransport({
    fetch: context.fetch,
    provider: "polar",
    deadline: context.deadline,
    clock: context.clock,
  }).send({
    url: `${base}${path}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Polar-Version": apiVersion,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
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
  if (response.headers.get("Polar-Version") !== apiVersion)
    throw new PolybillError("Polar response did not confirm the pinned API version", {
      code: method === "GET" ? "provider_response_invalid" : "outcome_unknown",
      operation: "polar.request.version",
      provider: "polar",
      connectionId: context.connection.id,
      providerCode: "api_version_mismatch",
      retryable: false,
    });
  return response;
}
