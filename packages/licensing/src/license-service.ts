import {
  PolybillError,
  parseId,
  type Clock,
  type CustomerId,
  type EntitlementGrantId,
  type IsoDateTime,
  type TenantId,
} from "@polybill/core";
import { generateSecret, normalizeSecret } from "./keys.js";
import type { LicenseInstance, LicenseRecord } from "./domain.js";
import type { LicenseStore, LicensingIds, SecretCrypto } from "./ports.js";

export interface LicenseServiceOptions {
  readonly store: LicenseStore;
  readonly crypto: SecretCrypto;
  readonly ids: LicensingIds;
  readonly clock: Clock;
}

export interface IssueLicenseCommand {
  readonly tenantId: TenantId;
  readonly grantId: EntitlementGrantId;
  readonly issuanceKey: string;
  readonly activationLimit: number;
  readonly ownerRef?: CustomerId;
  readonly expiresAt?: IsoDateTime;
}

export class LicenseService {
  readonly #options: LicenseServiceOptions;

  constructor(options: LicenseServiceOptions) {
    this.#options = options;
  }

  async issue(command: IssueLicenseCommand): Promise<{
    readonly license: LicenseRecord;
    readonly key: string;
    readonly replayed: boolean;
  }> {
    if (!Number.isSafeInteger(command.activationLimit) || command.activationLimit < 1)
      throw invalid("Activation limit must be a positive safe integer", "license.issue");
    if (command.issuanceKey.length < 8 || command.issuanceKey.length > 255)
      throw invalid("Invalid issuance key", "license.issue");
    const payloadHash = await this.#options.crypto.hash(
      JSON.stringify([
        command.grantId,
        command.activationLimit,
        command.ownerRef ?? null,
        command.expiresAt ?? null,
      ]),
    );
    const id = parseId<"LicenseId">(this.#options.ids.next("lic"), "lic");
    const key = await generateSecret("PB1", this.#options.crypto);
    const normalized = await normalizeSecret(key, "PB1", this.#options.crypto);
    const record: LicenseRecord = {
      id,
      tenantId: command.tenantId,
      digest: await this.#options.crypto.digest(normalized),
      encryptedValue: await this.#options.crypto.encrypt(key, aad(command.tenantId, id)),
      status: "active",
      activationLimit: command.activationLimit,
      ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
      ...(command.ownerRef === undefined ? {} : { ownerRef: command.ownerRef }),
      grantId: command.grantId,
      issuedAt: this.#options.clock.now(),
    };
    const result = await this.#options.store.issueLicense(record, command.issuanceKey, payloadHash);
    if (result.kind === "conflict")
      throw conflict("Issuance key was used with a different payload", "license.issue");
    return {
      license: result.record,
      key:
        result.kind === "created"
          ? key
          : await this.#options.crypto.decrypt(
              result.record.encryptedValue,
              aad(command.tenantId, result.record.id),
            ),
      replayed: result.kind === "replay",
    };
  }

  async activate(input: {
    readonly tenantId: TenantId;
    readonly key: string;
    readonly instanceRef: string;
    readonly deviceFingerprint: string;
  }): Promise<LicenseInstance> {
    text(input.instanceRef, "instance reference");
    text(input.deviceFingerprint, "device fingerprint");
    const normalized = await normalizeSecret(input.key, "PB1", this.#options.crypto);
    const instance: Omit<LicenseInstance, "licenseId"> = {
      id: parseId<"LicenseInstanceId">(this.#options.ids.next("lins"), "lins"),
      tenantId: input.tenantId,
      instanceRef: input.instanceRef,
      deviceDigest: await this.#options.crypto.digest(`device:${input.deviceFingerprint}`),
      activatedAt: this.#options.clock.now(),
      lastValidatedAt: this.#options.clock.now(),
    };
    const result = await this.#options.store.activateLicense({
      tenantId: input.tenantId,
      digest: await this.#options.crypto.digest(normalized),
      instance,
      now: this.#options.clock.now(),
    });
    if (result.kind === "activated" || result.kind === "replay") return result.instance;
    throw new PolybillError(`License activation failed: ${result.kind}`, {
      code: result.kind === "not_found" ? "not_found" : "conflict",
      operation: "license.activate",
      retryable: false,
    });
  }

  async validate(input: {
    readonly tenantId: TenantId;
    readonly key: string;
  }): Promise<LicenseRecord | undefined> {
    const normalized = await normalizeSecret(input.key, "PB1", this.#options.crypto);
    const found = await this.#options.store.findLicense(
      input.tenantId,
      await this.#options.crypto.digest(normalized),
    );
    if (found === undefined || found.status !== "active") return undefined;
    if (
      found.expiresAt !== undefined &&
      Date.parse(found.expiresAt) <= Date.parse(this.#options.clock.now())
    )
      return undefined;
    return found;
  }
}

function aad(tenantId: TenantId, licenseId: string): string {
  return `${tenantId}:${licenseId}:license:v1`;
}
function text(value: string, name: string): void {
  if (value.length < 1 || value.length > 200) throw invalid(`Invalid ${name}`, "license.activate");
}
function invalid(message: string, operation: string): PolybillError {
  return new PolybillError(message, { code: "invalid_request", operation, retryable: false });
}
function conflict(message: string, operation: string): PolybillError {
  return new PolybillError(message, { code: "idempotency_conflict", operation, retryable: false });
}
