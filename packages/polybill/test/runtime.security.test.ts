import {
  createFakeProvider,
  DeterministicIds,
  silentLogger,
  VirtualClock,
} from "@polybill/testing";
import { money, parseId, parseIdempotencyKey, type Price } from "@polybill/core";
import { createMemoryStore } from "@polybill/store-memory";
import { describe, expect, it } from "vitest";
import { createPolybill, createWebSecretCrypto } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_security01", "ten");
const connectionId = parseId<"ConnectionId">("conn_security01", "conn");
const price: Price = {
  id: parseId<"PriceId">("price_security01", "price"),
  skuId: parseId<"SkuId">("sku_security01", "sku"),
  version: 1,
  model: { kind: "one_time", unit: money("1200", "USD") },
  taxBehavior: "exclusive",
  status: "active",
  metadata: {},
};

describe("Polybill runtime security", () => {
  it("rejects unsafe checkout redirects before provider transport", async () => {
    let fetchCalls = 0;
    let providerCreates = 0;
    const store = createMemoryStore();
    store.seedPrice(tenantId, price);
    const fake = createFakeProvider();
    if (fake.checkout === undefined) throw new Error("Fake provider checkout port is missing");
    const checkout = fake.checkout;
    const client = createPolybill({
      tenantId,
      connection: {
        id: connectionId,
        tenantId,
        provider: "fake",
        environment: "test",
      },
      credentials: { apiKey: "test" },
      adapter: {
        ...fake,
        checkout: {
          ...checkout,
          async create(context, command) {
            providerCreates += 1;
            return checkout.create(context, command);
          },
        },
      },
      store,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("transport must not be called");
      },
      clock: new VirtualClock("2026-08-25T00:00:00.000Z"),
      ids: new DeterministicIds(),
      logger: silentLogger,
    });

    const unsafeUrls = [
      "http://merchant.example/success",
      "https://user:password@merchant.example/success",
      "not a url",
    ] as const;
    for (const [index, unsafeUrl] of unsafeUrls.entries()) {
      await expect(
        client.checkouts.create({
          idempotencyKey: parseIdempotencyKey(`security-redirect-${index}`),
          items: [{ priceId: price.id, quantity: 1 }],
          successUrl: unsafeUrl,
          cancelUrl: "https://merchant.example/cancel",
        }),
      ).rejects.toMatchObject({ code: "invalid_request", operation: "checkout.create" });
    }
    expect(fetchCalls).toBe(0);
    expect(providerCreates).toBe(0);
  });

  it("isolates external mappings by tenant and connection", async () => {
    const store = createMemoryStore();
    const otherTenant = parseId<"TenantId">("ten_security02", "ten");
    const otherConnection = parseId<"ConnectionId">("conn_security02", "conn");
    store.seedMapping(tenantId, connectionId, "customer", "cust_local", "cus_remote");

    await expect(
      store.getExternalId(tenantId, connectionId, "customer", "cust_local"),
    ).resolves.toBe("cus_remote");
    await expect(
      store.getExternalId(otherTenant, connectionId, "customer", "cust_local"),
    ).resolves.toBeUndefined();
    await expect(
      store.getExternalId(tenantId, otherConnection, "customer", "cust_local"),
    ).resolves.toBeUndefined();
    await expect(
      store.findCanonicalId(tenantId, otherConnection, "customer", "cus_remote"),
    ).resolves.toBeUndefined();
  });

  it("authenticates encrypted license material with AAD and never exposes plaintext", async () => {
    const secret = "PB1-SECRET-LICENSE-MATERIAL";
    const crypto = createWebSecretCrypto({
      digestKey: new Uint8Array(32).fill(21),
      activeEncryptionKeyId: "key-1",
      encryptionKeys: { "key-1": new Uint8Array(32).fill(22) },
    });
    const envelope = await crypto.encrypt(secret, "tenant-a:license-a:v1");
    expect(envelope).not.toContain(secret);
    await expect(crypto.decrypt(envelope, "tenant-a:license-a:v1")).resolves.toBe(secret);

    const wrongAad = await capture(crypto.decrypt(envelope, "tenant-b:license-a:v1"));
    const tamperedEnvelope = `${envelope.slice(0, -2)}${envelope.endsWith("00") ? "01" : "00"}`;
    const tampered = await capture(crypto.decrypt(tamperedEnvelope, "tenant-a:license-a:v1"));
    expect(`${String(wrongAad)} ${JSON.stringify(wrongAad)}`).not.toContain(secret);
    expect(`${String(tampered)} ${JSON.stringify(tampered)}`).not.toContain(secret);
  });
});

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
