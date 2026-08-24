import type { ProviderAdapter } from "@polybill/adapter-kit";
import { polarCapabilities } from "./capabilities.js";
import { polarCheckout } from "./checkout.js";
import { polarWebhooks } from "./webhooks.js";

export function createPolarAdapter(): ProviderAdapter {
  return {
    descriptor: {
      name: "polar",
      displayName: "Polar",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => polarCapabilities(context),
    checkout: polarCheckout,
    webhooks: polarWebhooks,
    reconcile: {
      async checkout(context, externalId) {
        const snapshot = await polarCheckout.get(context, externalId);
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

export { POLAR_API_VERSION } from "./client.js";
