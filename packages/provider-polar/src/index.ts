import type { ProviderAdapter } from "@polybill/adapter-kit";
import { polarCapabilities } from "./capabilities.js";
import { polarCheckout } from "./checkout.js";
import { polarCustomers } from "./customers.js";
import { polarSubscriptions } from "./subscriptions.js";
import { polarWebhooks } from "./webhooks.js";
import { polarMigration } from "./migration.js";

export function createPolarAdapter(): ProviderAdapter {
  return {
    descriptor: {
      name: "polar",
      displayName: "Polar",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => polarCapabilities(context),
    customers: polarCustomers,
    checkout: polarCheckout,
    subscriptions: polarSubscriptions,
    migration: polarMigration,
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
