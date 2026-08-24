import type { ProviderAdapter } from "@polybill/adapter-kit";
import { parseId, type ConnectionRef, type Environment, type ProviderName } from "@polybill/core";
import { createCreemAdapter } from "@polybill/provider-creem";
import { createDodoAdapter } from "@polybill/provider-dodo";
import { createLemonSqueezyAdapter } from "@polybill/provider-lemonsqueezy";
import { createPaddleAdapter } from "@polybill/provider-paddle";
import { createPolarAdapter } from "@polybill/provider-polar";
import { createStripeAdapter } from "@polybill/provider-stripe";
import { createWaffoAdapter } from "@polybill/provider-waffo";
import { createX402Adapter } from "@polybill/provider-x402";
import { D1X402NonceStore } from "@polybill/store-d1";
import { providerSlug } from "@polybill/webhooks";
import type { WorkerEnv } from "./bindings.js";

type ConfiguredProvider = Exclude<ProviderName, "fake">;
type ConfiguredConnection = ConnectionRef & { readonly provider: ConfiguredProvider };

export function connectionFromEnv(env: WorkerEnv): ConfiguredConnection {
  const tenantId = parseId<"TenantId">(env.POLYBILL_TENANT_ID, "ten");
  return {
    id: parseId<"ConnectionId">(env.POLYBILL_CONNECTION_ID, "conn"),
    tenantId,
    provider: provider(env.POLYBILL_PROVIDER),
    environment: environment(env.POLYBILL_ENVIRONMENT),
  };
}

export function configuredAdapters(env: WorkerEnv): ReadonlyMap<string, ProviderAdapter> {
  const connection = connectionFromEnv(env);
  return new Map([[providerSlug(connection.provider), adapterFor(env, connection)]]);
}

function adapterFor(env: WorkerEnv, connection: ConfiguredConnection): ProviderAdapter {
  switch (connection.provider) {
    case "stripe":
      return createStripeAdapter();
    case "dodo":
      return createDodoAdapter();
    case "polar":
      return createPolarAdapter();
    case "creem":
      return createCreemAdapter();
    case "waffo":
      return createWaffoAdapter();
    case "lemonSqueezy":
      return createLemonSqueezyAdapter();
    case "paddle":
      return createPaddleAdapter();
    case "x402":
      return createX402Adapter({
        gateway: required(env.POLYBILL_X402_GATEWAY, "POLYBILL_X402_GATEWAY"),
        payTo: required(env.POLYBILL_X402_PAY_TO, "POLYBILL_X402_PAY_TO"),
        network: required(env.POLYBILL_X402_NETWORK, "POLYBILL_X402_NETWORK"),
        settlement: {
          kind: "fixed",
          pricingCurrency: "USD",
          atomicPerMinor: required(
            env.POLYBILL_X402_ATOMIC_PER_MINOR,
            "POLYBILL_X402_ATOMIC_PER_MINOR",
          ),
          acceptPegRisk: true,
        },
        trustedReceiptSigners: [
          required(env.POLYBILL_X402_RECEIPT_SIGNER, "POLYBILL_X402_RECEIPT_SIGNER"),
        ],
        minConfirmations: 1,
        nonceStore: new D1X402NonceStore(env.POLYBILL_DB, {
          tenantId: connection.tenantId,
          connectionId: connection.id,
        }),
      });
  }
}

function provider(value: string): ConfiguredProvider {
  if (value === "lemon-squeezy" || value === "lemonSqueezy") return "lemonSqueezy";
  if (["stripe", "dodo", "polar", "creem", "waffo", "paddle", "x402"].includes(value))
    return value as Exclude<ConfiguredProvider, "lemonSqueezy">;
  throw new TypeError("POLYBILL_PROVIDER is invalid");
}

function environment(value: string): Environment {
  if (value !== "test" && value !== "live") throw new TypeError("POLYBILL_ENVIRONMENT is invalid");
  return value;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}
