import {
  object,
  stringField,
  type UsageProvider,
  type ProviderContext,
  type ProviderUsageEvent,
} from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime, usageQuantity } from "@polybill/core";
import type { PolarRequest } from "./client.js";
import { polarResult } from "./result.js";

const eventMarker = "polybill_event_id";

export function createPolarUsage(request: PolarRequest): UsageProvider {
  const find = (context: ProviderContext, event: ProviderUsageEvent) =>
    findEvent(request, context, event);
  return {
    async createMeter(context, meter) {
      if (meter.valueProperty === eventMarker) throw reservedProperty();
      const root = object(
        (
          await request(context, "POST", "/v1/meters/", {
            name: meter.name,
            unit: "scalar",
            filter: {
              conjunction: "and",
              clauses: [{ property: "name", operator: "eq", value: meter.eventName }],
            },
            aggregation: {
              func: meter.aggregation,
              ...(meter.aggregation === "count" ? {} : { property: meter.valueProperty }),
            },
          })
        ).json(),
        "polar",
        "usage.meter",
      );
      const aggregation = object(root.aggregation, "polar", "usage.meter");
      if (
        aggregation.func !== meter.aggregation ||
        (meter.aggregation === "sum" && aggregation.property !== meter.valueProperty)
      )
        throw invalid();
      const filter = object(root.filter, "polar", "usage.meter");
      if (
        filter.conjunction !== "and" ||
        !Array.isArray(filter.clauses) ||
        filter.clauses.length !== 1
      )
        throw invalid();
      const clause = object(filter.clauses[0], "polar", "usage.meter");
      if (
        clause.property !== "name" ||
        clause.operator !== "eq" ||
        clause.value !== meter.eventName
      )
        throw invalid();
      return polarResult(context, { externalId: stringField(root, "id", "polar", "usage.meter") });
    },
    validateEvent(_context, event) {
      validate(event.quantity, event.occurredAt);
      if (event.meter.valueProperty === eventMarker) throw reservedProperty();
    },
    async ingest(context, event) {
      validate(event.quantity, event.occurredAt);
      if (event.meter.valueProperty === eventMarker) throw reservedProperty();
      const root = object(
        (
          await request(context, "POST", "/v1/events/ingest", {
            events: [
              {
                external_id: event.externalId,
                name: event.meter.eventName,
                customer_id: event.externalCustomerId,
                timestamp: event.occurredAt,
                metadata: {
                  [event.meter.valueProperty]: Number(event.quantity),
                  [eventMarker]: event.externalId,
                },
              },
            ],
          })
        ).json(),
        "polar",
        "usage.ingest",
      );
      const duplicates = root.duplicates ?? 0;
      if (root.inserted === 1 && duplicates === 0) return;
      if (root.inserted !== 0 || duplicates !== 1 || !(await find(context, event))) throw invalid();
    },
    findEvent: find,
  };
}

async function findEvent(
  request: PolarRequest,
  context: ProviderContext,
  event: ProviderUsageEvent,
): Promise<boolean> {
  validate(event.quantity, event.occurredAt);
  if (event.meter.valueProperty === eventMarker) throw reservedProperty();
  const query = new URLSearchParams({
    customer_id: event.externalCustomerId,
    name: event.meter.eventName,
    source: "user",
    [`metadata[${eventMarker}]`]: event.externalId,
    limit: "2",
  });
  const root = object(
    (await request(context, "GET", `/v1/events/?${query}`)).json(),
    "polar",
    "usage.read",
  );
  const pagination = object(root.pagination, "polar", "usage.read");
  if (!Array.isArray(root.items)) throw invalid();
  if (root.items.length === 0 && pagination.total_count === 0) return false;
  if (root.items.length !== 1 || pagination.total_count !== 1) throw invalid();
  const found = object(root.items[0], "polar", "usage.read");
  const metadata = object(found.metadata, "polar", "usage.read");
  if (
    found.source !== "user" ||
    found.customer_id !== event.externalCustomerId ||
    found.name !== event.meter.eventName ||
    parseIsoDateTime(stringField(found, "timestamp", "polar", "usage.read")) !==
      parseIsoDateTime(event.occurredAt) ||
    metadata[eventMarker] !== event.externalId ||
    metadata[event.meter.valueProperty] !== Number(event.quantity)
  )
    throw invalid();
  return true;
}
function reservedProperty() {
  return new PolybillError("Polar reserves polybill_event_id metadata for usage recovery", {
    code: "invalid_request",
    operation: "usage.meter",
    provider: "polar",
    retryable: false,
  });
}
function validate(quantity: string, occurredAt: string) {
  usageQuantity(quantity);
  parseIsoDateTime(occurredAt);
  if (!Number.isSafeInteger(Number(quantity)))
    throw new PolybillError("Polar numeric event metadata requires safe-integer usage units", {
      code: "invalid_request",
      operation: "usage.ingest",
      provider: "polar",
      retryable: false,
    });
}
function invalid() {
  return new PolybillError("Polar usage response does not match the requested event or meter", {
    code: "provider_response_invalid",
    operation: "usage.ingest",
    provider: "polar",
    retryable: false,
  });
}
