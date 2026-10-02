import { createHash } from "node:crypto";

// SDK examples change independently of the wire contract.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "x-codeSamples")
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

function hash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function polarApiSurface(schema, operations, webhookSchemas) {
  const hashes = {};
  const visited = new Set();
  function includeSchema(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const definition = schema.components?.schemas?.[name];
    if (definition === undefined) throw new Error(`Missing schema: ${name}`);
    hashes[`schema:${name}`] = hash(definition);
    visit(definition);
  }
  function visit(value) {
    if (value === null || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      const prefix = "#/components/schemas/";
      if (!value.$ref.startsWith(prefix)) throw new Error("Unsupported OpenAPI reference");
      includeSchema(value.$ref.slice(prefix.length));
    }
    for (const [key, child] of Object.entries(value)) if (key !== "x-codeSamples") visit(child);
  }
  for (const { method, path } of operations) {
    const operation = schema.paths?.[path]?.[method];
    if (operation === undefined) throw new Error(`Missing operation: ${method} ${path}`);
    const contract = { operation, parameters: schema.paths[path].parameters ?? [] };
    hashes[`${method.toUpperCase()} ${path}`] = hash(contract);
    visit(contract);
  }
  for (const name of webhookSchemas) includeSchema(name);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b, "en")));
}
