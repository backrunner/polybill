import type { ProviderAdapter } from "@polybill/adapter-kit";
import { paddleCapabilities } from "./capabilities.js";
import { paddleCheckout } from "./checkout.js";
import { paddleWebhooks } from "./webhooks.js";

export function createPaddleAdapter(): ProviderAdapter {
  return {
    descriptor: {
      name: "paddle",
      displayName: "Paddle Billing",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => paddleCapabilities(context),
    checkout: paddleCheckout,
    webhooks: paddleWebhooks,
    reconcile: {
      async checkout(context, externalId) {
        const snapshot = await paddleCheckout.get(context, externalId);
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

export { PADDLE_API_VERSION } from "./client.js";
