import type { ProviderCheckoutCommand } from "@polybill/adapter-kit";
import {
  PolybillError,
  multiplyMoney,
  parseId,
  quoteDiscount,
  type ConnectionRef,
  type Discount,
  type DiscountId,
  type DiscountRedemptionId,
  type IdempotencyKey,
  type Money,
} from "@polybill/core";
import type { CheckoutServiceOptions } from "./checkout.js";

export interface PreparedDiscount {
  readonly discount: Discount;
  readonly reservationId: DiscountRedemptionId;
  readonly externalDiscountId: string;
  readonly amount: Money;
  readonly net: Money;
}

export async function prepareCheckoutDiscount(
  options: CheckoutServiceOptions,
  command: {
    readonly idempotencyKey: IdempotencyKey;
    readonly discountId: DiscountId;
    readonly customerId?: string;
  },
  lines: ProviderCheckoutCommand["lines"],
  payloadHash: string,
): Promise<PreparedDiscount> {
  const discount = await options.store.getDiscount(options.tenantId, command.discountId);
  if (discount === undefined)
    throw new PolybillError("Discount was not found", {
      code: "not_found",
      operation: "checkout.resolve_discount",
      retryable: false,
    });
  const externalDiscountId = await options.store.getExternalId(
    options.tenantId,
    options.connection.id,
    "discount",
    discount.id,
  );
  if (externalDiscountId === undefined)
    throw unsupported(options.connection, "Discount has no mapping for the selected connection");

  const quoteInput = {
    lines: lines.map((line) => ({
      skuId: line.skuId,
      subtotal: multiplyMoney(line.unitAmount, line.quantity),
    })),
    ...(command.customerId === undefined ? {} : { customerRef: command.customerId }),
    now: options.clock.now(),
  };
  const preflight = quoteDiscount(discount, {
    ...quoteInput,
    redemptionCount: 0,
    customerRedemptionCount: 0,
  });
  if (preflight.kind === "rejected") throw rejected(preflight.reason);

  const reserved = await options.store.reserveDiscount({
    tenantId: options.tenantId,
    connectionId: options.connection.id,
    reservationId: parseId<"DiscountRedemptionId">(options.ids.next("dred"), "dred"),
    discountId: discount.id,
    idempotencyKey: command.idempotencyKey,
    payloadHash,
    ...(command.customerId === undefined ? {} : { customerRef: command.customerId }),
    ...(discount.maxRedemptions === undefined ? {} : { maxRedemptions: discount.maxRedemptions }),
    ...(discount.maxRedemptionsPerCustomer === undefined
      ? {}
      : { maxRedemptionsPerCustomer: discount.maxRedemptionsPerCustomer }),
    reservedAt: options.clock.now(),
  });
  if (reserved.kind === "not_found")
    throw new PolybillError("Discount was not found", {
      code: "not_found",
      operation: "checkout.reserve_discount",
      retryable: false,
    });
  if (reserved.kind === "conflict")
    throw new PolybillError("Discount reservation idempotency conflict", {
      code: "idempotency_conflict",
      operation: "checkout.reserve_discount",
      retryable: false,
    });
  if (reserved.kind === "inactive") throw rejected("inactive");
  if (reserved.kind === "limit_reached") throw rejected("redemption_limit_reached");

  const quote = quoteDiscount(discount, {
    ...quoteInput,
    redemptionCount: reserved.reservation.redemptionCountBefore,
    customerRedemptionCount: reserved.reservation.customerRedemptionCountBefore,
  });
  if (quote.kind === "rejected") {
    await options.store.releaseDiscountReservation(options.tenantId, reserved.reservation.id);
    throw rejected(quote.reason);
  }
  return {
    discount,
    reservationId: reserved.reservation.id,
    externalDiscountId,
    amount: quote.discountAmount,
    net: quote.net,
  };
}

function unsupported(connection: ConnectionRef, reason: string): PolybillError {
  return new PolybillError(reason, {
    code: "unsupported_capability",
    operation: "checkout.create",
    provider: connection.provider,
    connectionId: connection.id,
    retryable: false,
  });
}

function rejected(reason: string): PolybillError {
  return new PolybillError(`Discount cannot be applied: ${reason}`, {
    code: "invalid_request",
    operation: "checkout.apply_discount",
    retryable: false,
  });
}
