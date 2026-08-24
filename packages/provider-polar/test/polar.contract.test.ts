import { hmacSha256, joinBytes, utf8 } from "@polybill/adapter-kit";
import { parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createPolarAdapter } from "../src/index.js";

describe("Polar webhook contract", () => {
  it("verifies Standard Webhooks over exact raw bytes", async () => {
    const body = '{"type":"order.paid","data":{"id":"order_fixture"}}';
    const id = "msg_fixture";
    const timestamp = 1_756_080_000;
    const secret = "polar-webhook-secret";
    const signature = base64(
      await hmacSha256(secret, joinBytes(utf8(`${id}.${timestamp}.`), utf8(body))),
    );
    const verified = await createPolarAdapter().webhooks.verify({
      rawBody: utf8(body),
      headers: new Headers({
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1,${signature}`,
      }),
      secret: { active: secret, activeKeyId: "key-current" },
      environment: "test",
      now: parseIsoDateTime("2025-08-25T00:00:00.000Z"),
    });
    expect(verified.deliveryKey).toBe("polar:msg_fixture");
    expect(createPolarAdapter().webhooks.decode(verified).externalIds.object).toBe("order_fixture");
  });
});

function base64(value: Uint8Array): string {
  return globalThis.btoa(String.fromCharCode(...value));
}
