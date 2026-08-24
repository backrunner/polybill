import {
  PolybillError,
  parseId,
  type Clock,
  type IsoDateTime,
  type Money,
  type TenantId,
} from "@polybill/core";
import { generateSecret, normalizeSecret } from "./keys.js";
import type {
  EntitlementGrant,
  VoucherBatch,
  VoucherBenefit,
  VoucherRecord,
  VoucherRedemption,
} from "./domain.js";
import { EntitlementService } from "./entitlement-service.js";
import type { EntitlementStore, LicensingIds, SecretCrypto, VoucherStore } from "./ports.js";

export interface VoucherServiceOptions {
  readonly store: VoucherStore & EntitlementStore;
  readonly crypto: SecretCrypto;
  readonly ids: LicensingIds;
  readonly clock: Clock;
}
export interface CreateVoucherBatchCommand {
  readonly tenantId: TenantId;
  readonly issuanceKey: string;
  readonly prefix: string;
  readonly quantity: number;
  readonly maxUses: number;
  readonly benefit: VoucherBenefit;
  readonly expiresAt?: IsoDateTime;
}

export class VoucherService {
  readonly #options: VoucherServiceOptions;
  readonly #entitlements: EntitlementService;
  constructor(options: VoucherServiceOptions) {
    this.#options = options;
    this.#entitlements = new EntitlementService(options);
  }

  async createBatch(command: CreateVoucherBatchCommand): Promise<{
    readonly batch: VoucherBatch;
    readonly codes: readonly string[];
    readonly replayed: boolean;
  }> {
    integer(command.quantity, "quantity", 100_000);
    integer(command.maxUses, "max uses", 1_000_000);
    if (
      command.benefit.kind === "entitlement" &&
      (await this.#options.store.getEntitlementPolicy(
        command.tenantId,
        command.benefit.policyId,
      )) === undefined
    )
      throw new PolybillError("Entitlement policy was not found", {
        code: "not_found",
        operation: "voucher.create_batch",
        retryable: false,
      });
    const prefix = command.prefix.toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,7}$/.test(prefix))
      throw invalid("Voucher prefix must be 2-8 uppercase characters", "voucher.create_batch");
    const payloadHash = await this.#options.crypto.hash(
      JSON.stringify([
        prefix,
        command.quantity,
        command.maxUses,
        command.benefit,
        command.expiresAt ?? null,
      ]),
    );
    const batch: VoucherBatch = {
      id: parseId<"VoucherBatchId">(this.#options.ids.next("vbat"), "vbat"),
      tenantId: command.tenantId,
      prefix,
      quantity: command.quantity,
      maxUses: command.maxUses,
      benefit: command.benefit,
      createdAt: this.#options.clock.now(),
      ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
    };
    const issued: { record: VoucherRecord; code: string }[] = [];
    for (let index = 0; index < command.quantity; index += 1) {
      const code = await generateSecret(prefix, this.#options.crypto);
      const normalized = await normalizeSecret(code, prefix, this.#options.crypto);
      const id = parseId<"VoucherId">(this.#options.ids.next("vch"), "vch");
      issued.push({
        code,
        record: {
          id,
          tenantId: command.tenantId,
          batchId: batch.id,
          digest: await this.#options.crypto.digest(normalized),
          encryptedValue: await this.#options.crypto.encrypt(code, aad(command.tenantId, id)),
          status: "active",
          remainingUses: command.maxUses,
          ...(command.benefit.kind === "credit"
            ? { remainingValue: command.benefit.initialValue }
            : {}),
          ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
        },
      });
    }
    const result = await this.#options.store.createVoucherBatch(
      batch,
      issued.map((item) => item.record),
      command.issuanceKey,
      payloadHash,
    );
    if (result.kind === "conflict")
      throw new PolybillError("Issuance key was used with a different voucher batch", {
        code: "idempotency_conflict",
        operation: "voucher.create_batch",
        retryable: false,
      });
    const codes =
      result.kind === "created"
        ? issued.map((item) => item.code)
        : await Promise.all(
            result.vouchers.map((voucher) =>
              this.#options.crypto.decrypt(
                voucher.encryptedValue,
                aad(command.tenantId, voucher.id),
              ),
            ),
          );
    return { batch: result.batch, codes, replayed: result.kind === "replay" };
  }

  async redeem(input: {
    readonly tenantId: TenantId;
    readonly code: string;
    readonly idempotencyKey: string;
    readonly beneficiaryRef: string;
    readonly value?: Money;
  }): Promise<VoucherRedemption> {
    return (await this.redeemWithBenefit(input)).redemption;
  }

  async redeemWithBenefit(input: {
    readonly tenantId: TenantId;
    readonly code: string;
    readonly idempotencyKey: string;
    readonly beneficiaryRef: string;
    readonly value?: Money;
  }): Promise<{
    readonly redemption: VoucherRedemption;
    readonly entitlementGrant?: EntitlementGrant;
  }> {
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255)
      throw invalid("Invalid idempotency key", "voucher.redeem");
    const prefix = input.code.split("-")[0]?.toUpperCase();
    if (prefix === undefined) throw invalid("Invalid voucher code", "voucher.redeem");
    const normalized = await normalizeSecret(input.code, prefix, this.#options.crypto);
    const redemption: Omit<VoucherRedemption, "voucherId"> = {
      id: parseId<"RedemptionId">(this.#options.ids.next("red"), "red"),
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      beneficiaryRef: input.beneficiaryRef,
      ...(input.value === undefined ? {} : { value: input.value }),
      redeemedAt: this.#options.clock.now(),
    };
    const result = await this.#options.store.redeemVoucher({
      tenantId: input.tenantId,
      digest: await this.#options.crypto.digest(normalized),
      redemption,
      now: this.#options.clock.now(),
    });
    if (result.kind === "redeemed" || result.kind === "replay") {
      const batch = await this.#options.store.getVoucherBatch(
        input.tenantId,
        result.voucher.batchId,
      );
      if (batch === undefined)
        throw new PolybillError("Voucher batch is missing", {
          code: "conflict",
          operation: "voucher.deliver_benefit",
          retryable: true,
        });
      if (batch.benefit.kind === "credit") return { redemption: result.redemption };
      const entitlementGrant = await this.#entitlements.grant({
        tenantId: input.tenantId,
        idempotencyKey: `voucher:${result.redemption.id}`,
        policyId: batch.benefit.policyId,
        beneficiaryRef: input.beneficiaryRef,
        source: "voucher",
        sourceRef: result.redemption.id,
      });
      return { redemption: result.redemption, entitlementGrant };
    }
    throw new PolybillError(`Voucher redemption failed: ${result.kind}`, {
      code:
        result.kind === "not_found"
          ? "not_found"
          : result.kind === "conflict"
            ? "idempotency_conflict"
            : "conflict",
      operation: "voucher.redeem",
      retryable: false,
    });
  }
}

function aad(tenantId: TenantId, voucherId: string): string {
  return `${tenantId}:${voucherId}:voucher:v1`;
}
function integer(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw invalid(`Invalid voucher ${name}`, "voucher.create_batch");
}
function invalid(message: string, operation: string): PolybillError {
  return new PolybillError(message, { code: "invalid_request", operation, retryable: false });
}
