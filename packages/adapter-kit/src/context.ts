import type {
  Clock,
  ConnectionRef,
  IdempotencyKey,
  IsoDateTime,
  RequestId,
  TenantId,
} from "@polybill/core";

export type ResolvedCredentials = Readonly<Record<string, string>>;
export type CredentialResolver = () => ResolvedCredentials | Promise<ResolvedCredentials>;

export interface CryptoPort {
  sha256(value: Uint8Array): Promise<string>;
  randomBytes(length: number): Uint8Array;
  timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;
}

export interface ProviderContext {
  readonly tenantId: TenantId;
  readonly connection: ConnectionRef;
  readonly credentials: ResolvedCredentials;
  readonly requestId: RequestId;
  readonly idempotencyKey?: IdempotencyKey;
  readonly deadline: IsoDateTime;
  readonly fetch: typeof globalThis.fetch;
  readonly crypto: CryptoPort;
  readonly clock: Clock;
}
