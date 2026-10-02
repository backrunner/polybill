import { createSign } from "node:crypto";
import { signRsaSha256, utf8 } from "@polybill/adapter-kit";
import { parseId, parseIsoDateTime } from "@polybill/core";
import { describe, expect, it, vi } from "vitest";
import { createWaffoAdapter } from "../src/index.js";

const privateKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDjlxBp+j6/bFS6
C2fX9dOKLcAUAwf34RznbML1GhFuVjXCrLAvg9bCcYqEoWVSVmhh8rxYKLhwTDB5
aKRuQ9m1Tj5b4MwwsKn1OyDkoFvwACc4GkKvD1BXGGCxaWWTPMKztSXSR/YcRGSo
afWOqT/pd1PAaQ1AdVt882NJhPfQjb9Tw+qyLW5ys7H0NAMn+iiCXQ8mI58ngPP9
HynupRvb+VGgfiy6cTYyEwpxsvskmkBwC/jn53+evkN9tjXEHVxQYf2jV8Ny8HGa
rKPZ76AkeJRLCWjvT4VzoDdpUFJPZFUHYQudoBZ8+xotuD4BNwmkL0h7PTw+fVmY
RHBsxb5nAgMBAAECggEAH4X9johMZ6xEIg7RX97bYaDLoZn34RQrsjxk1pk5P9yu
DpxnvPUYao9afdtzEtAIHkUGZHmjbl6HOlHNsL4yKgQ/6+77qWTW7bI2cKRrh5cl
14X/pYrL+HxWbExqdtXsLAMTzYgNJUYt4QvoKM31ncta7ORAIyT+OpTltDm4L4kn
wInm+/CgyjtkrpsM4kKjXbVdKZkNEUSuoKKd0Wt9szED74huHRKnW/QwQC07kfVB
0vbc8ulpbytMI5XmIweBXZXTcXRzr7fKWpiiFYf2Q2Gk1fnVhEGFGOveTyJ3+Fjp
9I6Q+GCUAs8ExOl49+emUi67X1YusqFm6NKZ8eEvsQKBgQD8EW2lUdTiSYnrm3eu
sbsP/oUij/FtnxMPqWdJoUmj57WUakxk0Gs4P9C7PkE4egaR4dhJO9PL8V83dAzA
AR18zdyLIkX3EbmBlwyUFYbAxjq90MHTxqI18RI2aaJGHjSymRgMNJzNEc+8zieX
ezi6AO6aiUQdbihStCHm8I37MQKBgQDnI+OWrAHysQ+/RJ8SMYhcJZK4mR99vR3t
4N/eC4arh5ykHGTOvSWqDsFhSC/nGO9CMt2hqY6NZ8b9SqbGSxxKBlSERwFhjBwh
QeFxIOx3jGHJ6RQzFdZZGaVOV293H6l8LRi3PnDwEKfQ8gXxvZNOz3xA+Oi/lRBM
anV00GG9FwKBgAj4JcqoKscSjtHPambQ9DMRf3NHY/PeoTMBeCdqkdA/QnrRfX5o
3CfYPXksMe3siadPPf79HgA3yoeSnZGHeKEkQiDBS3QLMWqnEU+DpJPfed+fOgZr
HwKEXX2KLLgKAx4HzI9CoAG8DIRPYaFGRTJ5LgRZtg7GCLFIr5wkGylBAoGBAJhg
05gwO3SIgA4jKg8vcmr1Jj3mTJlzRLje6BcVWCna1Exon5ifn6X15kzA7zuV952X
tP7vrhfQ06GGRl4xhCvU8oDl4qYxXRYbvYj8IIhLlugqbXOkMNQ6kP0NrWFGEVDY
1hNv6bqJ8GhSNdMBnIx3Qr3+mko69iy6fkaNXfHvAoGBAIikgMlN661t6rxzoOxk
R9OIUx7CvqBk1hdP6lIkmkkXdQZY1M4Zbferd3H+IxGu8Yc2IZrW7xYZJTOa2PL9
kGpAkoLdL40m8bPYOayB0mGtVpaL8YjOqvg75E2Mmfz7wLKdSR6eTtBYit859Zuy
pDsFV/sTPI6yIMs5NBo2wOo1
-----END PRIVATE KEY-----`;

const publicKey = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA45cQafo+v2xUugtn1/XT
ii3AFAMH9+Ec52zC9RoRblY1wqywL4PWwnGKhKFlUlZoYfK8WCi4cEwweWikbkPZ
tU4+W+DMMLCp9Tsg5KBb8AAnOBpCrw9QVxhgsWllkzzCs7Ul0kf2HERkqGn1jqk/
6XdTwGkNQHVbfPNjSYT30I2/U8Pqsi1ucrOx9DQDJ/oogl0PJiOfJ4Dz/R8p7qUb
2/lRoH4sunE2MhMKcbL7JJpAcAv45+d/nr5DfbY1xB1cUGH9o1fDcvBxmqyj2e+g
JHiUSwlo70+Fc6A3aVBST2RVB2ELnaAWfPsaLbg+ATcJpC9Iez08Pn1ZmERwbMW+
ZwIDAQAB
-----END PUBLIC KEY-----`;

