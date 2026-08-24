import {
  nativeCapability,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";
import { CREEM_API_VERSION } from "./client.js";

export function creemCapabilities(context: ProviderContext): CapabilitySnapshot {
  const native = nativeCapability();
  return {
    provider: "creem",
    adapterVersion: "0.1.0",
    providerApiVersion: CREEM_API_VERSION,
    capabilities: {
      "checkout.hosted": { ...native, constraints: { maxItems: 1, cancelUrl: false } },
      "checkout.ad_hoc_price": {
        ...native,
        constraints: { oneTimeOnly: true, minimumMinorUnits: "100" },
      },
      "checkout.multi_item": unsupportedCapability(
        "Creem Checkout accepts one product per session",
      ),
      "payment.one_time": native,
      "customer.read": native,
      "customer.create": { ...native, constraints: { requiresEmail: true, requiresName: true } },
      "customer.update": { ...native, constraints: { emailImmutable: true } },
      "customer.portal": native,
      "subscription.read": native,
      "subscription.cancel": native,
      "subscription.pause": native,
      "subscription.resume": native,
      "webhook.verify": native,
      "license.issue": {
        support: "emulated",
        fidelity: "exact",
        strategy: "polybill_control_plane_with_optional_native_mirror",
        environments: ["test", "live"],
        constraints: {},
        migration: "portable",
      },
      "migration.subscription": unsupportedCapability(
        "Creem catalog migration does not migrate active subscriptions",
      ),
    },
    commercialTerms: {
      model: "merchant_of_record",
      sellerOfRecord: "provider",
      taxCalculation: "provider",
      taxInvoiceIssuer: "provider",
      disputeResponsibility: "provider",
      observedAt: context.clock.now(),
      evidenceRef: parseId<"EvidenceId">("evi_creem_terms", "evi"),
    },
    observedAt: context.clock.now(),
  };
}
