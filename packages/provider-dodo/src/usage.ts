import {
  object,
  stringField,
  type UsageProvider,
  type ProviderUsageEvent,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime, usageQuantity } from "@polybill/core";
import { dodoRequest } from "./client.js";
import { dodoResult } from "./result.js";

export const dodoUsage: UsageProvider = {
  async createMeter(context, meter) {
    const root = object(
      (
        await dodoRequest(context, "POST", "/meters", {
          name: meter.name,
          event_name: meter.eventName,
          measurement_unit: meter.unit,
          aggregation: {
            type: meter.aggregation,
            ...(meter.aggregation === "count" ? {} : { key: meter.valueProperty }),
          },
        })
      ).json(),
      "dodo",
      "usage.meter",
    );
    const aggregation = object(root.aggregation, "dodo", "usage.meter");
    if (
      root.event_name !== meter.eventName ||
      aggregation.type !== meter.aggregation ||
      (meter.aggregation === "sum" && aggregation.key !== meter.valueProperty)
    )
      throw invalid();
    return dodoResult(context, { externalId: stringField(root, "id", "dodo", "usage.meter") });
  },
  validateEvent: validate,
  async ingest(context, event) {
    validate(context, event);
    const root = object(
      (
        await dodoRequest(context, "POST", "/events/ingest", {
          events: [
            {
              event_id: event.externalId,
              customer_id: event.externalCustomerId,
              event_name: event.meter.eventName,
              timestamp: event.occurredAt,
              metadata: { [event.meter.valueProperty]: Number(event.quantity) },
            },
          ],
        })
      ).json(),
      "dodo",
      "usage.ingest",
    );
    if (root.ingested_count !== 1 && root.ingested_count !== 0) throw invalid();
    if (root.ingested_count === 0 && !(await find(context, event))) throw invalid();
  },
  findEvent: find,
};

async function find(context: ProviderContext, event: ProviderUsageEvent) {
  let value: unknown;
  try {
    value = (
      await dodoRequest(context, "GET", `/events/${encodeURIComponent(event.externalId)}`)
    ).json();
  } catch (error) {
    if (error instanceof PolybillError && error.code === "not_found") return false;
    throw error;
  }
  const root = object(value, "dodo", "usage.read");
  const metadata = object(root.metadata, "dodo", "usage.read");
  if (
    root.event_id !== event.externalId ||
    root.customer_id !== event.externalCustomerId ||
    root.event_name !== event.meter.eventName ||
    parseIsoDateTime(stringField(root, "timestamp", "dodo", "usage.read")) !==
      parseIsoDateTime(event.occurredAt) ||
    metadata[event.meter.valueProperty] !== Number(event.quantity)
  )
    throw invalid();
  return true;
}
function validate(context: ProviderContext, event: ProviderUsageEvent) {
  usageQuantity(event.quantity);
  parseIsoDateTime(event.occurredAt);
  const age = Date.parse(context.clock.now()) - Date.parse(event.occurredAt);
  if (!Number.isSafeInteger(Number(event.quantity)) || age > 3_600_000 || age < -300_000)
    throw new PolybillError(
      "Dodo usage requires safe-integer units within its one-hour ingestion window",
      { code: "invalid_request", operation: "usage.ingest", provider: "dodo", retryable: false },
    );
}
function invalid() {
  return new PolybillError("Dodo usage response does not match the requested event or meter", {
    code: "provider_response_invalid",
    operation: "usage.ingest",
    provider: "dodo",
    retryable: false,
  });
}
