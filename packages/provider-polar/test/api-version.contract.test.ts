import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createWebCryptoPort, type ProviderContext } from "@polybill/adapter-kit";
import { money, parseId, parseIdempotencyKey, parseIsoDateTime } from "@polybill/core";
import { createScriptedFetch, VirtualClock } from "@polybill/testing";
import { describe, expect, it, vi } from "vitest";
import { createPolarAdapter, POLAR_API_VERSION, POLAR_API_VERSIONS } from "../src/index.js";
import { polarRequest } from "../src/client.js";

const methods = ["GET", "POST", "PATCH", "DELETE"] as const;
const pinnedHeaders = { "Polar-Version": "2026-10" };

describe("Polar API date contract", () => {
  it.each(POLAR_API_VERSIONS)(
    "pins an isolated adapter to reviewed version %s",
    async (version) => {
      const scripted = createScriptedFetch([
        {
          method: "GET",
          url: "https://sandbox-api.polar.sh/v1/customers/customer_fixture",
          response: Response.json(
            { id: "customer_fixture", email: "test@example.com", name: null, deleted_at: null },
            { headers: { "Polar-Version": version } },
          ),
        },
      ]);
      const adapter = createPolarAdapter({ apiVersion: version });
      expect(await adapter.getCapabilities(context(scripted.fetch))).toMatchObject({
        providerApiVersion: version,
      });
      await adapter.customers?.get?.(context(scripted.fetch), "customer_fixture");
      expect(scripted.requests[0]?.headers.get("Polar-Version")).toBe(version);
      expect(await createPolarAdapter().getCapabilities(context(scripted.fetch))).toMatchObject({
        providerApiVersion: "2026-10",
      });
      const baseline: unknown = JSON.parse(
        readFileSync(
          new URL(
            `../fixtures/api-contract${version === "2026-10" ? "" : `-${version}`}.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(baseline).toMatchObject({ apiVersion: version });
      scripted.assertConsumed();
    },
  );
  it("keeps the public version, capability and reviewed fixture baseline aligned", async () => {
    const baseline: unknown = JSON.parse(
      readFileSync(new URL("../fixtures/api-contract.json", import.meta.url), "utf8"),
    );
    expect(POLAR_API_VERSION).toBe("2026-10");
    expect(baseline).toMatchObject({ apiVersion: POLAR_API_VERSION });
    expect(
      await createPolarAdapter().getCapabilities(context(createScriptedFetch([]).fetch)),
    ).toMatchObject({ providerApiVersion: POLAR_API_VERSION });
  });

  it.each(["test", "live"] as const)("pins all HTTP methods in %s", async (environment) => {
    const host = environment === "test" ? "sandbox-api.polar.sh" : "api.polar.sh";
    const scripted = createScriptedFetch(
      methods.map((method) => ({
        method,
        url: `https://${host}/v1/customers/customer_fixture`,
        response: new Response(null, { status: 204, headers: pinnedHeaders }),
      })),
    );
    const ctx = context(scripted.fetch, environment);
    for (const method of methods) await polarRequest(ctx, method, "/v1/customers/customer_fixture");
    for (const request of scripted.requests) {
      expect(request.headers.get("polar-version")).toBe("2026-10");
      expect(request.headers.get("authorization")).toBe("Bearer polar_version_fixture");
    }
    scripted.assertConsumed();
  });

  it.each([undefined, "2026-04", "2027-01", "current", "2026-10-01"])(
    "rejects response version %s and preserves unknown mutation outcomes without fallback",
    async (version) => {
      for (const method of methods) {
        const scripted = createScriptedFetch([
          {
            method,
            url: "https://sandbox-api.polar.sh/v1/customers/customer_fixture",
            response: Response.json(
              { id: "customer_fixture" },
              { headers: version === undefined ? {} : { "Polar-Version": version } },
            ),
          },
        ]);
        await expect(
          polarRequest(context(scripted.fetch), method, "/v1/customers/customer_fixture"),
        ).rejects.toMatchObject({
          code: method === "GET" ? "provider_response_invalid" : "outcome_unknown",
          provider: "polar",
          operation: "polar.request.version",
          providerCode: "api_version_mismatch",
          retryable: false,
        });
        expect(scripted.requests).toHaveLength(1);
        scripted.assertConsumed();
      }
    },
  );

  it.each([
    [401, "authentication_failed"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
  ] as const)(
    "preserves HTTP %s errors and never negotiates another version",
    async (status, code) => {
      const scripted = createScriptedFetch([
        {
          method: "POST",
          url: "https://sandbox-api.polar.sh/v1/customers/",
          response: new Response(null, { status }),
        },
      ]);
      await expect(
        polarRequest(context(scripted.fetch), "POST", "/v1/customers/", {}),
      ).rejects.toMatchObject({ code, operation: "polar.request" });
      expect(scripted.requests).toHaveLength(1);
      scripted.assertConsumed();
    },
  );

  it("uses the same pin for checkout creation, read-back and reconciliation", async () => {
    const snapshot = { id: "checkout_fixture", status: "open", url: "https://polar.sh/checkout" };
    const scripted = createScriptedFetch(
      [
        { method: "POST", url: "https://sandbox-api.polar.sh/v1/checkouts/" },
        { method: "GET", url: "https://sandbox-api.polar.sh/v1/checkouts/checkout_fixture" },
        { method: "GET", url: "https://sandbox-api.polar.sh/v1/checkouts/checkout_fixture" },
      ].map((step) => ({ ...step, response: Response.json(snapshot, { headers: pinnedHeaders }) })),
    );
    const adapter = createPolarAdapter();
    if (adapter.checkout === undefined) throw new Error("Missing checkout port");
    const ctx = context(scripted.fetch);
    await adapter.checkout.create(ctx, {
      orderId: parseId<"OrderId">("ord_polarversion", "ord"),
      lines: [
        {
          skuId: parseId<"SkuId">("sku_polarversion", "sku"),
          quantity: 1,
          price: { kind: "one_time", unit: money("1000", "USD") },
          unitAmount: money("1000", "USD"),
          externalPriceId: "product_fixture",
        },
      ],
      grossTotal: money("1000", "USD"),
      total: money("1000", "USD"),
      successUrl: "https://merchant.example/ok",
      cancelUrl: "https://merchant.example/cancel",
      metadata: {},
    });
    await expect(adapter.checkout.get(ctx, snapshot.id)).resolves.toMatchObject({
      value: { status: "open" },
    });
    await expect(adapter.reconcile.checkout(ctx, snapshot.id)).resolves.toEqual([]);
    for (const request of scripted.requests)
      expect(request.headers.get("Polar-Version")).toBe("2026-10");
    scripted.assertConsumed();
  });
});

