import { hmacSha256, utf8 } from "@polybill/adapter-kit";
import { parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createLemonSqueezyAdapter } from "../src/index.js";

describe("Lemon Squeezy webhook contract", () => {
  it("uses raw HMAC and a deterministic digest delivery key", async () => {
    const body =
      '{"meta":{"event_name":"order_created"},"data":{"id":"order_fixture","attributes":{"created_at":"2026-08-25T00:00:00.000Z"}}}';
    const secret = "lemon-webhook-secret";
    const signature = hex(await hmacSha256(secret, utf8(body)));
    const adapter = createLemonSqueezyAdapter();
    const input = {
      rawBody: utf8(body),
      headers: new Headers({ "x-signature": signature }),
      secret: { active: secret, activeKeyId: "key-current" },
      environment: "test" as const,
      now: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
    };
    const first = await adapter.webhooks.verify(input);
    const second = await adapter.webhooks.verify(input);
    expect(first.deliveryKey).toMatch(/^lemonSqueezy:[0-9a-f]{64}$/);
    expect(second.deliveryKey).toBe(first.deliveryKey);
  });
});

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
