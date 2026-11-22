import type { ConnectionRef, ProviderName } from "@polybill/core";
import { invalid } from "./codecs.js";
import type { ProviderContext } from "./context.js";

export type ModerationDecision = "allow" | "flag" | "deny";

export type ModerationInput = (
  | { readonly text: string; readonly image?: string }
  | { readonly text?: string; readonly image: string }
) & { readonly reference?: string };

/** Server-side evidence to be passed back to the issuing provider. */
export interface ModerationReceipt {
  readonly connection: ConnectionRef;
  readonly providerResultId: string;
  readonly reference?: string;
}

export interface ModerationResult {
  readonly decision: ModerationDecision;
  readonly receipt?: ModerationReceipt;
  readonly usageUnits?: number;
}

export interface ModerationProvider {
  readonly name: ProviderName;
  readonly media: readonly ("text" | "image")[];
  screen(
    context: ProviderContext,
    input: ModerationInput,
  ): Promise<{
    readonly decision: ModerationDecision;
    readonly resultId?: string;
    readonly usageUnits?: number;
  }>;
}

export function moderationDecision(value: unknown, provider: ProviderName): ModerationDecision {
  if (value === "allow" || value === "flag" || value === "deny") return value;
  throw invalid(provider, "moderation.screen.decode");
}
