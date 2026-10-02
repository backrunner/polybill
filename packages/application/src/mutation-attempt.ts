import type { ProviderContext } from "@polybill/adapter-kit";

/** Track transport, including failures before an adapter can decode its response. */
export function trackMutation(
  context: ProviderContext,
  beforeMutation?: () => Promise<void>,
): {
  readonly context: ProviderContext;
  mayHaveMutated(): boolean;
} {
  let uncertain = false;
  let recorded: Promise<void> | undefined;
  return {
    context: {
      ...context,
      fetch: async (input, init) => {
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        if (method === "GET" || method === "HEAD") return context.fetch(input, init);
        uncertain = true;
        if (beforeMutation !== undefined) {
          recorded ??= beforeMutation();
          await recorded;
        }
        return context.fetch(input, init);
      },
    },
    mayHaveMutated: () => uncertain,
  };
}
