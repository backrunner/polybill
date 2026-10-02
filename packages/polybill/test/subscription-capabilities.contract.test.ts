import {
  capabilityKeys,
  type CapabilityKey,
  type SubscriptionProvider,
} from "@polybill/adapter-kit";
import { createScriptedFetch } from "@polybill/testing";
import { parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createPolarAdapter } from "../../provider-polar/src/index.js";
import { createDodoAdapter } from "../../provider-dodo/src/index.js";
import { createCreemAdapter } from "../../provider-creem/src/index.js";
import { createPaddleAdapter } from "../../provider-paddle/src/index.js";
import { createStripeAdapter } from "../../provider-stripe/src/index.js";
import { createLemonSqueezyAdapter } from "../../provider-lemonsqueezy/src/index.js";
import { createWaffoAdapter } from "../../provider-waffo/src/index.js";
import { createX402Adapter } from "../../provider-x402/src/index.js";
import { subscriptionContext, later } from "./subscription-fixtures.js";

const adapters = [
  createPolarAdapter(),
  createDodoAdapter(),
  createCreemAdapter(),
  createPaddleAdapter(),
  createStripeAdapter(),
  createLemonSqueezyAdapter(),
  createWaffoAdapter(),
  createX402Adapter({
    gateway: "https://pay.example",
    payTo: "0x1111111111111111111111111111111111111111",
    network: "eip155:8453",
    settlement: {
      kind: "fixed",
      pricingCurrency: "USD",
      atomicPerMinor: "10000",
      acceptPegRisk: true,
    },
    trustedReceiptSigners: ["fixture"],
    minConfirmations: 1,
    nonceStore: {
      putIfAbsent() {
        throw new Error("Capability inspection must not use receipt state");
      },
    },
  }),
];
const operations: readonly [CapabilityKey, keyof SubscriptionProvider][] = [
  ["subscription.create", "create"],
  ["subscription.read", "get"],
  ["subscription.change_items", "changeItems"],
  ["subscription.pause", "pause"],
  ["subscription.resume", "resume"],
  ["subscription.cancel", "cancel"],
  ["subscription.clear_scheduled_change", "clearScheduledChange"],
  ["subscription.set_trial_end", "setTrialEnd"],
];

describe("subscription capability completeness", () => {
  for (const adapter of adapters)
    it(`${adapter.descriptor.name} reports implemented operations and explicit gaps`, async () => {
      const scripted = createScriptedFetch([]);
      const snapshot = await adapter.getCapabilities(
        subscriptionContext(adapter.descriptor.name, scripted.fetch),
      );
      for (const key of capabilityKeys.filter(
        (key) => key.startsWith("subscription.") || key.startsWith("usage."),
      ))
        expect(snapshot.capabilities[key], key).toBeDefined();
      for (const [key, port] of operations) {
        if (snapshot.capabilities[key]?.support === "native")
          expect(adapter.subscriptions?.[port], key).toBeTypeOf("function");
        if (adapter.subscriptions?.[port] !== undefined)
          expect(snapshot.capabilities[key]?.support, key).toBe("native");
      }
      scripted.assertConsumed();
    });

  it("rejects unsupported timing, invoice handling and automatic resume without a remote request", async () => {
    for (const adapter of [createDodoAdapter(), createCreemAdapter()]) {
      const scripted = createScriptedFetch([]);
      await expect(
        adapter.subscriptions?.pause?.(
          subscriptionContext(adapter.descriptor.name, scripted.fetch),
          "sub_fixture",
          {
            timing: "immediately",
            invoiceBehavior: "stop_billing",
            resumesAt: parseIsoDateTime(later),
          },
        ),
      ).rejects.toMatchObject({ code: "unsupported_capability" });
      scripted.assertConsumed();
    }
    for (const adapter of [
      createStripeAdapter(),
      createPaddleAdapter(),
      createLemonSqueezyAdapter(),
      createCreemAdapter(),
    ]) {
      const scripted = createScriptedFetch([]);
      await expect(
        adapter.subscriptions?.changeItems?.(
          subscriptionContext(adapter.descriptor.name, scripted.fetch),
          "sub_fixture",
          {
            items: [{ externalPriceId: "21", quantity: 1 }],
            policy: { timing: "period_end", proration: "none" },
          },
        ),
      ).rejects.toMatchObject({ code: "unsupported_capability" });
      scripted.assertConsumed();
    }
  });
});
