import { defineConfig } from "vitest/config";

const include = ["packages/**/*.test.ts", "apps/**/*.test.ts"];
const generated = ["**/node_modules/**", "**/dist/**"];

export default defineConfig({
  test: {
    coverage: { enabled: false },
    projects: [
      {
        test: {
          name: "unit",
          include,
          exclude: [...generated, "**/*.contract.test.ts", "**/*.workerd.test.ts"],
        },
      },
      { test: { name: "contract", include: ["**/*.contract.test.ts"], exclude: generated } },
      { test: { name: "migration", include: ["**/*.migration.test.ts"], exclude: generated } },
      { test: { name: "security", include: ["**/*.security.test.ts"], exclude: generated } },
      { test: { name: "workerd", include: ["**/*.workerd.test.ts"], exclude: generated } },
    ],
  },
});
