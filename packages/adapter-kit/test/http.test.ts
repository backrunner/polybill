import { describe, expect, it } from "vitest";
import { createHttpTransport } from "../src/index.js";

describe("HTTP transport", () => {
  it("bounds provider responses", async () => {
    const transport = createHttpTransport({
      provider: "fake",
      maxResponseBytes: 3,
      fetch: () => Promise.resolve(new Response("four")),
    });
    await expect(
      transport.send({ method: "GET", url: "https://fake.invalid" }),
    ).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
  });

  it("decodes JSON without trusting the response type", async () => {
    const transport = createHttpTransport({
      provider: "fake",
      fetch: () => Promise.resolve(Response.json({ ok: true })),
    });
    const response = await transport.send({ method: "GET", url: "https://fake.invalid" });
    expect(response.json()).toEqual({ ok: true });
  });
});
