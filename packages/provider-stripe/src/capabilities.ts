import {
  nativeCapability,
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
      "checkout.hosted": native,
      "checkout.ad_hoc_price": native,
      "checkout.multi_item": native,
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
        },
      },
      "subscription.resume": native,
      "subscription.cancel": native,
      "subscription.trial": unsupportedCapability(
        "Canonical intervals need an explicit conversion policy before using Stripe trial_period_days",
      ),
      "refund.partial": native,
      "refund.full": native,
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
