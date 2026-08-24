import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebCryptoPort } from "@polybill/adapter-kit";
import { parseId } from "@polybill/core";
import { createWebSecretCrypto, EntitlementService, VoucherService } from "@polybill/licensing";
import { D1LicensingStore, type D1DatabaseLike } from "@polybill/store-d1";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { SecureIdGenerator, systemClock } from "polybill";
import { afterEach, describe, expect, it } from "vitest";

const tenantId = parseId<"TenantId">("ten_workerexample", "ten");
const connectionId = parseId<"ConnectionId">("conn_workerexample", "conn");
const digestKey = new Uint8Array(32).fill(31);
const encryptionKey = new Uint8Array(32).fill(47);

describe("example Worker in workerd", () => {
  let miniflare: Miniflare | undefined;
  let temporary: string | undefined;

  afterEach(async () => {
    await miniflare?.dispose();
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
  });

  it("ingests a signed webhook through Queue and serializes voucher redemption with a DO", async () => {
    temporary = await mkdtemp(join(tmpdir(), "polybill-worker-"));
    const bundle = join(temporary, "worker.mjs");
    await build({
      entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2023",
      conditions: ["workerd", "worker", "import"],
      sourcemap: false,
    });
    miniflare = new Miniflare({
      rootPath: temporary,
      modules: true,
      modulesRoot: temporary,
      scriptPath: "worker.mjs",
      compatibilityDate: "2026-07-30",
      bindings: {
        POLYBILL_TENANT_ID: tenantId,
        POLYBILL_CONNECTION_ID: connectionId,
        POLYBILL_PROVIDER: "creem",
        POLYBILL_ENVIRONMENT: "test",
        POLYBILL_API_KEY: "creem_fixture_api_key",
        POLYBILL_WEBHOOK_SECRET: "creem_fixture_webhook_secret",
        POLYBILL_DIGEST_KEY: base64(digestKey),
        POLYBILL_ENCRYPTION_KEY: base64(encryptionKey),
      },
      d1Databases: { POLYBILL_DB: "polybill-example-test" },
      queueProducers: { POLYBILL_WEBHOOK_QUEUE: "polybill-webhooks" },
      queueConsumers: { "polybill-webhooks": { maxBatchSize: 1, maxBatchTimeout: 1 } },
      durableObjects: { REDEMPTION_COORDINATOR: "VoucherRedemptionCoordinator" },
    });
    const db = await miniflare.getD1Database("POLYBILL_DB");
    await applyMigrations(db);
    await db
      .prepare(
        "INSERT INTO polybill_mappings (tenant_id, connection_id, entity_type, entity_id, external_id, mapping_version, source) VALUES (?, ?, 'checkout', ?, ?, 1, 'created')",
      )
      .bind(tenantId, connectionId, "chk_workerexample", "checkout_external")
      .run();

    const body = JSON.stringify({
      id: "evt_workerexample",
      eventType: "checkout.completed",
      created_at: 1_787_616_000_000,
      object: { id: "checkout_external" },
    });
    const webhook = await miniflare.dispatchFetch(
      `https://worker.test/webhooks/polybill/creem/${connectionId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "creem-signature": await hmacHex("creem_fixture_webhook_secret", body),
        },
        body,
      },
    );
    expect(webhook.status).toBe(202);
    await waitForApplied(db);
    const event = await db
      .prepare("SELECT payload FROM polybill_outbox WHERE event_id IS NOT NULL")
      .first<{ payload: string }>();
    expect(event).not.toBeNull();
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({
      type: "checkout.completed.v1",
      aggregate: { type: "checkout", id: "chk_workerexample" },
    });

    const code = await issueVoucher(db);
    const responses = await Promise.all(
      ["redeem-worker-one", "redeem-worker-two"].map((idempotencyKey) =>
        miniflare?.dispatchFetch("https://worker.test/vouchers/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, idempotencyKey, beneficiaryRef: idempotencyKey }),
        }),
      ),
    );
    expect(responses.map((response) => response?.status).sort()).toEqual([200, 409]);
  });
});

async function issueVoucher(db: D1DatabaseLike): Promise<string> {
  const crypto = createWebSecretCrypto({
    digestKey,
    activeEncryptionKeyId: "worker-v1",
    encryptionKeys: { "worker-v1": encryptionKey },
  });
  const common = {
    store: new D1LicensingStore(db),
    crypto,
    ids: new SecureIdGenerator(createWebCryptoPort()),
    clock: systemClock,
  };
  const policy = await new EntitlementService(common).createPolicy({
    tenantId,
    idempotencyKey: "worker-voucher-policy",
    benefit: "app:worker-access",
    revokeOn: "never",
    gracePeriodSeconds: 0,
  });
  const service = new VoucherService(common);
  const issued = await service.createBatch({
    tenantId,
    issuanceKey: "worker-voucher-issuance",
    prefix: "WORK",
    quantity: 1,
    maxUses: 1,
    benefit: {
      kind: "entitlement",
      policyId: policy.id,
    },
  });
  const code = issued.codes[0];
  if (code === undefined) throw new Error("Expected a voucher code");
  return code;
}

async function applyMigrations(db: D1DatabaseLike & { exec(query: string): Promise<unknown> }) {
  for (const name of [
    "0001_control_plane.sql",
    "0002_x402_nonce.sql",
    "0003_migration_leases.sql",
    "0004_reconciliation_checkpoints.sql",
    "0005_entitlements.sql",
    "0006_entitlement_beneficiaries.sql",
    "0007_discounts.sql",
    "0008_discount_redemptions.sql",
  ]) {
    const sql = await readFile(
      new URL(`../../../packages/store-d1/migrations/${name}`, import.meta.url),
      "utf8",
    );
    await db.exec(
      sql
        .split(";")
        .map((statement) => statement.replace(/\s+/g, " ").trim())
        .filter((statement) => statement.length > 0)
        .map((statement) => `${statement};`)
        .join("\n"),
    );
  }
}

async function waitForApplied(db: D1DatabaseLike): Promise<void> {
  let last: { readonly state: string; readonly last_error_code: string | null } | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await db
      .prepare("SELECT state, last_error_code FROM polybill_inbox WHERE connection_id = ?")
      .bind(connectionId)
      .first<{ state: string; last_error_code: string | null }>();
    if (last?.state === "applied") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Webhook queue did not apply the inbox record: ${JSON.stringify(last)}`);
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
