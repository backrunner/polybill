import type { ProviderAdapter } from "@polybill/adapter-kit";
import { stripeCapabilities } from "./capabilities.js";
import { stripeCatalog } from "./catalog.js";
import { stripeCheckout } from "./checkout.js";
import { stripeCustomers } from "./customers.js";
import { stripeRefunds } from "./refunds.js";
import { stripeMigration } from "./migration.js";
import { stripeSubscriptions } from "./subscriptions.js";
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
    catalog: stripeCatalog,
    customers: stripeCustomers,
    checkout: stripeCheckout,
    subscriptions: stripeSubscriptions,
    refunds: stripeRefunds,
    migration: stripeMigration,
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
