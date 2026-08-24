import { hmacSha256, joinBytes, utf8 } from "@polybill/adapter-kit";
import { parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createPaddleAdapter } from "../src/index.js";

describe("Paddle Billing webhook contract", () => {
  it("verifies timestamp and raw body using the Billing signature format", async () => {
    const body =
      '{"event_id":"evt_fixture","event_type":"transaction.completed","occurred_at":"2025-08-25T00:00:00.000Z","data":{"id":"txn_fixture"}}';
    const secret = "paddle-webhook-secret";
    const timestamp = 1_756_080_000;
    const signature = hex(await hmacSha256(secret, joinBytes(utf8(`${timestamp}:`), utf8(body))));
    const verified = await createPaddleAdapter().webhooks.verify({
      rawBody: utf8(body),
      headers: new Headers({ "paddle-signature": `ts=${timestamp};h1=${signature}` }),
      secret: { active: secret, activeKeyId: "key-current" },
      environment: "test",
      now: parseIsoDateTime("2025-08-25T00:00:00.000Z"),
    });
    expect(verified.deliveryKey).toBe("paddle:evt_fixture");
  });
});

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
