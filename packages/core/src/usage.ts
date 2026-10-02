import { parseId, type CustomerId, type MeterId, type UsageEventId } from "./ids.js";
import type { IsoDateTime } from "./time.js";
import { parseIsoDateTime } from "./time.js";
import { usageQuantity } from "./billing-rate.js";

export interface UsageMeter {
  readonly id: MeterId;
  readonly name: string;
  readonly eventName: string;
  readonly unit: string;
  readonly aggregation: "sum" | "count";
  readonly valueProperty: string;
}
export interface UsageEvent {
  readonly id: UsageEventId;
  readonly meterId: MeterId;
  readonly customerId: CustomerId;
  readonly quantity: string;
  readonly occurredAt: IsoDateTime;
}
export interface UsageReceipt {
  readonly event: UsageEvent;
  readonly status: "accepted" | "outcome_unknown";
}

export function parseUsageMeter(value: unknown): UsageMeter {
  const input = record(value);
  const name = text(input.name);
  const eventName = text(input.eventName);
  const unit = text(input.unit);
  const valueProperty = text(input.valueProperty);
  const aggregation = input.aggregation;
  if (
    name.length < 3 ||
    name.length > 100 ||
    !/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(eventName) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(unit) ||
    !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(valueProperty) ||
    valueProperty === "stripe_customer_id" ||
    (aggregation !== "sum" && aggregation !== "count")
  )
    throw new TypeError("Invalid usage meter");
  return {
    id: parseId<"MeterId">(input.id, "meter"),
    name,
    eventName,
    unit,
    valueProperty,
    aggregation,
  };
}

export function parseUsageEvent(value: unknown): UsageEvent {
  const input = record(value);
  return {
    id: parseId<"UsageEventId">(input.id, "usage"),
    meterId: parseId<"MeterId">(input.meterId, "meter"),
    customerId: parseId<"CustomerId">(input.customerId, "cust"),
    quantity: usageQuantity(text(input.quantity)),
    occurredAt: parseIsoDateTime(text(input.occurredAt)),
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid usage data");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Invalid usage field");
  return value;
}
