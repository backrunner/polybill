import {
  PolybillError,
  parseId,
  type Clock,
  type EntitlementGrantId,
  type EntitlementPolicyId,
  type IsoDateTime,
  type TenantId,
} from "@polybill/core";
import type { EntitlementGrant, EntitlementPolicy } from "./domain.js";
import type { EntitlementStore, LicensingIds, SecretCrypto } from "./ports.js";

export interface EntitlementServiceOptions {
  readonly store: EntitlementStore;
  readonly crypto: Pick<SecretCrypto, "hash">;
  readonly ids: LicensingIds;
  readonly clock: Clock;
}

export interface CreateEntitlementPolicyCommand {
  readonly tenantId: TenantId;
  readonly idempotencyKey: string;
  readonly benefit: string;
  readonly revokeOn: EntitlementPolicy["revokeOn"];
  readonly gracePeriodSeconds: number;
}

export interface GrantEntitlementCommand {
  readonly tenantId: TenantId;
  readonly idempotencyKey: string;
  readonly policyId: EntitlementPolicyId;
  readonly source: EntitlementGrant["source"];
  readonly sourceRef: string;
  readonly expiresAt?: IsoDateTime;
}

export class EntitlementService {
  readonly #options: EntitlementServiceOptions;

  constructor(options: EntitlementServiceOptions) {
    this.#options = options;
  }

  async createPolicy(command: CreateEntitlementPolicyCommand): Promise<EntitlementPolicy> {
    idempotencyKey(command.idempotencyKey, "entitlement.policy.create");
    text(command.benefit, "benefit", "entitlement.policy.create");
    if (!(["refund", "subscription_end", "never"] as const).includes(command.revokeOn))
      throw invalid("Invalid entitlement revocation policy", "entitlement.policy.create");
    if (
      !Number.isSafeInteger(command.gracePeriodSeconds) ||
      command.gracePeriodSeconds < 0 ||
      command.gracePeriodSeconds > 31_536_000
    )
      throw invalid(
        "Grace period must be between 0 and 31536000 seconds",
        "entitlement.policy.create",
      );
    const payloadHash = await this.#options.crypto.hash(
      JSON.stringify([command.benefit, command.revokeOn, command.gracePeriodSeconds]),
    );
    const policy: EntitlementPolicy = {
      id: parseId<"EntitlementPolicyId">(this.#options.ids.next("epol"), "epol"),
      benefit: command.benefit,
      revokeOn: command.revokeOn,
      gracePeriodSeconds: command.gracePeriodSeconds,
    };
    const result = await this.#options.store.createEntitlementPolicy(
      command.tenantId,
      policy,
      command.idempotencyKey,
      payloadHash,
    );
    if (result.kind === "conflict")
      throw conflict("Policy idempotency key conflict", "entitlement.policy.create");
    return result.policy;
  }

  async getPolicy(tenantId: TenantId, policyId: EntitlementPolicyId): Promise<EntitlementPolicy> {
    const policy = await this.#options.store.getEntitlementPolicy(tenantId, policyId);
    if (policy === undefined)
      throw notFound("Entitlement policy was not found", "entitlement.policy.get");
    return policy;
  }

  async grant(command: GrantEntitlementCommand): Promise<EntitlementGrant> {
    idempotencyKey(command.idempotencyKey, "entitlement.grant.create");
    text(command.sourceRef, "source reference", "entitlement.grant.create");
    if (
      !(["order", "subscription", "manual", "voucher", "migration"] as const).includes(
        command.source,
      )
    )
      throw invalid("Invalid entitlement source", "entitlement.grant.create");
    if (
      command.expiresAt !== undefined &&
      (!Number.isFinite(Date.parse(command.expiresAt)) ||
        Date.parse(command.expiresAt) <= Date.parse(this.#options.clock.now()))
    )
      throw invalid("Grant expiry must be in the future", "entitlement.grant.create");
    const payloadHash = await this.#options.crypto.hash(
      JSON.stringify([
        command.policyId,
        command.source,
        command.sourceRef,
        command.expiresAt ?? null,
      ]),
    );
    const now = this.#options.clock.now();
    const grant: EntitlementGrant = {
      id: parseId<"EntitlementGrantId">(this.#options.ids.next("grant"), "grant"),
      tenantId: command.tenantId,
      policyId: command.policyId,
      source: command.source,
      sourceRef: command.sourceRef,
      status: "active",
      grantedAt: now,
      updatedAt: now,
      ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
    };
    const result = await this.#options.store.createEntitlementGrant(
      grant,
      command.idempotencyKey,
      payloadHash,
    );
    if (result.kind === "policy_not_found")
      throw notFound("Entitlement policy was not found", "entitlement.grant.create");
    if (result.kind === "conflict")
      throw conflict("Grant idempotency or source conflict", "entitlement.grant.create");
    return result.grant;
  }

  async get(tenantId: TenantId, grantId: EntitlementGrantId): Promise<EntitlementGrant> {
    const grant = await this.#options.store.getEntitlementGrant(tenantId, grantId);
    if (grant === undefined)
      throw notFound("Entitlement grant was not found", "entitlement.grant.get");
    return grant;
  }

  suspend(tenantId: TenantId, grantId: EntitlementGrantId, idempotencyKeyValue: string) {
    return this.#transition(
      tenantId,
      grantId,
      idempotencyKeyValue,
      ["active"],
      "suspended",
      "suspend",
    );
  }

  restore(tenantId: TenantId, grantId: EntitlementGrantId, idempotencyKeyValue: string) {
    return this.#transition(
      tenantId,
      grantId,
      idempotencyKeyValue,
      ["suspended"],
      "active",
      "restore",
    );
  }

  revoke(tenantId: TenantId, grantId: EntitlementGrantId, idempotencyKeyValue: string) {
    return this.#transition(
      tenantId,
      grantId,
      idempotencyKeyValue,
      ["pending", "active", "suspended"],
      "revoked",
      "revoke",
    );
  }

  async #transition(
    tenantId: TenantId,
    grantId: EntitlementGrantId,
    key: string,
    expectedStatuses: readonly EntitlementGrant["status"][],
    status: EntitlementGrant["status"],
    action: string,
  ): Promise<EntitlementGrant> {
    const operation = `entitlement.grant.${action}`;
    idempotencyKey(key, operation);
    const result = await this.#options.store.transitionEntitlementGrant({
      tenantId,
      grantId,
      expectedStatuses,
      status,
      idempotencyKey: key,
      updatedAt: this.#options.clock.now(),
    });
    if (result.kind === "changed" || result.kind === "replay") return result.grant;
    if (result.kind === "not_found") throw notFound("Entitlement grant was not found", operation);
    if (result.kind === "conflict")
      throw conflict("Grant transition idempotency conflict", operation);
    throw new PolybillError(`Cannot ${action} an entitlement grant from its current status`, {
      code: "conflict",
      operation,
      retryable: false,
    });
  }
}

function idempotencyKey(value: string, operation: string): void {
  if (!/^[\x21-\x7e]{8,255}$/.test(value)) throw invalid("Invalid idempotency key", operation);
}

function text(value: string, name: string, operation: string): void {
  if (value.length < 1 || value.length > 255) throw invalid(`Invalid ${name}`, operation);
}

function invalid(message: string, operation: string): PolybillError {
  return new PolybillError(message, { code: "invalid_request", operation, retryable: false });
}

function conflict(message: string, operation: string): PolybillError {
  return new PolybillError(message, { code: "idempotency_conflict", operation, retryable: false });
}

function notFound(message: string, operation: string): PolybillError {
  return new PolybillError(message, { code: "not_found", operation, retryable: false });
}
