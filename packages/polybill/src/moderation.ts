import {
  createWebCryptoPort,
  invalid,
  moderationDecision,
  type CredentialResolver,
  type ModerationInput,
  type ModerationProvider,
  type ModerationResult,
  type ResolvedCredentials,
} from "@polybill/adapter-kit";
import {
  parseId,
  parseIsoDateTime,
  PolybillError,
  type Clock,
  type ConnectionRef,
} from "@polybill/core";
import { SecureIdGenerator, systemClock } from "./runtime.js";

export type {
  ModerationDecision,
  ModerationInput,
  ModerationProvider,
  ModerationReceipt,
  ModerationResult,
} from "@polybill/adapter-kit";

export interface ModerationOptions {
  readonly connection: ConnectionRef;
  readonly credentials: ResolvedCredentials | CredentialResolver;
  readonly provider: ModerationProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
}

export interface ModerationClient {
  screen(input: ModerationInput): Promise<ModerationResult>;
}

export function createModeration(options: ModerationOptions): ModerationClient {
  const connection = { ...options.connection };
  parseId<"TenantId">(connection.tenantId, "ten");
  parseId<"ConnectionId">(connection.id, "conn");
  if (connection.provider !== options.provider.name)
    throw new TypeError("Moderation provider does not match the connection");
  if (connection.environment !== "test" && connection.environment !== "live")
    throw new TypeError("Invalid moderation environment");
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new RangeError("Invalid moderation timeout");
  const crypto = createWebCryptoPort();
  const ids = new SecureIdGenerator(crypto);
  const clock = options.clock ?? systemClock;
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    async screen(input) {
      validateInput(input, options.provider, connection);
      const credentials =
        typeof options.credentials === "function"
          ? await options.credentials()
          : options.credentials;
      const result = await options.provider.screen(
        {
          tenantId: connection.tenantId,
          connection,
          credentials,
          requestId: parseId<"RequestId">(ids.next("req"), "req"),
          deadline: parseIsoDateTime(new Date(Date.parse(clock.now()) + timeoutMs).toISOString()),
          fetch,
          clock,
          crypto,
        },
        input,
      );
      const decision = moderationDecision(result.decision, connection.provider);
      if (
        result.resultId !== undefined &&
        (typeof result.resultId !== "string" || result.resultId.length === 0)
      )
        throw invalid(connection.provider, "moderation.screen.decode");
      if (
        result.usageUnits !== undefined &&
        (!Number.isSafeInteger(result.usageUnits) || result.usageUnits < 0)
      )
        throw invalid(connection.provider, "moderation.screen.decode");
      return {
        decision,
        ...(decision !== "allow" || result.resultId === undefined
          ? {}
          : {
              receipt: {
                connection: { ...connection },
                providerResultId: result.resultId,
                ...(input.reference === undefined ? {} : { reference: input.reference }),
              },
            }),
        ...(result.usageUnits === undefined ? {} : { usageUnits: result.usageUnits }),
      };
    },
  };
}

function validateInput(
  input: ModerationInput,
  provider: ModerationProvider,
  connection: ConnectionRef,
) {
  if (
    typeof input !== "object" ||
    input === null ||
    (input.text === undefined && input.image === undefined) ||
    (input.text !== undefined &&
      (typeof input.text !== "string" || input.text.trim().length === 0)) ||
    (input.image !== undefined &&
      (typeof input.image !== "string" || input.image.trim().length === 0)) ||
    (input.reference !== undefined &&
      (typeof input.reference !== "string" ||
        input.reference.length === 0 ||
        /\p{Cc}/u.test(input.reference)))
  )
    throw new PolybillError("Invalid moderation input", {
      code: "invalid_request",
      operation: "moderation.screen",
      connectionId: connection.id,
      provider: connection.provider,
      retryable: false,
    });
  if (
    (input.text !== undefined && !provider.media.includes("text")) ||
    (input.image !== undefined && !provider.media.includes("image"))
  )
    throw new PolybillError("Moderation provider does not support the supplied media", {
      code: "unsupported_capability",
      operation: "moderation.screen",
      connectionId: connection.id,
      provider: connection.provider,
      retryable: false,
    });
}