describe("Polar signed webhook API dates", () => {
  it.each([undefined, "2026-04", "2026-10", "2027-01"])(
    "maps reviewed or historical payload %s",
    async (version) => {
      const decoded = await decodeSigned({
        type: "subscription.canceled",
        ...(version === undefined ? {} : { api_version: version }),
        data: { id: "subscription_fixture", status: "active", cancel_at_period_end: true },
      });
      const lookup = vi.fn(async () => "sub_canonical");
      const ctx = context(createScriptedFetch([]).fetch);
      const events = await createPolarAdapter().webhooks.map(decoded, {
        ...ctx,
        observedAt: ctx.clock.now(),
        lookup: { findCanonicalId: lookup },
      });
      expect(events).toMatchObject([{ type: "subscription.changed.v1" }]);
      expect(lookup).toHaveBeenCalledOnce();
    },
  );

  it.each(["2099-01", "2026-10-01", "", null, 202610, {}])(
    "retains unreviewed version %j without resource decoding or mapping",
    async (version) => {
      const root = { api_version: version, type: "order.paid", data: { id: "order_fixture" } };
      const decoded = await decodeSigned(root);
      const lookup = vi.fn(async () => "ord_canonical");
      const ctx = context(createScriptedFetch([]).fetch);
      const events = await createPolarAdapter().webhooks.map(decoded, {
        ...ctx,
        observedAt: ctx.clock.now(),
        lookup: { findCanonicalId: lookup },
      });
      expect(events).toMatchObject([{ type: "unmapped_provider_event.v1" }]);
      expect(decoded.payload).toEqual(root);
      expect(decoded.externalIds.object).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
      await expect(decodeSigned({ ...root, data: null })).resolves.toMatchObject({
        payload: { data: null },
      });
    },
  );

  it("requires a valid signature before a version can affect decoding", async () => {
    const adapter = createPolarAdapter();
    await expect(
      adapter.webhooks.verify({
        rawBody: new TextEncoder().encode('{"api_version":"2099-01","type":"order.paid"}'),
        headers: new Headers({
          "webhook-id": "msg_version",
          "webhook-timestamp": "1790899200",
          "webhook-signature": "v1,aW52YWxpZA==",
        }),
        secret: { active: "polar-version-fixture-secret", activeKeyId: "fixture" },
        environment: "test",
        now: parseIsoDateTime("2026-10-02T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });
});

async function decodeSigned(root: unknown) {
  const rawBody = new TextEncoder().encode(JSON.stringify(root));
  const secret = "polar-version-fixture-secret";
  const signature = createHmac("sha256", secret)
    .update("msg_version.1790899200.")
    .update(rawBody)
    .digest("base64");
  const adapter = createPolarAdapter();
  const verified = await adapter.webhooks.verify({
    rawBody,
    headers: new Headers({
      "webhook-id": "msg_version",
      "webhook-timestamp": "1790899200",
      "webhook-signature": `v1,${signature}`,
      // This unsigned header must never override the authenticated body version.
      "webhook-api-version": "2026-10",
    }),
    secret: { active: secret, activeKeyId: "fixture" },
    environment: "test",
    now: parseIsoDateTime("2026-10-02T00:00:00.000Z"),
  });
  return adapter.webhooks.decode(verified);
}

function context(
  fetch: typeof globalThis.fetch,
  environment: "test" | "live" = "test",
): ProviderContext {
  const tenantId = parseId<"TenantId">("ten_polarversion", "ten");
  return {
    tenantId,
    connection: {
      id: parseId<"ConnectionId">("conn_polarversion", "conn"),
      tenantId,
      provider: "polar",
      environment,
    },
    credentials: { accessToken: "polar_version_fixture" },
    requestId: parseId<"RequestId">("req_polarversion", "req"),
    idempotencyKey: parseIdempotencyKey("polar-version-fixture"),
    deadline: parseIsoDateTime("2026-10-02T00:01:00.000Z"),
    fetch,
    crypto: createWebCryptoPort(),
    clock: new VirtualClock("2026-10-02T00:00:00.000Z"),
  };
}
