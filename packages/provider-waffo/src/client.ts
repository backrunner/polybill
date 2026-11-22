import {
  assertCredentialEnvironment,
  createHttpTransport,
  providerIdempotencyKey,
  sha256Base64,
  signRsaSha256,
  utf8,
  type HttpResponse,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";

export const WAFFO_API_VERSION = "v1-pancake-ts-0.28.0";

export async function waffoRequest(
  context: ProviderContext,
  path: string,
  body: unknown,
): Promise<HttpResponse> {
  assertCredentialEnvironment(context, "waffo.authenticate");
  const merchantId = context.credentials.merchantId;
  const privateKey = context.credentials.privateKey;
  if (merchantId === undefined || privateKey === undefined)
    throw new PolybillError("Waffo merchant ID or private key is missing", {
      code: "authentication_failed",
      operation: "waffo.authenticate",
      provider: "waffo",
      connectionId: context.connection.id,
      retryable: false,
    });
  const serialized = JSON.stringify(body);
  const timestamp = Math.floor(Date.parse(context.clock.now()) / 1000).toString();
  const bodyHash = await sha256Base64(utf8(serialized));
  const signature = await signRsaSha256(
    privateKey,
    utf8(`POST\n${path}\n${timestamp}\n${bodyHash}`),
  );
  const key = await providerIdempotencyKey(context, "POST", path);
  const response = await createHttpTransport({
    fetch: context.fetch,
    provider: "waffo",
    deadline: context.deadline,
    clock: context.clock,
  }).send({
    url: `https://api.waffo.ai${path}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Merchant-Id": merchantId,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
      ...(key === undefined
        ? {}
        : {
            "X-Idempotency-Key": key,
          }),
    },
    body: serialized,
  });
  if (response.status >= 400)
    throw new PolybillError("Waffo Pancake rejected the request", {
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
      operation: "waffo.request",
      provider: "waffo",
      connectionId: context.connection.id,
      retryable: response.status === 429 || response.status >= 500,
    });
  return response;
}
