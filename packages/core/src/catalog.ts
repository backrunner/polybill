import type { EntitlementPolicyId, PriceId, ProductId, SkuId } from "./ids.js";
import type { Currency, Money } from "./money.js";

export type Metadata = Readonly<Record<string, string>>;
export type BillingInterval = Readonly<{ unit: "day" | "week" | "month" | "year"; count: number }>;

export interface Product {
  readonly id: ProductId;
  readonly name: string;
  readonly description?: string;
  readonly media: readonly string[];
  readonly taxCategory?: string;
  readonly metadata: Metadata;
  readonly status: "active" | "archived";
  readonly version: number;
}

export interface Sku {
  readonly id: SkuId;
  readonly productId: ProductId;
  readonly key: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly fulfillment: "digital" | "service";
  readonly taxCategory?: string;
  readonly entitlementPolicyIds: readonly EntitlementPolicyId[];
  readonly status: "active" | "archived";
  readonly version: number;
}

export interface MeteredTier {
  readonly upTo?: string;
  readonly unit: Money;
  readonly flat?: Money;
}

export type PriceModel =
  | { readonly kind: "one_time"; readonly unit: Money }
  | { readonly kind: "recurring"; readonly unit: Money; readonly interval: BillingInterval }
  | { readonly kind: "seat"; readonly unit: Money; readonly interval: BillingInterval }
  | {
      readonly kind: "metered";
      readonly meterId: string;
      readonly interval: BillingInterval;
      readonly tiers: readonly MeteredTier[];
    }
  | { readonly kind: "custom"; readonly minimum?: Money; readonly suggested?: Money }
  | { readonly kind: "free"; readonly currency: Currency };

export interface Price {
  readonly id: PriceId;
  readonly skuId: SkuId;
  readonly version: number;
  readonly model: PriceModel;
  readonly taxBehavior: "inclusive" | "exclusive" | "unspecified";
  readonly status: "active" | "retired";
  readonly metadata: Metadata;
}

export type CheckoutPricing =
  | { readonly kind: "catalog"; readonly priceId: PriceId }
  | {
      readonly kind: "ad_hoc";
      readonly price: PriceModel;
      readonly persistence: "session" | "reusable";
    };

export function validateBillingInterval(interval: BillingInterval): BillingInterval {
  if (!Number.isSafeInteger(interval.count) || interval.count < 1) {
    throw new RangeError("Billing interval count must be a positive safe integer");
  }
  return interval;
}
