import type {
  CommercialTermsSnapshot,
  Environment,
  IsoDateTime,
  ProviderName,
} from "@polybill/core";

export const capabilityKeys = [
  "catalog.product.read",
  "catalog.product.create",
  "catalog.product.update",
  "catalog.product.archive",
  "catalog.price.read",
  "catalog.price.create",
  "catalog.price.retire",
  "customer.read",
  "customer.create",
  "customer.update",
  "customer.delete",
  "customer.portal",
  "checkout.hosted",
  "checkout.embedded",
  "checkout.ad_hoc_price",
  "checkout.multi_item",
  "checkout.discount",
  "checkout.tax",
  "order.read",
  "order.list",
  "payment.one_time",
  "payment.asset_settlement",
  "refund.partial",
  "refund.full",
  "dispute.read",
  "subscription.create",
  "subscription.bind_checkout",
  "subscription.schedule",
  "subscription.read",
  "subscription.list",
  "subscription.change_items",
  "subscription.pause",
  "subscription.resume",
  "subscription.cancel",
  "subscription.clear_scheduled_change",
  "subscription.set_trial_end",
  "subscription.proration",
  "subscription.trial",
  "subscription.mandate",
  "discount.create",
  "discount.read",
  "discount.redeem",
  "license.issue",
  "license.validate",
  "license.activate",
  "license.deactivate",
  "license.revoke",
  "usage.meter",
  "usage.ingest",
  "usage.credit",
  "credit_wallet.read",
  "credit_wallet.create",
  "credit_wallet.grant",
  "credit_wallet.debit",
  "credit_wallet.reverse",
  "moderation.screen",
  "webhook.verify",
  "webhook.replay",
  "webhook.simulate",
  "migration.catalog",
  "migration.customer",
  "migration.subscription",
  "migration.payment_method",
  "commercial.merchant_of_record",
  "commercial.tax_calculation",
  "commercial.tax_invoice",
  "commercial.dispute_responsibility",
] as const;

export type CapabilityKey = (typeof capabilityKeys)[number];

/** Missing integrations remain visible to callers of getCapabilities(). */
export function subscriptionCapabilityGaps(
  reason: string,
): Readonly<Partial<Record<CapabilityKey, Capability>>> {
  return Object.fromEntries(
    capabilityKeys
      .filter((key) => key.startsWith("subscription.") || key.startsWith("usage."))
      .map((key) => [key, unsupportedCapability(reason)]),
  );
}
export type MigrationBehavior = "portable" | "recreate" | "reauthorize" | "pinned";

export interface CapabilityBase {
  readonly environments: readonly Environment[];
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly limits?: Readonly<Record<string, string | number | boolean>>;
  readonly migration: MigrationBehavior;
}

export type Capability =
  | (CapabilityBase & { readonly support: "native"; readonly fidelity: "exact" })
  | (CapabilityBase & {
      readonly support: "emulated";
      readonly fidelity: "exact" | "lossy" | "workflow";
      readonly strategy: string;
    })
  | (CapabilityBase & {
      readonly support: "unsupported";
      readonly reason: string;
      readonly alternatives?: readonly string[];
    });

export interface CapabilitySnapshot {
  readonly provider: ProviderName;
  readonly adapterVersion: string;
  readonly providerApiVersion: string;
  readonly capabilities: Readonly<Partial<Record<CapabilityKey, Capability>>>;
  readonly commercialTerms: CommercialTermsSnapshot;
  readonly observedAt: IsoDateTime;
  readonly expiresAt?: IsoDateTime;
}

export function unsupportedCapability(
  reason: string,
  alternatives?: readonly string[],
): Capability {
  return {
    support: "unsupported",
    reason,
    ...(alternatives === undefined ? {} : { alternatives }),
    environments: ["test", "live"],
    constraints: {},
    migration: "pinned",
  };
}

export function nativeCapability(
  migration: MigrationBehavior = "portable",
  environments: readonly Environment[] = ["test", "live"],
): Capability {
  return { support: "native", fidelity: "exact", migration, environments, constraints: {} };
}
