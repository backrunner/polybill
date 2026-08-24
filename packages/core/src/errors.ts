import type { ConnectionId, EvidenceId } from "./ids.js";
import type { ProviderName } from "./provider.js";

export type PolybillErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_response_invalid"
  | "unsupported_capability"
  | "commercial_policy_incompatible"
  | "idempotency_conflict"
  | "outcome_unknown"
  | "signature_invalid"
  | "replay_rejected";

export interface PolybillErrorOptions {
  readonly code: PolybillErrorCode;
  readonly operation: string;
  readonly retryable: boolean;
  readonly provider?: ProviderName;
  readonly connectionId?: ConnectionId;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;
  readonly evidenceRef?: EvidenceId;
  readonly cause?: unknown;
}

export class PolybillError extends Error {
  readonly code: PolybillErrorCode;
  readonly operation: string;
  readonly retryable: boolean;
  readonly provider?: ProviderName;
  readonly connectionId?: ConnectionId;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;
  readonly evidenceRef?: EvidenceId;

  constructor(message: string, options: PolybillErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "PolybillError";
    this.code = options.code;
    this.operation = options.operation;
    this.retryable = options.retryable;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.connectionId !== undefined) this.connectionId = options.connectionId;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
    if (options.evidenceRef !== undefined) this.evidenceRef = options.evidenceRef;
  }
}
