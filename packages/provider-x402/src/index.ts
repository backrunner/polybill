import type { ProviderAdapter } from "@polybill/adapter-kit";
import { createX402Checkout } from "./checkout.js";
import { x402Capabilities } from "./capabilities.js";
import { assertX402Options, type X402AdapterOptions } from "./config.js";
import { createX402Webhooks } from "./webhooks.js";

export function createX402Adapter(options: X402AdapterOptions): ProviderAdapter {
  assertX402Options(options);
  const checkout = createX402Checkout(options);
  return {
    descriptor: {
      name: "x402",
      displayName: "x402",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => x402Capabilities(context),
    checkout,
    webhooks: createX402Webhooks(options),
    reconcile: {
      async checkout(context, externalId) {
        const snapshot = await checkout.get(context, externalId);
        return snapshot.value.status === "unknown"
          ? [
              {
                kind: "unknown_remote_state",
                externalId,
                details: { rawStatus: snapshot.value.rawStatus },
              },
            ]
          : [];
      },
    },
  };
}

export type { X402AdapterOptions } from "./config.js";
export {
  verifyX402Settlement,
  type ExpectedX402Settlement,
  type X402SettlementResult,
} from "./settlement.js";
