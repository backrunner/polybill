import {
  nativeCapability,
  subscriptionCapabilityGaps,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";
import { STRIPE_API_VERSION } from "./client.js";

export function stripeCapabilities(context: ProviderContext): CapabilitySnapshot {
  const native = nativeCapability();
  return {
    provider: "stripe",
    adapterVersion: "0.1.0",
    providerApiVersion: STRIPE_API_VERSION,
    capabilities: {
      ...subscriptionCapabilityGaps(
        "This operation is not implemented by the Polybill adapter; it is not a statement that the provider lacks this feature",
      ),
      "checkout.hosted": native,
      "checkout.ad_hoc_price": native,
      "checkout.multi_item": native,
      "checkout.discount": native,
      "payment.one_time": native,
      "catalog.product.read": native,
      "catalog.product.create": native,
      "catalog.product.update": native,
      "catalog.product.archive": native,
      "catalog.price.read": native,
      "catalog.price.create": native,
      "catalog.price.retire": native,
      "customer.read": native,
      "customer.create": native,
      "customer.update": native,
      "customer.delete": native,
      "customer.portal": native,
      "subscription.create": native,
      "subscription.read": native,
      "subscription.bind_checkout": native,
      "usage.meter": native,
      "usage.ingest": {
        ...native,
        constraints: {
          timestampWindowDays: 35,
          invoiceFinality: false,
          automaticUnknownRetry: false,
        },
      },
      "subscription.change_items": {
        ...native,
        constraints: {
          timing: ["immediately"],
          proration: ["none", "prorate_next_invoice", "prorate_immediately"],
        },
      },
      "subscription.proration": native,
      "subscription.pause": {
        ...native,
        constraints: {
          timing: ["immediately"],
          invoiceBehavior: ["void", "keep_draft", "mark_uncollectible"],
          automaticResume: true,
        },
      },
      "subscription.resume": native,
      "subscription.cancel": native,
      "subscription.trial": {
        ...native,
        constraints: { units: ["day", "week"], maximumDays: 730 },
      },
      "subscription.clear_scheduled_change": { ...native, constraints: { kinds: ["cancel"] } },
      "subscription.set_trial_end": native,
      "refund.partial": native,
      "refund.full": native,
      "discount.create": {
        ...native,
        constraints: {
          unsupported: ["startsAt", "eligibleCustomerRefs", "maxRedemptionsPerCustomer"],
        },
      },
      "discount.read": native,
      "discount.redeem": native,
      "webhook.verify": native,
      "commercial.merchant_of_record": unsupportedCapability(
        "Base Stripe Payments is a payment processor, not a merchant of record",
      ),
      "migration.payment_method": unsupportedCapability(
        "Payment method portability requires a provider-assisted workflow",
      ),
      "license.issue": {
        support: "emulated",
        fidelity: "exact",
        strategy: "polybill_control_plane",
        environments: ["test", "live"],
        constraints: {},
        migration: "portable",
      },
    },
    commercialTerms: {
      model: "payment_processor",
      sellerOfRecord: "merchant",
      taxCalculation: "merchant",
      taxInvoiceIssuer: "merchant",
      disputeResponsibility: "merchant",
      observedAt: context.clock.now(),
      evidenceRef: parseId<"EvidenceId">("evi_stripe_terms", "evi"),
    },
    observedAt: context.clock.now(),
  };
}
