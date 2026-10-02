import {
  arrayField,
  assertSubscriptionIdentity,
  object,
  stringField,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import { stripeRequest } from "./client.js";

export async function completeStripeSubscription(
  context: ProviderContext,
  value: unknown,
  expectedId?: string,
): Promise<Readonly<Record<string, unknown>>> {
  const operation = "stripe.subscription.items";
  const root = object(value, "stripe", operation);
  const id = stringField(root, "id", "stripe", operation);
  if (expectedId !== undefined) assertSubscriptionIdentity(id, expectedId, "stripe");
  let page = object(root.items, "stripe", operation);
  const items: unknown[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < 10; index += 1) {
    const entries = arrayField(page, "data", "stripe", operation);
    for (const entry of entries) {
      const item = object(entry, "stripe", operation);
      const itemId = stringField(item, "id", "stripe", operation);
      if (seen.has(itemId)) throw invalid();
      if (item.subscription !== undefined || index > 0)
        assertSubscriptionIdentity(item.subscription, id, "stripe");
      seen.add(itemId);
      items.push(item);
    }
    if (page.has_more === false || (index === 0 && page.has_more === undefined))
      return { ...root, items: { ...page, data: items, has_more: false } };
    if (page.has_more !== true || entries.length === 0 || index === 9) throw invalid();
    const last = object(entries.at(-1), "stripe", operation);
    const query = new URLSearchParams({
      subscription: id,
      limit: "100",
      starting_after: stringField(last, "id", "stripe", operation),
    });
    page = object(
      (await stripeRequest(context, "GET", `/v1/subscription_items?${query}`)).json(),
      "stripe",
      operation,
    );
  }
  throw invalid();
}

function invalid(): PolybillError {
  return new PolybillError("Invalid or incomplete subscription item pagination", {
    code: "provider_response_invalid",
    operation: "stripe.subscription.items",
    provider: "stripe",
    retryable: false,
  });
}
