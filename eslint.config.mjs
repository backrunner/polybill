import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["**/dist/**", "**/coverage/**", "**/.wrangler/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "Runtime packages target Cloudflare Workers; isolate Node APIs in an explicit /node subpath.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    rules: { "no-restricted-imports": "off", "no-undef": "off" },
  },
  {
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  prettier,
];
