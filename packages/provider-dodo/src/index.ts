import type { ProviderAdapter } from "@polybill/adapter-kit";
import { dodoCapabilities } from "./capabilities.js";
import { dodoCheckout } from "./checkout.js";
import { dodoCustomers } from "./customers.js";
import { dodoRefunds } from "./refunds.js";
import { dodoSubscriptions } from "./subscriptions.js";
import { dodoWebhooks } from "./webhooks.js";
import { dodoMigration } from "./migration.js";
import { dodoUsage } from "./usage.js";

export function createDodoAdapter(): ProviderAdapter {
  return {
    descriptor: {
      name: "dodo",
      displayName: "Dodo Payments",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => dodoCapabilities(context),
    customers: dodoCustomers,
    checkout: dodoCheckout,
    subscriptions: dodoSubscriptions,
    refunds: dodoRefunds,
    migration: dodoMigration,
    usage: dodoUsage,
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
