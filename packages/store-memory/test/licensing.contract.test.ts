import { money, parseId, parseIsoDateTime } from "@polybill/core";
import {
  createWebSecretCrypto,
  EntitlementService,
  LicenseService,
  type EntitlementGrant,
  VoucherService,
} from "@polybill/licensing";
import { describe, expect, it } from "vitest";
import { createMemoryLicensingStore, MemoryLicensingStore } from "../src/index.js";

const tenantId = parseId<"TenantId">("ten_license01", "ten");
const otherTenantId = parseId<"TenantId">("ten_license02", "ten");

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
    entitlements: new EntitlementService(common),
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

class FailOnceGrantStore extends MemoryLicensingStore {
  #failed = false;

  override async createEntitlementGrant(
    ...args: Parameters<MemoryLicensingStore["createEntitlementGrant"]>
  ): ReturnType<MemoryLicensingStore["createEntitlementGrant"]> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("injected grant commit failure");
    }
    return super.createEntitlementGrant(...args);
  }
}

describe("memory licensing store contract", () => {
  it("creates isolated, idempotent grants and enforces their lifecycle", async () => {
    const { entitlements } = setup();
    const firstPolicy = await entitlements.createPolicy({
      tenantId,
      idempotencyKey: "policy-create-0001",
      benefit: "app:pro",
      revokeOn: "subscription_end",
      gracePeriodSeconds: 3600,
    });
    const replay = await entitlements.createPolicy({
      tenantId,
      idempotencyKey: "policy-create-0001",
      benefit: "app:pro",
      revokeOn: "subscription_end",
      gracePeriodSeconds: 3600,
    });
    expect(replay.id).toBe(firstPolicy.id);
    const secondPolicy = await entitlements.createPolicy({
      tenantId,
      idempotencyKey: "policy-create-0002",
      benefit: "app:analytics",
      revokeOn: "refund",
      gracePeriodSeconds: 0,
    });
    const firstGrant = await entitlements.grant({
      tenantId,
      idempotencyKey: "grant-create-0001",
      policyId: firstPolicy.id,
      beneficiaryRef: "customer-123",
      source: "order",
      sourceRef: "order-123",
    });
    const secondGrant = await entitlements.grant({
      tenantId,
      idempotencyKey: "grant-create-0002",
      policyId: secondPolicy.id,
      beneficiaryRef: "customer-123",
      source: "order",
      sourceRef: "order-123",
    });
    expect(secondGrant.policyId).not.toBe(firstGrant.policyId);
    await expect(
      entitlements.grant({
        tenantId,
        idempotencyKey: "grant-create-0003",
        policyId: firstPolicy.id,
        beneficiaryRef: "customer-123",
        source: "order",
        sourceRef: "order-123",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(entitlements.get(otherTenantId, firstGrant.id)).rejects.toMatchObject({
      code: "not_found",
    });
    const suspended = await entitlements.suspend(tenantId, firstGrant.id, "grant-suspend-0001");
    await expect(
      entitlements.suspend(tenantId, firstGrant.id, "grant-suspend-0001"),
    ).resolves.toEqual(suspended);
    await expect(
      entitlements.restore(tenantId, firstGrant.id, "grant-suspend-0001"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      entitlements.suspend(tenantId, firstGrant.id, "grant-suspend-0002"),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      entitlements.restore(tenantId, firstGrant.id, "grant-restore-0001"),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("issues an idempotent encrypted license and enforces activation CAS", async () => {
    const { entitlements, licenses } = setup();
    const policy = await entitlements.createPolicy({
      tenantId,
      idempotencyKey: "policy-license-0001",
      benefit: "app:licensed",
      revokeOn: "refund",
      gracePeriodSeconds: 0,
    });
    const grant = await entitlements.grant({
      tenantId,
      idempotencyKey: "grant-license-0001",
      policyId: policy.id,
      beneficiaryRef: "customer-license",
      source: "manual",
      sourceRef: "support-case-1",
    });
    const command = {
      tenantId,
      grantId: grant.id,
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

    await entitlements.revoke(tenantId, grant.id, "grant-revoke-0001");
    await expect(licenses.validate({ tenantId, key: first.key })).resolves.toBeUndefined();
    await expect(
      licenses.issue({ ...command, issuanceKey: "license-issuance-0002" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("atomically consumes a single-use voucher once under contention", async () => {
    const { entitlements, vouchers } = setup();
    const policy = await entitlements.createPolicy({
      tenantId,
      idempotencyKey: "policy-voucher-0001",
      benefit: "app:voucher-access",
      revokeOn: "never",
      gracePeriodSeconds: 0,
    });
    const issued = await vouchers.createBatch({
      tenantId,
      issuanceKey: "voucher-issuance-0001",
      prefix: "CARD1",
      quantity: 1,
      maxUses: 1,
      benefit: {
        kind: "entitlement",
        policyId: policy.id,
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
    const successful = attempts.find((result) => result.status === "fulfilled");
    if (successful?.status !== "fulfilled") throw new Error("Expected successful redemption");
    const replay = await vouchers.redeemWithBenefit({
      tenantId,
      code,
      idempotencyKey: successful.value.idempotencyKey,
      beneficiaryRef: successful.value.beneficiaryRef,
    });
    expect(replay.entitlementGrant).toMatchObject({
      policyId: policy.id,
      beneficiaryRef: successful.value.beneficiaryRef,
      source: "voucher",
      sourceRef: successful.value.id,
    });
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

  it("recovers entitlement delivery after redemption was already committed", async () => {
    const store = new FailOnceGrantStore();
    const crypto = createWebSecretCrypto({
      digestKey: new Uint8Array(32).fill(31),
      activeEncryptionKeyId: "current",
      encryptionKeys: { current: new Uint8Array(32).fill(32) },
    });
    const common = {
      store,
      crypto,
      ids: new TestIds(),
      clock: { now: () => parseIsoDateTime("2026-08-25T00:00:00.000Z") },
    };
    const entitlements = new EntitlementService(common);
    const vouchers = new VoucherService(common);
    const policy = await entitlements.createPolicy({
      tenantId,
      idempotencyKey: "policy-recovery-0001",
      benefit: "app:recovered",
      revokeOn: "never",
      gracePeriodSeconds: 0,
    });
    const batch = await vouchers.createBatch({
      tenantId,
      issuanceKey: "voucher-recovery-0001",
      prefix: "RCVR",
      quantity: 1,
      maxUses: 1,
      benefit: { kind: "entitlement", policyId: policy.id },
    });
    const code = batch.codes[0];
    if (code === undefined) throw new Error("Expected recovery voucher");
    const command = {
      tenantId,
      code,
      idempotencyKey: "voucher-recovery-redeem",
      beneficiaryRef: "customer-recovery",
    } as const;
    await expect(vouchers.redeemWithBenefit(command)).rejects.toThrow(
      "injected grant commit failure",
    );
    const recovered = await vouchers.redeemWithBenefit(command);
    const replay = await vouchers.redeemWithBenefit(command);
    expect(recovered.redemption.id).toBe(replay.redemption.id);
    expect(recovered.entitlementGrant?.id).toBe(replay.entitlementGrant?.id);
    expect(recovered.entitlementGrant).toMatchObject<Partial<EntitlementGrant>>({
      beneficiaryRef: command.beneficiaryRef,
      sourceRef: recovered.redemption.id,
    });
  });

  it("binds ciphertext to its tenant and entity AAD", async () => {
    const { crypto } = setup();
    const encrypted = await crypto.encrypt("secret", "tenant-a:license-a");
    await expect(crypto.decrypt(encrypted, "tenant-b:license-a")).rejects.toThrow();
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("0") ? "1" : "0"}`;
    await expect(crypto.decrypt(tampered, "tenant-a:license-a")).rejects.toThrow();
  });
});
