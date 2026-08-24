import type { ProviderAdapter } from "@polybill/adapter-kit";
import { stripeCapabilities } from "./capabilities.js";
import { stripeCheckout } from "./checkout.js";
import { stripeWebhooks } from "./webhooks.js";

export function createStripeAdapter(): ProviderAdapter {
  return {
    descriptor: {
      name: "stripe",
      displayName: "Stripe Payments and Billing",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => stripeCapabilities(context),
    checkout: stripeCheckout,
    webhooks: stripeWebhooks,
    reconcile: {
      async checkout(context, externalId) {
        const result = await stripeCheckout.get(context, externalId);
        return result.value.status === "unknown"
          ? [
              {
                kind: "unknown_remote_state",
                externalId,
                details: { rawStatus: result.value.rawStatus },
              },
            ]
          : [];
      },
    },
  };
}

export { STRIPE_API_VERSION } from "./client.js";
