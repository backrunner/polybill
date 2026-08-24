import type { ProviderAdapter } from "@polybill/adapter-kit";
import { parseId, type ConnectionRef, type ProviderName } from "@polybill/core";
import { createCreemAdapter } from "@polybill/provider-creem";
import { createDodoAdapter } from "@polybill/provider-dodo";
import { createLemonSqueezyAdapter } from "@polybill/provider-lemonsqueezy";
import { createPaddleAdapter } from "@polybill/provider-paddle";
import { createPolarAdapter } from "@polybill/provider-polar";
import { createStripeAdapter } from "@polybill/provider-stripe";
import { createWaffoAdapter } from "@polybill/provider-waffo";
import { createX402Adapter } from "@polybill/provider-x402";

type ConfiguredProvider = Exclude<ProviderName, "fake">;

export interface NodeConfig {
  readonly port: number;
  readonly connection: ConnectionRef & { readonly provider: ConfiguredProvider };
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly adapter: ProviderAdapter;
}

export function nodeConfig(env: NodeJS.ProcessEnv): NodeConfig {
  const tenantId = parseId<"TenantId">(env.POLYBILL_TENANT_ID ?? "ten_nodeexample", "ten");
  const provider = providerName(env.POLYBILL_PROVIDER ?? "stripe");
  const port = Number(env.PORT ?? "8788");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new TypeError("PORT is invalid");
  return {
    port,
    connection: {
      id: parseId<"ConnectionId">(env.POLYBILL_CONNECTION_ID ?? "conn_nodeexample", "conn"),
      tenantId,
      provider,
      environment: env.POLYBILL_ENVIRONMENT === "live" ? "live" : "test",
    },
    apiKey: env.POLYBILL_API_KEY ?? "replace-me",
    webhookSecret: env.POLYBILL_WEBHOOK_SECRET ?? "replace-me",
    adapter: adapter(provider, env),
  };
}

function adapter(provider: ConfiguredProvider, env: NodeJS.ProcessEnv): ProviderAdapter {
  switch (provider) {
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
        nonceStore: memoryNonceStore(),
      });
  }
}

function providerName(value: string): ConfiguredProvider {
  if (value === "lemon-squeezy" || value === "lemonSqueezy") return "lemonSqueezy";
  if (["stripe", "dodo", "polar", "creem", "waffo", "paddle", "x402"].includes(value))
    return value as Exclude<ConfiguredProvider, "lemonSqueezy">;
  throw new TypeError("POLYBILL_PROVIDER is invalid");
}

function memoryNonceStore() {
  const values = new Map<string, number>();
  return {
    async putIfAbsent(key: string, expiresAtSeconds: number): Promise<boolean> {
      const now = Math.floor(Date.now() / 1000);
      const current = values.get(key);
      if (current !== undefined && current > now) return false;
      values.set(key, expiresAtSeconds);
      return true;
    },
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}
