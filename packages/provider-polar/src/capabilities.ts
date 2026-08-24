import {
  nativeCapability,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";
import { POLAR_API_VERSION } from "./client.js";

export function polarCapabilities(context: ProviderContext): CapabilitySnapshot {
  const native = nativeCapability();
  return {
    provider: "polar",
    adapterVersion: "0.1.0",
    providerApiVersion: POLAR_API_VERSION,
    capabilities: {
      "checkout.hosted": native,
      "checkout.multi_item": {
        ...native,
        constraints: { quantity: "one_per_product_except_seats" },
      },
      "checkout.discount": native,
      "checkout.tax": native,
      "payment.one_time": native,
      "webhook.verify": native,
      "license.issue": {
        support: "emulated",
        fidelity: "exact",
        strategy: "polybill_control_plane_with_optional_benefit_mirror",
        environments: ["test", "live"],
        constraints: {},
        migration: "portable",
      },
      "migration.payment_method": unsupportedCapability(
        "Polar migration does not provide a generic target-provider token export",
      ),
    },
    commercialTerms: {
      model: "merchant_of_record",
      sellerOfRecord: "provider",
      taxCalculation: "provider",
      taxInvoiceIssuer: "provider",
      disputeResponsibility: "provider",
      observedAt: context.clock.now(),
      evidenceRef: parseId<"EvidenceId">("evi_polar_terms", "evi"),
    },
    observedAt: context.clock.now(),
  };
}
