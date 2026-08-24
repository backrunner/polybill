import type {
  ArchiveDiscountResult,
  CreateDiscountResult,
  DiscountStore,
} from "@polybill/application";
import type { Discount, DiscountId, IdempotencyKey, TenantId } from "@polybill/core";

interface Issuance {
  readonly payloadHash: string;
  readonly discount: Discount;
}

export class MemoryDiscountStore implements DiscountStore {
  readonly #discounts = new Map<string, Discount>();
  readonly #codes = new Map<string, DiscountId>();
  readonly #issuance = new Map<string, Issuance>();
  readonly #actions = new Map<string, Issuance>();

  async createDiscount(
    tenantId: TenantId,
    discount: Discount,
    idempotencyKey: IdempotencyKey,
    payloadHash: string,
  ): Promise<CreateDiscountResult> {
    const issuance = this.#issuance.get(`${tenantId}:${idempotencyKey}`);
    if (issuance !== undefined) return replayCreate(issuance, payloadHash);
    if (this.#codes.has(`${tenantId}:${discount.code}`)) return { kind: "conflict" };
    this.#discounts.set(`${tenantId}:${discount.id}`, clone(discount));
    this.#codes.set(`${tenantId}:${discount.code}`, discount.id);
    this.#issuance.set(`${tenantId}:${idempotencyKey}`, {
      payloadHash,
      discount: clone(discount),
    });
    return { kind: "created", discount: clone(discount) };
  }

  async getDiscount(tenantId: TenantId, discountId: DiscountId): Promise<Discount | undefined> {
    const discount = this.#discounts.get(`${tenantId}:${discountId}`);
    return discount === undefined ? undefined : clone(discount);
  }

  async findDiscountByCode(tenantId: TenantId, code: string): Promise<Discount | undefined> {
    const id = this.#codes.get(`${tenantId}:${code}`);
    return id === undefined ? undefined : this.getDiscount(tenantId, id);
  }

  async archiveDiscount(
    input: Parameters<DiscountStore["archiveDiscount"]>[0],
  ): Promise<ArchiveDiscountResult> {
    const actionKey = `${input.tenantId}:${input.idempotencyKey}`;
    const action = this.#actions.get(actionKey);
    if (action !== undefined)
      return action.payloadHash === input.payloadHash
        ? { kind: "replay", discount: clone(action.discount) }
        : { kind: "conflict" };
    const key = `${input.tenantId}:${input.discountId}`;
    const current = this.#discounts.get(key);
    if (current === undefined) return { kind: "not_found" };
    const archived: Discount = { ...current, status: "archived" };
    this.#discounts.set(key, clone(archived));
    this.#actions.set(actionKey, { payloadHash: input.payloadHash, discount: clone(archived) });
    return { kind: "archived", discount: clone(archived) };
  }
}

export function createMemoryDiscountStore(): MemoryDiscountStore {
  return new MemoryDiscountStore();
}

function replayCreate(issuance: Issuance, payloadHash: string): CreateDiscountResult {
  return issuance.payloadHash === payloadHash
    ? { kind: "replay", discount: clone(issuance.discount) }
    : { kind: "conflict" };
}

function clone<T>(value: T): T {
  return globalThis.structuredClone(value);
}
