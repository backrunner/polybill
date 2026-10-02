import type {
  CapabilityKey,
  CredentialResolver,
  CryptoPort,
  ProviderAdapter,
  ProviderContext,
} from "@polybill/adapter-kit";
import {
  PolybillError,
  parseId,
  parseIsoDateTime,
  type Clock,
  type ConnectionRef,
  type IdempotencyKey,
  type TenantId,
} from "@polybill/core";
import { stableStringify } from "./checkout-helpers.js";
import type { ApplicationStore, IdGenerator, Logger } from "./ports.js";
import { trackMutation } from "./mutation-attempt.js";

export interface ResourceRuntimeOptions {
  readonly tenantId: TenantId;
  readonly connection: ConnectionRef;
  readonly credentials: ProviderContext["credentials"] | CredentialResolver;
  readonly adapter: ProviderAdapter;
  readonly store: ApplicationStore;
  readonly crypto: CryptoPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly fetch: typeof globalThis.fetch;
  readonly logger: Logger;
  readonly timeoutMs?: number;
}

export class ResourceRuntime {
  readonly options: ResourceRuntimeOptions;

  constructor(options: ResourceRuntimeOptions) {
    if (
      options.tenantId !== options.connection.tenantId ||
      options.adapter.descriptor.name !== options.connection.provider
    )
      throw new PolybillError("Connection does not match the requested tenant and provider", {
        code: "invalid_request",
        operation: "resource.initialize",
        retryable: false,
      });
    this.options = options;
  }

  async context(idempotencyKey?: IdempotencyKey): Promise<ProviderContext> {
    await this.options.store.bindConnection(this.options.connection);
    const credentials =
      typeof this.options.credentials === "function"
        ? await this.options.credentials()
        : this.options.credentials;
    const now = this.options.clock.now();
    return {
      tenantId: this.options.tenantId,
      connection: this.options.connection,
      credentials,
      requestId: parseId<"RequestId">(this.options.ids.next("req"), "req"),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      deadline: parseIsoDateTime(
        new Date(Date.parse(now) + (this.options.timeoutMs ?? 10_000)).toISOString(),
      ),
      fetch: this.options.fetch,
      crypto: this.options.crypto,
      clock: this.options.clock,
    };
  }

  async requireCapability(key: CapabilityKey, context: ProviderContext): Promise<void> {
    const capability = (await this.options.adapter.getCapabilities(context)).capabilities[key];
    if (capability === undefined) throw unsupported(this.options.connection, key);
    if (capability.support === "unsupported")
      throw unsupported(this.options.connection, key, capability.reason);
    if (!capability.environments.includes(this.options.connection.environment))
      throw unsupported(
        this.options.connection,
        key,
        "Capability is unavailable in this environment",
      );
  }

  async mutate<T>(input: {
    readonly operation: string;
    readonly key: IdempotencyKey;
    readonly payload: unknown;
    readonly execute: (context: ProviderContext) => Promise<T>;
    readonly decodeReplay: (value: unknown) => T;
  }): Promise<T> {
    const scope = {
      tenantId: this.options.tenantId,
      connectionId: this.options.connection.id,
      operation: input.operation,
      key: input.key,
    } as const;
    const payloadHash = await this.options.crypto.sha256(
      new TextEncoder().encode(stableStringify(input.payload)),
    );
    const context = await this.context(input.key);
    const claim = await this.options.store.claim(scope, payloadHash);
    if (claim.kind === "replay") return input.decodeReplay(claim.result);
    if (claim.kind === "conflict")
      throw commandError("idempotency_conflict", input.operation, this.options.connection, false);
    if (claim.kind === "in_progress")
      throw commandError("conflict", input.operation, this.options.connection, true);
    if (claim.kind === "outcome_unknown")
      throw commandError("outcome_unknown", input.operation, this.options.connection, true);
    let markerAttempted = false;
    const attempt = trackMutation(context, async () => {
      markerAttempted = true;
      await this.options.store.markUnknown(scope, claim.leaseToken);
    });
    let executed = false;
    try {
      const result = await input.execute(attempt.context);
      executed = true;
      await this.options.store.complete(scope, claim.leaseToken, result);
      return result;
    } catch (error) {
      // A failed marker write may itself have committed; never release or send again blindly.
      if (markerAttempted) throw error;
      if (
        attempt.mayHaveMutated() ||
        executed ||
        (error instanceof PolybillError &&
          (error.code === "outcome_unknown" || error.code === "provider_unavailable"))
      )
        await this.options.store.markUnknown(
          scope,
          claim.leaseToken,
          error instanceof PolybillError ? error.evidenceRef : undefined,
        );
      else await this.options.store.release(scope, claim.leaseToken);
      throw error;
    }
  }
}

export function requireExternalId(value: string | undefined, operation: string): string {
  if (value === undefined)
    throw new PolybillError("Canonical resource has no mapping for this provider connection", {
      code: "not_found",
      operation,
      retryable: false,
    });
  return value;
}

function unsupported(
  connection: ConnectionRef,
  key: CapabilityKey,
  reason?: string,
): PolybillError {
  return new PolybillError(reason ?? `Provider does not support ${key}`, {
    code: "unsupported_capability",
    operation: key,
    provider: connection.provider,
    connectionId: connection.id,
    retryable: false,
  });
}

function commandError(
  code: "idempotency_conflict" | "conflict" | "outcome_unknown",
  operation: string,
  connection: ConnectionRef,
  retryable: boolean,
): PolybillError {
  return new PolybillError(`Resource command failed: ${code}`, {
    code,
    operation,
    provider: connection.provider,
    connectionId: connection.id,
    retryable,
  });
}
