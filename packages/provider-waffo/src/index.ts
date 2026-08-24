import type { ProviderAdapter } from "@polybill/adapter-kit";
import { waffoCapabilities } from "./capabilities.js";
import { waffoCheckout } from "./checkout.js";
import { waffoWebhooks } from "./webhooks.js";

export function createWaffoAdapter(): ProviderAdapter {
  return {
    descriptor: {
      name: "waffo",
      displayName: "Waffo Pancake",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => waffoCapabilities(context),
    checkout: waffoCheckout,
    webhooks: waffoWebhooks,
    reconcile: {
      checkout: async (_context, externalId) => [
        {
          kind: "unknown_remote_state",
          externalId,
          details: {
            reason:
              "Checkout sessions have no documented read-back endpoint; reconcile the resulting order through GraphQL",
          },
        },
      ],
    },
  };
}

export { WAFFO_API_VERSION } from "./client.js";
