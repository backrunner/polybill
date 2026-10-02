import {
  object,
  stringField,
  type UsageProvider,
  type ProviderContext,
  type ProviderUsageEvent,
} from "@polybill/adapter-kit";
import { PolybillError, parseIsoDateTime, usageQuantity } from "@polybill/core";
import { stripeRequest } from "./client.js";
import { stripeResult } from "./result.js";

export const stripeUsage: UsageProvider = {
  async createMeter(context, meter) {
    const body = new URLSearchParams({
      display_name: meter.name,
      event_name: meter.eventName,
      "default_aggregation[formula]": meter.aggregation,
      "customer_mapping[type]": "by_id",
      "customer_mapping[event_payload_key]": "stripe_customer_id",
      "value_settings[event_payload_key]": meter.valueProperty,
    });
    const root = object(
      (await stripeRequest(context, "POST", "/v1/billing/meters", body)).json(),
      "stripe",
      "usage.meter",
    );
    const aggregation = object(root.default_aggregation, "stripe", "usage.meter");
    const customer = object(root.customer_mapping, "stripe", "usage.meter");
    const value = object(root.value_settings, "stripe", "usage.meter");
    if (
      root.event_name !== meter.eventName ||
      aggregation.formula !== meter.aggregation ||
      customer.type !== "by_id" ||
      customer.event_payload_key !== "stripe_customer_id" ||
      value.event_payload_key !== meter.valueProperty
    )
      throw invalid();
    return stripeResult(context, { externalId: stringField(root, "id", "stripe", "usage.meter") });
  },
  validateEvent: validate,
  async ingest(context, event) {
    validate(context, event);
    const timestamp = String(Math.floor(Date.parse(event.occurredAt) / 1000));
    const body = new URLSearchParams({
      event_name: event.meter.eventName,
      identifier: event.externalId,
      "payload[stripe_customer_id]": event.externalCustomerId,
      [`payload[${event.meter.valueProperty}]`]: event.quantity,
      timestamp,
    });
    const root = object(
      (await stripeRequest(context, "POST", "/v1/billing/meter_events", body)).json(),
      "stripe",
      "usage.ingest",
    );
    const payload = object(root.payload, "stripe", "usage.ingest");
    if (
      root.identifier !== event.externalId ||
      root.event_name !== event.meter.eventName ||
      payload.stripe_customer_id !== event.externalCustomerId ||
      payload[event.meter.valueProperty] !== event.quantity ||
      String(root.timestamp) !== timestamp
    )
      throw invalid();
  },
};
function validate(context: ProviderContext, event: ProviderUsageEvent) {
  usageQuantity(event.quantity);
  parseIsoDateTime(event.occurredAt);
  const age = Date.parse(context.clock.now()) - Date.parse(event.occurredAt);
  if (age > 35 * 86400_000 || age < -300_000)
    throw new PolybillError("Stripe meter event is outside the 35-day ingestion window", {
      code: "invalid_request",
      operation: "usage.ingest",
      provider: "stripe",
      retryable: false,
    });
}
function invalid() {
  return new PolybillError("Stripe usage response does not match the requested event or meter", {
    code: "provider_response_invalid",
    operation: "usage.ingest",
    provider: "stripe",
    retryable: false,
  });
}
