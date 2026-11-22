import {
  nativeCapability,
  subscriptionCapabilityGaps,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";
import { WAFFO_API_VERSION } from "./client.js";
import { waffoPortalStore } from "./customers.js";

export function waffoCapabilities(context: ProviderContext): CapabilitySnapshot {
  const native = nativeCapability();
  return {
    provider: "waffo",
    adapterVersion: "0.1.0",
    providerApiVersion: WAFFO_API_VERSION,
    capabilities: {
      ...subscriptionCapabilityGaps(
        "Waffo merchant subscription lifecycle integration is not implemented; customer reactivation requires session authorization and canonical read-back bindings are not yet verified",
      ),
      "checkout.hosted": { ...native, constraints: { maxItems: 1, quantity: 1, cancelUrl: false } },
      "checkout.ad_hoc_price": unsupportedCapability(
        "Waffo price snapshots require a mapped product and its tax category",
      ),
      "checkout.discount": unsupportedCapability(
        "Waffo session creation does not return an authoritative discounted total",
      ),
      "checkout.multi_item": unsupportedCapability(
        "Waffo checkout sessions lock one product version",
      ),
      "payment.one_time": native,
      "customer.portal":
        waffoPortalStore(context) === undefined
          ? unsupportedCapability("Waffo customer portal requires a configured Pancake store ID")
          : { ...nativeCapability("pinned"), constraints: { returnUrl: false, mappedBuyer: true } },
      "webhook.verify": native,
      "license.issue": {
        support: "emulated",
        fidelity: "exact",
        strategy: "polybill_control_plane",
        environments: ["test", "live"],
        constraints: {},
        migration: "portable",
      },
      "subscription.change_items": unsupportedCapability(
        "Product change remains unverified and is not exposed",
      ),
      "migration.subscription": unsupportedCapability(
        "Waffo migration imports products and prices, not active subscriptions",
      ),
    },
    commercialTerms: {
      model: "merchant_of_record",
      sellerOfRecord: "provider",
      taxCalculation: "provider",
      taxInvoiceIssuer: "provider",
      disputeResponsibility: "provider",
      observedAt: context.clock.now(),
      evidenceRef: parseId<"EvidenceId">("evi_waffo_terms", "evi"),
    },
    observedAt: context.clock.now(),
  };
}
