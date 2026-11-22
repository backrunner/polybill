import type { ProviderAdapter } from "@polybill/adapter-kit";
import { polarCapabilities } from "./capabilities.js";
import { createPolarCheckout } from "./checkout.js";
import { createPolarCustomers } from "./customers.js";
import { createPolarSubscriptions } from "./subscriptions.js";
import { polarWebhooks } from "./webhooks.js";
import { createPolarMigration } from "./migration.js";
import { createPolarUsage } from "./usage.js";
import { createPolarRequest } from "./client.js";
import { POLAR_API_VERSION, type PolarApiVersion } from "./api-version.js";

export interface PolarAdapterOptions {
  readonly apiVersion?: PolarApiVersion;
}

export function createPolarAdapter(options: PolarAdapterOptions = {}): ProviderAdapter {
  const apiVersion = options.apiVersion ?? POLAR_API_VERSION;
  const request = createPolarRequest(apiVersion);
  const checkout = createPolarCheckout(request);
  return {
    descriptor: {
      name: "polar",
      displayName: "Polar",
      adapterVersion: "0.1.0",
      maturity: "experimental",
    },
    getCapabilities: async (context) => polarCapabilities(context, apiVersion),
    customers: createPolarCustomers(request),
    checkout,
    subscriptions: createPolarSubscriptions(request, apiVersion),
    migration: createPolarMigration(request),
    usage: createPolarUsage(request),
    webhooks: polarWebhooks,
    reconcile: {
      async checkout(context, externalId) {
        const snapshot = await checkout.get(context, externalId);
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

export { POLAR_API_VERSION, POLAR_API_VERSIONS, type PolarApiVersion } from "./api-version.js";
