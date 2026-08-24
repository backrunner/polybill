import {
  nativeCapability,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";
import { LEMON_API_VERSION } from "./client.js";

export function lemonCapabilities(context: ProviderContext): CapabilitySnapshot {
  const native = nativeCapability();
  return {
    provider: "lemonSqueezy",
    adapterVersion: "0.1.0",
    providerApiVersion: LEMON_API_VERSION,
    capabilities: {
      "checkout.hosted": { ...native, constraints: { maxItems: 1, quantity: 1, cancelUrl: false } },
      "checkout.ad_hoc_price": native,
      "checkout.multi_item": unsupportedCapability("A Lemon Squeezy checkout targets one variant"),
      "payment.one_time": native,
      "webhook.verify": native,
      "license.issue": {
        support: "emulated",
        fidelity: "exact",
        strategy: "polybill_control_plane_with_optional_native_mirror",
        environments: ["test", "live"],
        constraints: {},
        migration: "portable",
      },
      "migration.payment_method": unsupportedCapability(
        "Saved payment credentials are not generically portable",
      ),
    },
    commercialTerms: {
      model: "merchant_of_record",
      sellerOfRecord: "provider",
      taxCalculation: "provider",
      taxInvoiceIssuer: "provider",
      disputeResponsibility: "provider",
      observedAt: context.clock.now(),
      evidenceRef: parseId<"EvidenceId">("evi_lemon_terms", "evi"),
    },
    observedAt: context.clock.now(),
  };
}
