import type { MigrationPage, ProviderSourceScanner } from "./ports.js";
import type { MigrationEntityType } from "./types.js";

export interface AnalyzeResult {
  readonly counts: Readonly<Partial<Record<MigrationEntityType, number>>>;
  readonly samples: Readonly<
    Partial<Record<MigrationEntityType, readonly Readonly<Record<string, unknown>>[]>>
  >;
}

export async function analyzeSource(
  scanner: ProviderSourceScanner,
  entityTypes: readonly MigrationEntityType[],
  sampleLimit = 10,
): Promise<AnalyzeResult> {
  const counts: Partial<Record<MigrationEntityType, number>> = {};
  const samples: Partial<
    Record<MigrationEntityType, readonly Readonly<Record<string, unknown>>[]>
  > = {};
  for (const type of entityTypes) {
    let cursor: string | undefined;
    let count = 0;
    const selected: Readonly<Record<string, unknown>>[] = [];
    do {
      const page: MigrationPage = await scanner.scan(type, cursor);
      count += page.items.length;
      selected.push(...page.items.slice(0, Math.max(0, sampleLimit - selected.length)).map(redact));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    counts[type] = count;
    samples[type] = selected;
  }
  return { counts, samples };
}

const sensitiveKey = /(email|name|address|phone|token|secret|license.?key|api.?key|signature)/i;

function redact(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactValue(item),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object")
    return redact(value as Readonly<Record<string, unknown>>);
  return value;
}
