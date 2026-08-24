import type { ProviderAdapter } from "@polybill/adapter-kit";
import { creemCapabilities } from "./capabilities.js";
import { creemCheckout } from "./checkout.js";
import { creemCustomers } from "./customers.js";
import { creemMigration } from "./migration.js";
import { creemSubscriptions } from "./subscriptions.js";
import { creemWebhooks } from "./webhooks.js";

export function createCreemAdapter(): ProviderAdapter {
  return {
    descriptor: {
      name: "creem",
      displayName: "Creem",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => creemCapabilities(context),
    customers: creemCustomers,
    checkout: creemCheckout,
    subscriptions: creemSubscriptions,
    migration: creemMigration,
    webhooks: creemWebhooks,
    reconcile: {
      async checkout(context, externalId) {
        const snapshot = await creemCheckout.get(context, externalId);
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

export { CREEM_API_VERSION } from "./client.js";
