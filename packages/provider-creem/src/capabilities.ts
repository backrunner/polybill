import {
  nativeCapability,
  subscriptionCapabilityGaps,
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
      ...subscriptionCapabilityGaps(
        "This operation is not implemented by the Polybill adapter; it is not a statement that the provider lacks this feature",
      ),
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
      "subscription.create": unsupportedCapability(
        "Creem creates subscriptions as the result of a checkout; its public subscription API exposes lifecycle operations but no standalone create mutation",
        ["Create a hosted checkout for the mapped recurring product"],
      ),
      "subscription.read": native,
      "subscription.bind_checkout": native,
      "subscription.change_items": {
        ...native,
        constraints: {
          timing: ["immediately"],
          maxItems: 1,
          priceReference: "product_id",
          simultaneousProductAndQuantity: false,
          proration: ["none", "prorate_next_invoice", "prorate_immediately"],
        },
      },
      "subscription.proration": native,
      "subscription.clear_scheduled_change": { ...native, constraints: { kinds: ["cancel"] } },
      "subscription.set_trial_end": unsupportedCapability(
        "Creem trial duration is configured on the product; no trial-end mutation is exposed",
      ),
      "subscription.cancel": native,
      "subscription.pause": {
        ...native,
        constraints: {
          timing: ["immediately"],
          invoiceBehavior: ["stop_billing"],
          automaticResume: false,
        },
      },
      "subscription.resume": native,
      "refund.full": unsupportedCapability(
        "Creem refund creation does not return a canonical refund ID, amount, and currency for safe read-back",
      ),
      "refund.partial": unsupportedCapability("Creem public refund API only supports full refunds"),
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
