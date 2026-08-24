import { parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createStripeAdapter } from "../src/index.js";

const BODY =
  '{"id":"evt_123","type":"checkout.session.completed","created":1756080000,"data":{"object":{"id":"cs_test_123"}}}';
const SIGNATURE =
  "t=1756080000,v1=df29513867273f0b96a96efc29cbbd8c6cb2190012a8bc0730a6f51423dfb1c9";
const SECRET = "whsec_fixture";

describe("Stripe webhook security", () => {
  it("verifies the exact signed bytes and rejects body tampering", async () => {
    const adapter = createStripeAdapter();
    await expect(adapter.webhooks.verify(input(BODY))).resolves.toMatchObject({
      deliveryKey: "stripe:evt_123",
    });

    for (const tampered of [`${BODY} `, BODY.replace("evt_123", "evt_124")]) {
      await expect(adapter.webhooks.verify(input(tampered))).rejects.toMatchObject({
        code: "signature_invalid",
      });
    }
  });

  it("rejects old and future timestamps without disclosing the secret", async () => {
    const adapter = createStripeAdapter();
    for (const now of ["2025-08-25T00:05:01.000Z", "2025-08-24T23:54:59.000Z"] as const) {
      const error = await capture(adapter.webhooks.verify(input(BODY, now)));
      expect(error).toMatchObject({ code: "replay_rejected" });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(SECRET);
    }

    const invalid = await capture(
      adapter.webhooks.verify({
        ...input(BODY),
        headers: new Headers({ "Stripe-Signature": "t=1756080000,v1=invalid" }),
      }),
    );
    expect(invalid).toMatchObject({ code: "signature_invalid" });
    expect(`${String(invalid)} ${JSON.stringify(invalid)}`).not.toContain(SECRET);
  });
});

function input(body: string, now = "2025-08-25T00:00:00.000Z") {
  return {
    rawBody: new TextEncoder().encode(body),
    headers: new Headers({ "Stripe-Signature": SIGNATURE }),
    secret: { active: SECRET, activeKeyId: "key-current" },
    environment: "test" as const,
    now: parseIsoDateTime(now),
  };
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
