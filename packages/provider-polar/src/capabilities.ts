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
      "checkout.discount": unsupportedCapability(
        "Canonical discount redemption and net Order totals are not yet connected to Polar checkout",
        [
          "Use a provider-managed checkout code directly outside Polybill until discount support is enabled",
        ],
      ),
      "checkout.tax": native,
      "payment.one_time": native,
      "customer.read": native,
      "customer.create": { ...native, constraints: { requiresEmail: true } },
      "customer.update": native,
      "customer.delete": native,
      "customer.portal": native,
      "subscription.read": native,
      "subscription.cancel": native,
      "subscription.resume": native,
      "subscription.pause": unsupportedCapability(
        "Polar pause requires explicit period-end timing that is not present in the canonical pause command",
      ),
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
