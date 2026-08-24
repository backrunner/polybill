import { money, parseId, parseIsoDateTime } from "@polybill/core";
import { createWebSecretCrypto, LicenseService, VoucherService } from "@polybill/licensing";
import { describe, expect, it } from "vitest";
import { createMemoryLicensingStore } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_license01", "ten");
const grantId = parseId<"EntitlementGrantId">("grant_license01", "grant");

function setup() {
  const store = createMemoryLicensingStore();
  const crypto = createWebSecretCrypto({
    digestKey: new Uint8Array(32).fill(17),
    activeEncryptionKeyId: "current",
    encryptionKeys: { current: new Uint8Array(32).fill(29) },
  });
  const common = {
    store,
    crypto,
    ids: new TestIds(),
    clock: { now: () => parseIsoDateTime("2026-08-25T00:00:00.000Z") },
  };
  return {
    store,
    crypto,
    licenses: new LicenseService(common),
    vouchers: new VoucherService(common),
  };
}

class TestIds {
  #sequence = 0;
  next(prefix: string): string {
    return `${prefix}_${String(++this.#sequence).padStart(12, "0")}`;
  }
}

describe("memory licensing store contract", () => {
  it("issues an idempotent encrypted license and enforces activation CAS", async () => {
    const { licenses } = setup();
    const command = {
      tenantId,
      grantId,
      issuanceKey: "license-issuance-0001",
      activationLimit: 1,
    } as const;
    const first = await licenses.issue(command);
    const replay = await licenses.issue(command);
    expect(replay.key).toBe(first.key);
    expect(replay.replayed).toBe(true);
    expect(JSON.stringify(first.license)).not.toContain(first.key);

    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        licenses.activate({
          tenantId,
          key: first.key,
          instanceRef: `instance-${index}`,
          deviceFingerprint: `device-${index}`,
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("atomically consumes a single-use voucher once under contention", async () => {
    const { vouchers } = setup();
    const issued = await vouchers.createBatch({
      tenantId,
      issuanceKey: "voucher-issuance-0001",
      prefix: "CARD1",
      quantity: 1,
      maxUses: 1,
      benefit: {
        kind: "entitlement",
        policyId: parseId<"EntitlementPolicyId">("epol_voucher01", "epol"),
      },
    });
    const code = issued.codes[0];
    expect(code).toBeDefined();
    if (code === undefined) return;
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        vouchers.redeem({
          tenantId,
          code,
          idempotencyKey: `voucher-redeem-${String(index).padStart(4, "0")}`,
          beneficiaryRef: `customer-${index}`,
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("tracks partial credit without floating point", async () => {
    const { vouchers } = setup();
    const issued = await vouchers.createBatch({
      tenantId,
      issuanceKey: "voucher-credit-0001",
      prefix: "CRED1",
      quantity: 1,
      maxUses: 2,
      benefit: { kind: "credit", initialValue: money("1000", "USD") },
    });
    const code = issued.codes[0];
    expect(code).toBeDefined();
    if (code === undefined) return;
    await vouchers.redeem({
      tenantId,
      code,
      idempotencyKey: "credit-redeem-0001",
      beneficiaryRef: "customer-1",
      value: money("400", "USD"),
    });
    const second = await vouchers.redeem({
      tenantId,
      code,
      idempotencyKey: "credit-redeem-0002",
      beneficiaryRef: "customer-1",
      value: money("600", "USD"),
    });
    expect(second.value).toEqual(money("600", "USD"));
  });

  it("binds ciphertext to its tenant and entity AAD", async () => {
    const { crypto } = setup();
    const encrypted = await crypto.encrypt("secret", "tenant-a:license-a");
    await expect(crypto.decrypt(encrypted, "tenant-b:license-a")).rejects.toThrow();
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("0") ? "1" : "0"}`;
    await expect(crypto.decrypt(tampered, "tenant-a:license-a")).rejects.toThrow();
  });
});
