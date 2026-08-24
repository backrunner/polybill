import { hmacSha256, utf8 } from "@polybill/adapter-kit";
import { parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createCreemAdapter } from "../src/index.js";

describe("Creem webhook contract", () => {
  it("verifies raw-body HMAC and rejects JSON reserialization", async () => {
    const body =
      '{"id":"evt_fixture","eventType":"checkout.completed","object":{"id":"ch_fixture"}}';
    const secret = "creem-webhook-secret";
    const signature = hex(await hmacSha256(secret, utf8(body)));
    const input = {
      rawBody: utf8(body),
      headers: new Headers({ "creem-signature": signature }),
      secret: { active: secret, activeKeyId: "key-current" },
      environment: "test" as const,
      now: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
    };
    const verified = await createCreemAdapter().webhooks.verify(input);
    expect(verified.deliveryKey).toBe("creem:evt_fixture");
    await expect(
      createCreemAdapter().webhooks.verify({
        ...input,
        rawBody: utf8(`${body}\n`),
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });
});

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
