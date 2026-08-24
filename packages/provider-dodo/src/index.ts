import type { ProviderAdapter } from "@polybill/adapter-kit";
import { dodoCapabilities } from "./capabilities.js";
import { dodoCheckout } from "./checkout.js";
import { dodoWebhooks } from "./webhooks.js";

export function createDodoAdapter(): ProviderAdapter {
  return {
    descriptor: {
      name: "dodo",
      displayName: "Dodo Payments",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => dodoCapabilities(context),
    checkout: dodoCheckout,
    webhooks: dodoWebhooks,
    reconcile: {
      async checkout(context, externalId) {
        const snapshot = await dodoCheckout.get(context, externalId);
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

export { DODO_API_VERSION } from "./client.js";
