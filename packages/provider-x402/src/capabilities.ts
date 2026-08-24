import {
  nativeCapability,
  unsupportedCapability,
  type CapabilitySnapshot,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";

export function x402Capabilities(context: ProviderContext): CapabilitySnapshot {
  const recurring = {
    support: "emulated",
    fidelity: "workflow",
    strategy: "customer_reauthorization_each_cycle",
    environments: ["test", "live"],
    constraints: { reusableMandate: false },
    migration: "reauthorize",
  } as const;
  return {
    provider: "x402",
    adapterVersion: "0.1.0",
    providerApiVersion: "x402-paysdk@0.1.0",
    capabilities: {
      "checkout.hosted": nativeCapability(),
      "checkout.multi_item": {
        support: "emulated",
        fidelity: "exact",
        strategy: "polybill_order_total",
        environments: ["test", "live"],
        constraints: { settlementAsset: "USDC" },
        migration: "portable",
      },
      "payment.one_time": nativeCapability(),
      "payment.asset_settlement": nativeCapability(),
      "subscription.create": recurring,
      "subscription.mandate": unsupportedCapability(
        "x402 v1 does not provide a reusable recurring payment mandate",
        ["customer_reauthorization_each_cycle"],
      ),
      "refund.partial": unsupportedCapability(
        "Refunds require a separately configured merchant signer and supported network",
      ),
      "refund.full": unsupportedCapability(
        "Refunds require a separately configured merchant signer and supported network",
      ),
      "webhook.verify": nativeCapability("pinned"),
      "commercial.merchant_of_record": unsupportedCapability(
        "x402 is a settlement network and does not become the merchant of record",
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
      model: "settlement_network",
      sellerOfRecord: "merchant",
      taxCalculation: "merchant",
      taxInvoiceIssuer: "merchant",
      disputeResponsibility: "merchant",
      observedAt: context.clock.now(),
      evidenceRef: parseId<"EvidenceId">("evi_x402_terms", "evi"),
    },
    observedAt: context.clock.now(),
  };
}
