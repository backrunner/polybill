import {
  nativeCapability,
  subscriptionCapabilityGaps,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";
import { POLAR_API_VERSION, type PolarApiVersion } from "./api-version.js";

export function polarCapabilities(
  context: ProviderContext,
  apiVersion: PolarApiVersion = POLAR_API_VERSION,
): CapabilitySnapshot {
  const native = nativeCapability();
  return {
    provider: "polar",
    adapterVersion: "0.1.0",
    providerApiVersion: apiVersion,
    capabilities: {
      ...subscriptionCapabilityGaps(
        "This operation is not implemented by the Polybill adapter; it is not a statement that the provider lacks this feature",
      ),
      "checkout.hosted": native,
      "checkout.multi_item": unsupportedCapability(
        "Polar products are alternatives selected by the customer, not a multi-item cart",
      ),
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
      "subscription.create": unsupportedCapability(
        "Polar creates subscriptions through checkout sessions after customer authorization; no standalone create operation can satisfy the canonical synchronous subscription command",
        ["Create a checkout session for the mapped recurring product"],
      ),
      "subscription.read": native,
      "subscription.bind_checkout": native,
      "usage.meter": native,
      "usage.ingest": {
        ...native,
        constraints: {
          maximumQuantity: Number.MAX_SAFE_INTEGER,
          invoiceFinality: false,
          automaticUnknownRetry: false,
          unknownOutcomeRecovery: "scoped_event_metadata_readback",
          reservedMetadataProperty: "polybill_event_id",
        },
      },
      "subscription.cancel": native,
      "subscription.resume": native,
      "subscription.pause": {
        ...native,
        constraints: {
          timing: ["period_end"],
          invoiceBehavior: ["stop_billing"],
          automaticResume: true,
        },
      },
      "subscription.change_items": {
        ...native,
        constraints: {
          maxItems: 1,
          simultaneousProductAndQuantity: false,
          policies: [
            "immediately:prorate_next_invoice",
            "immediately:prorate_immediately",
            "period_end:none",
          ],
        },
      },
      "subscription.proration": native,
      "subscription.clear_scheduled_change": {
        ...native,
        constraints: { kinds: ["cancel", "pause", "items"] },
      },
      "subscription.set_trial_end": native,
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
