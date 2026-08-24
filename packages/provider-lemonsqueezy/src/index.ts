import type { ProviderAdapter } from "@polybill/adapter-kit";
import { lemonCapabilities } from "./capabilities.js";
import { lemonCheckout } from "./checkout.js";
import { lemonWebhooks } from "./webhooks.js";

export function createLemonSqueezyAdapter(): ProviderAdapter {
  return {
    descriptor: {
      name: "lemonSqueezy",
      displayName: "Lemon Squeezy",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => lemonCapabilities(context),
    checkout: lemonCheckout,
    webhooks: lemonWebhooks,
    reconcile: {
      async checkout(context, externalId) {
        const snapshot = await lemonCheckout.get(context, externalId);
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

export { LEMON_API_VERSION } from "./client.js";