describe("Waffo webhook contract", () => {
  it.each([
    ["subscription.renewed", "subscription.changed.v1"],
    ["subscription.recovered", "subscription.changed.v1"],
    ["subscription.canceling", "subscription.changed.v1"],
    ["subscription.uncanceled", "subscription.changed.v1"],
    ["subscription.past_due", "subscription.past_due.v1"],
    ["subscription.plan_changed", "subscription.changed.v1"],
    ["subscription.plan_change_scheduled", "subscription.changed.v1"],
    ["subscription.plan_change_failed", "subscription.changed.v1"],
  ])("correlates %s with the subscription order", async (type, expected) => {
    const adapter = createWaffoAdapter();
    const input = signedInput(type, {
      orderId: "ORD_subscription",
      orderStatus: type === "subscription.plan_change_failed" ? "canceled" : "active",
    });
    const verified = await adapter.webhooks.verify(input);
    const decoded = adapter.webhooks.decode(verified);
    expect(decoded.externalIds.object).toBe("ORD_subscription");
    const ctx = mapContext();
    const events = await adapter.webhooks.map(decoded, ctx);
    expect(events[0]).toMatchObject({
      type: expected,
      aggregate: { type: "subscription", id: "sub_canonical" },
    });
    expect(ctx.lookup.findCanonicalId).toHaveBeenCalledWith({
      tenantId: ctx.tenantId,
      connectionId: ctx.connection.id,
      entityType: "subscription",
      externalId: "ORD_subscription",
    });
    expect((await adapter.webhooks.verify(input)).deliveryKey).toBe(verified.deliveryKey);
    await expect(
      adapter.webhooks.verify({
        ...input,
        rawBody: utf8(new TextDecoder().decode(input.rawBody) + " "),
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it.each([{}, { orderId: "ORD_unmapped_new_plan", orderStatus: "canceled" }])(
    "keeps a missing or unmapped plan-change order as evidence without guessing a predecessor",
    async (data) => {
      const adapter = createWaffoAdapter();
      const decoded = adapter.webhooks.decode(
        await adapter.webhooks.verify(signedInput("subscription.plan_change_failed", data)),
      );
      const events = await adapter.webhooks.map(decoded, mapContext());
      expect(events[0]).toMatchObject({
        type: "unmapped_provider_event.v1",
        aggregate: { type: "connection" },
      });
    },
  );

  it("keeps subscription charges attached to the payment ID", async () => {
    const adapter = createWaffoAdapter();
    const decoded = adapter.webhooks.decode(
      await adapter.webhooks.verify(
        signedInput(
          "subscription.payment_succeeded",
          { orderId: "ORD_subscription" },
          "PAY_charge",
        ),
      ),
    );
    const ctx = mapContext();
    const events = await adapter.webhooks.map(decoded, ctx);
    expect(decoded.externalIds).toMatchObject({ object: "PAY_charge", order: "ORD_subscription" });
    expect(events[0]).toMatchObject({
      type: "payment.succeeded.v1",
      aggregate: { type: "payment", id: "pay_canonical" },
    });
  });

  it("keeps different lifecycle events with the same business entity ID", async () => {
    const adapter = createWaffoAdapter();
    const keys: string[] = [];
    const timestamp = Date.parse("2026-08-25T00:00:00.000Z");
    for (const type of [
      "subscription.activated",
      "subscription.canceling",
      "subscription.canceled",
    ]) {
      const body = JSON.stringify({
        id: "ORD_same",
        eventId: "ORD_same",
        eventType: type,
        mode: "test",
        timestamp: "2026-08-25T00:00:00.000Z",
        data: { orderId: "ORD_same" },
      });
      const input = {
        rawBody: utf8(body),
        headers: new Headers({
          "x-waffo-signature": `t=${timestamp},v1=${await signRsaSha256(privateKey, utf8(`${timestamp}.${body}`))}`,
        }),
        secret: { active: publicKey, activeKeyId: "current" },
        environment: "test" as const,
        now: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
      };
      const verified = await adapter.webhooks.verify(input);
      expect((await adapter.webhooks.verify(input)).deliveryKey).toBe(verified.deliveryKey);
      expect(adapter.webhooks.decode(verified).externalIds.event).toBe(verified.deliveryKey);
      keys.push(verified.deliveryKey);
    }
    expect(new Set(keys).size).toBe(3);
  });
  it("verifies RSA over timestamp.raw and isolates the environment", async () => {
    const timestamp = Date.parse("2026-08-25T00:00:00.000Z");
    const body =
      '{"id":"evt_fixture","eventId":"order_fixture","eventType":"order.completed","mode":"test","timestamp":"2026-08-25T00:00:00.000Z","data":{"orderId":"order_fixture"}}';
    const signature = await signRsaSha256(privateKey, utf8(`${timestamp}.${body}`));
    const adapter = createWaffoAdapter();
    const input = {
      rawBody: utf8(body),
      headers: new Headers({
        "x-waffo-signature": `t=${timestamp},v1=${signature}`,
        "x-environment": "test",
      }),
      secret: { active: publicKey, activeKeyId: "key-current" },
      environment: "test" as const,
      now: parseIsoDateTime("2026-08-25T00:00:00.000Z"),
    };
    await expect(adapter.webhooks.verify(input)).resolves.toMatchObject({
      deliveryKey: expect.stringMatching(/^waffo:sha256:[a-f0-9]{64}$/),
    });
    await expect(adapter.webhooks.verify({ ...input, environment: "live" })).rejects.toMatchObject({
      code: "signature_invalid",
    });
  });
});

function signedInput(type: string, data: Readonly<Record<string, unknown>>, paymentId?: string) {
  const now = parseIsoDateTime("2026-10-02T00:00:00.000Z");
  const timestamp = Date.parse(now);
  const eventId =
    paymentId ??
    (type === "subscription.renewed"
      ? "ORD_subscription-renewed-2026-11-02"
      : [
            "subscription.recovered",
            "subscription.canceling",
            "subscription.uncanceled",
            "subscription.past_due",
          ].includes(type)
        ? `ORD_subscription-${now}`
        : "ORD_subscription");
  const body = JSON.stringify({
    id: eventId,
    eventId,
    eventType: type,
    mode: "test",
    timestamp: now,
    data,
  });
  const signature = createSign("RSA-SHA256")
    .update(`${timestamp}.${body}`)
    .sign(privateKey, "base64");
  return {
    rawBody: utf8(body),
    headers: new Headers({ "x-waffo-signature": `t=${timestamp},v1=${signature}` }),
    secret: { active: publicKey, activeKeyId: "fixture" },
    environment: "test" as const,
    now,
  };
}

function mapContext() {
  const tenantId = parseId<"TenantId">("ten_waffofixture", "ten");
  return {
    tenantId,
    connection: {
      tenantId,
      id: parseId<"ConnectionId">("conn_waffofixture", "conn"),
      provider: "waffo" as const,
      environment: "test" as const,
    },
    observedAt: parseIsoDateTime("2026-10-02T00:00:00.000Z"),
    lookup: {
      findCanonicalId: vi.fn(
        async ({ entityType, externalId }: { entityType: string; externalId: string }) => {
          if (entityType === "subscription" && externalId === "ORD_subscription")
            return "sub_canonical";
          if (entityType === "payment" && externalId === "PAY_charge") return "pay_canonical";
          return undefined;
        },
      ),
    },
  };
}
