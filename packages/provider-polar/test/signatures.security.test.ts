import { parseIsoDateTime } from "@polybill/core";
import { describe, expect, it } from "vitest";
import { createPolarAdapter } from "../src/index.js";

const secret = "whsec_cG9sYXIta2V5LXJldmlldw==";
const body = '{"type":"order.paid","data":{"id":"order_fixture","note":"支付"}}\n';
// Independent Python hmac/SHA-256 vectors; see the official September 2026 secret rollout.
const signatures = {
  legacy: "GJshuNkjIfEukLv+nofN4rAtC9lvBNKwjDzVOpeJpBA=",
  standard: "Tn1b5Ypm367bmqkSD1QZkgM6N1GhVUk0lmZ4c2PCHKA=",
};

describe("Polar signature rollout", () => {
  it.each(Object.entries(signatures))(
    "verifies %s keys, rotation and raw-body integrity",
    async (_scheme, signature) => {
      const adapter = createPolarAdapter();
      const input = {
        rawBody: new TextEncoder().encode(body),
        headers: new Headers({
          "webhook-id": "msg_polar_rollout",
          "webhook-timestamp": "1788825600",
          "webhook-signature": `v1,${signature}`,
        }),
        secret: { active: secret, activeKeyId: "current" },
        environment: "test" as const,
        now: parseIsoDateTime("2026-09-08T00:00:00.000Z"),
      };
      await expect(adapter.webhooks.verify(input)).resolves.toMatchObject({ keyId: "current" });
      await expect(
        adapter.webhooks.verify({
          ...input,
          secret: {
            active: "wrong-active-key",
            activeKeyId: "new",
            previous: secret,
            previousKeyId: "old",
          },
        }),
      ).resolves.toMatchObject({ keyId: "old" });
      await expect(
        adapter.webhooks.verify({ ...input, rawBody: new TextEncoder().encode(body.trimEnd()) }),
      ).rejects.toMatchObject({ code: "signature_invalid" });
      await expect(
        adapter.webhooks.verify({
          ...input,
          secret: { active: "wrong-key", activeKeyId: "wrong" },
        }),
      ).rejects.toMatchObject({ code: "signature_invalid" });
      const bare = new Headers(input.headers);
      bare.set("webhook-signature", signature);
      await expect(adapter.webhooks.verify({ ...input, headers: bare })).rejects.toMatchObject({
        code: "signature_invalid",
      });
    },
  );
});
