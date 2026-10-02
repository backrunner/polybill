import { readFile } from "node:fs/promises";
import { polarApiSurface } from "./polar-api-surface.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const version = args[0] ?? "2026-10";
if (args.length > 1 || !["2026-10", "2027-01"].includes(version))
  throw new Error(
    "Usage: pnpm check:polar-api [2026-10|2027-01]; unreviewed versions need a separate review",
  );
const baseline = JSON.parse(
  await readFile(
    new URL(
      `../packages/provider-polar/fixtures/api-contract${version === "2026-10" ? "" : `-${version}`}.json`,
      import.meta.url,
    ),
    "utf8",
  ),
);
if (baseline.apiVersion !== version) throw new Error("Reviewed baseline version mismatch");

try {
  const url = `https://raw.githubusercontent.com/polarsource/polar/main/docs/openapi/${version}.openapi.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error(`Official schema request failed: HTTP ${response.status}`);
  const schema = await response.json();
  if (schema.info?.version !== version) throw new Error("Official schema version mismatch");
  const actual = polarApiSurface(schema, baseline.operations, baseline.webhookSchemas);
  const changed = [...new Set([...Object.keys(baseline.hashes), ...Object.keys(actual)])].filter(
    (key) => actual[key] !== baseline.hashes[key],
  );
  if (changed.length > 0) {
    console.error(`Polar ${version}: ${changed.length} reviewed contract entries differ:`);
    for (const key of changed) console.error(`  ${key}`);
    process.exitCode = 1;
  } else {
    console.log(`Polar ${version}: ${Object.keys(actual).length} reviewed contract entries match.`);
  }
  console.log(
    "Read-only schema comparison; no sandbox proof, endpoint upgrade, or automatic version adoption.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Polar schema comparison failed");
  process.exitCode = 1;
}
