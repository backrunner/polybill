import {
  nativeCapability,
  subscriptionCapabilityGaps,
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
      ...subscriptionCapabilityGaps(
        "This operation is not implemented by the Polybill adapter; it is not a statement that the provider lacks this feature",
      ),
      "checkout.hosted": native,
      "checkout.ad_hoc_price": {
        ...native,
        constraints: { requiresPayWhatYouWantProduct: true, oneTimeOnly: true },
      },
      "checkout.multi_item": native,
      "checkout.discount": unsupportedCapability(
        "Canonical discount redemption and net Order totals are not yet connected to Dodo checkout",
        [
          "Use a provider-managed checkout code directly outside Polybill until discount support is enabled",
        ],
      ),
      "checkout.tax": native,
      "payment.one_time": native,
      "customer.read": native,
      "customer.create": { ...native, constraints: { requiresEmail: true, requiresName: true } },
      "customer.update": native,
      "customer.portal": native,
      "subscription.create": unsupportedCapability(
        "Dodo's standalone subscription endpoint is deprecated and requires billing address data that is not part of the canonical subscription command; checkout-created subscriptions are not a synchronous subscription mutation",
        ["Create a hosted checkout for the mapped recurring product"],
      ),
      "subscription.read": native,
      "subscription.bind_checkout": native,
      "usage.meter": native,
      "usage.ingest": {
        ...native,
        constraints: {
          timestampWindowSeconds: 3600,
          maximumQuantity: Number.MAX_SAFE_INTEGER,
          authoritativeEventReadback: true,
          invoiceFinality: false,
        },
      },
      "subscription.change_items": {
        ...native,
        constraints: {
          maxItems: 1,
          policies: ["immediately:none", "immediately:prorate_immediately", "period_end:none"],
          onPaymentFailure: "prevent_change",
          preservesAddons: true,
        },
      },
      "subscription.proration": {
        ...native,
        constraints: { proration: ["none", "prorate_immediately"] },
      },
      "subscription.clear_scheduled_change": {
        ...native,
        constraints: { kinds: ["cancel", "items"] },
      },
      "subscription.set_trial_end": unsupportedCapability(
        "Dodo subscription update has no trial-end mutation; configure the trial at checkout",
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
