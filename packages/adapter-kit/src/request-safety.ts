import { parseIdempotencyKey, PolybillError } from "@polybill/core";
import type { ProviderContext } from "./context.js";

export async function providerIdempotencyKey(
  context: ProviderContext,
  method: string,
  path: string,
): Promise<string | undefined> {
  if (context.idempotencyKey === undefined || method === "GET") return undefined;
  const source = JSON.stringify([
    "polybill:v1",
    context.tenantId,
    context.connection.id,
    context.connection.environment,
    context.connection.provider,
    method,
    path,
    context.idempotencyKey,
  ]);
  return parseIdempotencyKey(`pb_${await context.crypto.sha256(new TextEncoder().encode(source))}`);
}

export function providerIntegerAmount(
  amount: string,
  provider: ProviderContext["connection"]["provider"],
  maximum = Number.MAX_SAFE_INTEGER,
  minimum = 0,
): number {
  if (
    !/^(0|[1-9][0-9]*)$/.test(amount) ||
    BigInt(amount) > BigInt(maximum) ||
    BigInt(amount) < BigInt(minimum)
  )
    throw new PolybillError("Amount is outside the provider's supported integer range", {
      code: "invalid_request",
      operation: "checkout.encode_amount",
      provider,
      retryable: false,
    });
  return Number(amount);
}

export function providerNumericIdentifier(
  value: string,
  provider: ProviderContext["connection"]["provider"],
): number {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new PolybillError("Provider identifier is not a safe integer", {
      code: "provider_response_invalid",
      operation: "checkout.encode_identifier",
      provider,
      retryable: false,
    });
  return Number(value);
}
