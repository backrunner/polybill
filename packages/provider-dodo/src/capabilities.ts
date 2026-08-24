import {
  nativeCapability,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";
import { DODO_API_VERSION } from "./client.js";

export function dodoCapabilities(context: ProviderContext): CapabilitySnapshot {
  const native = nativeCapability();
  return {
    provider: "dodo",
    adapterVersion: "0.1.0",
    providerApiVersion: DODO_API_VERSION,
    capabilities: {
      "checkout.hosted": native,
      "checkout.ad_hoc_price": {
        ...native,
        constraints: { requiresPayWhatYouWantProduct: true, oneTimeOnly: true },
      },
      "checkout.multi_item": native,
      "checkout.discount": native,
      "checkout.tax": native,
      "payment.one_time": native,
      "customer.read": native,
      "customer.create": { ...native, constraints: { requiresEmail: true, requiresName: true } },
      "customer.update": native,
      "customer.portal": native,
      "subscription.read": native,
      "subscription.cancel": native,
      "subscription.pause": {
        ...native,
        constraints: { timing: ["immediately"], invoiceBehavior: ["stop_billing"] },
      },
      "subscription.resume": native,
      "refund.full": native,
      "refund.partial": unsupportedCapability(
        "Dodo partial refunds require provider item IDs that are not present in the canonical amount-only command",
      ),
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
        "Only provider-assisted card-token migrations are available; wallet tokens are not portable",
      ),
    },
    commercialTerms: {
      model: "merchant_of_record",
      sellerOfRecord: "provider",
      taxCalculation: "provider",
      taxInvoiceIssuer: "provider",
      disputeResponsibility: "provider",
      observedAt: context.clock.now(),
      evidenceRef: parseId<"EvidenceId">("evi_dodo_terms", "evi"),
    },
    observedAt: context.clock.now(),
  };
}
