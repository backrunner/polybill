import { createScriptedFetch } from "@polybill/testing";
import { createModeration } from "polybill/moderation";
import { describe, expect, it } from "vitest";
import { creemModeration } from "../../provider-creem/src/moderation.js";
import { dodoModeration } from "../../provider-dodo/src/moderation.js";
import { subscriptionContext } from "./subscription-fixtures.js";

const prompt = "A painting of a lighthouse";
const creemUrl = "https://test-api.creem.io/v1/moderation/prompt";
const dodoUrl = "https://test.dodopayments.com/moderation/screen";

describe("standalone moderation", () => {
  it.each(["allow", "flag", "deny"] as const)(
    "returns Creem %s without echoed text",
    async (decision) => {
      const script = createScriptedFetch([
        {
          method: "POST",
          url: creemUrl,
          response: Response.json({
            id: "receipt_fixture",
            object: "moderation_result",
            prompt,
            decision,
            usage: { units: 0 },
          }),
        },
      ]);
      const context = subscriptionContext("creem", script.fetch);
      const client = createModeration({ ...context, provider: creemModeration });
      const result = await client.screen({ text: prompt });
      expect(result).toEqual({
        decision,
        usageUnits: 0,
        ...(decision === "allow"
          ? {
              receipt: {
                connection: context.connection,
                providerResultId: "receipt_fixture",
              },
            }
          : {}),
      });
      expect(await script.requests[0]?.json()).toEqual({ prompt });
      script.assertConsumed();
    },
  );

  it("rejects Creem image input and mismatched credentials before transport", async () => {
    const script = createScriptedFetch([]);
    const context = subscriptionContext("creem", script.fetch);
    const client = createModeration({
      ...context,
      provider: creemModeration,
      credentials: { apiKey: "creem_live_fixture" },
    });
    await expect(client.screen({ image: "AA==" })).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    await expect(client.screen({ text: prompt })).rejects.toMatchObject({
      code: "authentication_failed",
    });
    expect(script.requests).toHaveLength(0);
  });

  it("fails closed on an unrecognized verdict or outage", async () => {
    const script = createScriptedFetch([
      {
        method: "POST",
        url: creemUrl,
        response: Response.json({
          id: "receipt_fixture",
          object: "moderation_result",
          prompt,
          decision: "pending",
          usage: { units: 1 },
        }),
      },
      {
        method: "POST",
        url: creemUrl,
        response: Response.json({ message: prompt }, { status: 503 }),
      },
    ]);
    const context = subscriptionContext("creem", script.fetch);
    const client = createModeration({ ...context, provider: creemModeration });
    await expect(client.screen({ text: prompt })).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
    await expect(client.screen({ text: prompt })).rejects.toMatchObject({
      code: "provider_unavailable",
      message: "Creem rejected the request",
    });
    script.assertConsumed();
  });

  it("screens Dodo image-only input and returns a rate limit as an error", async () => {
    const script = createScriptedFetch([
      {
        method: "POST",
        url: dodoUrl,
        response: Response.json({ decision: "allow", request_id: "upload-1" }),
      },
      {
        method: "POST",
        url: dodoUrl,
        response: new Response(null, { status: 429, headers: { "Retry-After": "3" } }),
      },
    ]);
    const context = subscriptionContext("dodo", script.fetch);
    const client = createModeration({ ...context, provider: dodoModeration });
    const image = "data:image/png;base64,iVBORw0KGgo=";
    await expect(
      client.screen({ image: "https://merchant.example/image.png" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.screen({ image, reference: "upload-1" })).resolves.toEqual({
      decision: "allow",
    });
    expect(await script.requests[0]?.json()).toEqual({ image, request_id: "upload-1" });
    await expect(client.screen({ text: prompt })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 3000,
    });
    script.assertConsumed();
  });
});
