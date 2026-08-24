import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const forbidden =
  /(?:from\s*|import\s*\()?["'](?:node:|fs(?:\/|["'])|net(?:\/|["'])|tls(?:\/|["'])|child_process(?:\/|["']))/;
const roots = ["packages", "apps"];
const violations = [];

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".wrangler") continue;
      await walk(path);
    } else if (path.includes("/dist/") && [".js", ".mjs"].includes(extname(path))) {
      const source = await readFile(path, "utf8");
      if (forbidden.test(source)) violations.push(path);
    }
  }
}

for (const root of roots) await walk(root);
if (violations.length > 0) {
  throw new Error(`Worker-incompatible imports found:\n${violations.join("\n")}`);
}
console.log("Worker bundle import scan passed.");
