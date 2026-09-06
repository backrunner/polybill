import { describe, expect, it, vi } from "vitest";
import { parseIsoDateTime } from "@polybill/core";
import { createHttpTransport } from "../src/index.js";

describe("provider transport security", () => {
  it("refuses redirects and does not return attacker-controlled response data", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 307, headers: { location: "https://attacker.example" } });
    });
    await expect(
      createHttpTransport({ provider: "stripe", fetch }).send({
        method: "POST",
        url: "https://api.stripe.com/v1/customers",
        headers: { authorization: "Bearer canary-secret" },
      }),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts transport exceptions and malformed JSON parser excerpts", async () => {
    const fetch = async () => {
      throw new Error("canary-api-key buyer@example.com");
    };
    const network = await createHttpTransport({ provider: "creem", fetch })
      .send({ method: "GET", url: "https://api.creem.io/v1/customers" })
      .catch((error: unknown) => error);
    expect(network).toMatchObject({ code: "provider_unavailable", cause: undefined });
    expect(String(network)).not.toContain("canary");
    const response = await createHttpTransport({
      provider: "stripe",
      fetch: async () => new Response('{"secret":"canary-private-data" invalid}'),
    }).send({ method: "GET", url: "https://api.stripe.com" });
    try {
      response.json();
      throw new Error("expected decode failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "provider_response_invalid", cause: undefined });
      expect(String(error)).not.toContain("canary");
    }
  });

  it("rejects invalid UTF-8 instead of replacing bytes inside JSON strings", async () => {
    const bytes = new Uint8Array([123, 34, 105, 100, 34, 58, 34, 255, 34, 125]);
    const response = await createHttpTransport({
      provider: "stripe",
      fetch: async () => new Response(bytes),
    }).send({ method: "GET", url: "https://api.stripe.com" });
    expect(() => response.json()).toThrow(
      expect.objectContaining({ code: "provider_response_invalid" }),
    );
  });

  it.each(["headers", "body"])("enforces the deadline while waiting for %s", async (stage) => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        signal = init?.signal;
        return stage === "headers"
          ? new Promise<Response>(() => undefined)
          : new Response(new ReadableStream<Uint8Array>());
      };
      const result = createHttpTransport({
        provider: "dodo",
        fetch,
        clock: { now: () => parseIsoDateTime("2026-09-06T00:00:00.000Z") },
        deadline: parseIsoDateTime("2026-09-06T00:00:00.050Z"),
      }).send({ method: "POST", url: "https://test.dodopayments.com/checkouts" });
      const rejected = expect(result).rejects.toMatchObject({ code: "provider_unavailable" });
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
