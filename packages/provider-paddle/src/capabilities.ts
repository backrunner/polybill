import {
  nativeCapability,
  subscriptionCapabilityGaps,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";
import { PADDLE_API_VERSION } from "./client.js";

export function paddleCapabilities(context: ProviderContext): CapabilitySnapshot {
  const native = nativeCapability();
  return {
    provider: "paddle",
    adapterVersion: "0.1.0",
    providerApiVersion: PADDLE_API_VERSION,
    capabilities: {
      ...subscriptionCapabilityGaps(
        "This operation is not implemented by the Polybill adapter; it is not a statement that the provider lacks this feature",
      ),
      "checkout.hosted": {
        ...native,
        constraints: { redirectConfiguration: "application_or_paddle_js" },
      },
      "checkout.ad_hoc_price": native,
      "checkout.multi_item": native,
      "checkout.tax": native,
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
      "subscription.create": unsupportedCapability(
        "Paddle Billing creates subscriptions as part of a paid transaction; no standalone create endpoint can satisfy the canonical synchronous subscription command",
        ["Create a transaction or hosted checkout for the mapped recurring prices"],
      ),
      "subscription.read": native,
      "subscription.bind_checkout": native,
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
          timing: ["immediately", "period_end"],
          invoiceBehavior: ["stop_billing"],
          automaticResume: true,
        },
      },
      "subscription.resume": {
        ...native,
        constraints: {
          onResume: "start_new_billing_period",
          billingPeriod: ["continue_current", "restart"],
          continueRequiresUnexpiredPeriod: true,
        },
      },
      "subscription.cancel": native,
      "subscription.clear_scheduled_change": {
        ...native,
        constraints: { kinds: ["cancel", "pause"] },
      },
      "subscription.set_trial_end": {
        ...native,
        constraints: {
          status: ["trialing"],
          minimumFutureMinutes: 30,
          immediateActivation: "automatic_collection_only",
        },
      },
      "refund.partial": unsupportedCapability(
        "Paddle partial refunds require historical adjustment allocation; Polybill cannot safely derive remaining line-item balance from a transaction read alone",
        ["Use refund.full or reconcile provider adjustments before issuing a partial refund"],
      ),
      "refund.full": native,
      "webhook.verify": native,
      "license.issue": {
        support: "emulated",
        fidelity: "exact",
        strategy: "polybill_control_plane",
        environments: ["test", "live"],
        constraints: {},
        migration: "portable",
      },
      "migration.payment_method": unsupportedCapability(
        "Paddle Billing does not expose generic saved-card portability",
      ),
    },
    commercialTerms: {
      model: "merchant_of_record",
      sellerOfRecord: "provider",
      taxCalculation: "provider",
      taxInvoiceIssuer: "provider",
      disputeResponsibility: "provider",
      observedAt: context.clock.now(),
      evidenceRef: parseId<"EvidenceId">("evi_paddle_terms", "evi"),
    },
    observedAt: context.clock.now(),
  };
}
