import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const correctnessRules = {
  ...js.configs.recommended.rules,

  // TypeScript and the existing environment declarations cover these checks.
  // Keeping them here would duplicate typecheck and flag legitimate browser,
  // Node.js, Vitest, migration and generated-runtime globals.
  "no-undef": "off",
  "no-unused-vars": "off",

  // The project intentionally uses control-character sanitizers, best-effort
  // catch blocks and compatibility regexes. These generic rules create false
  // positives there; typecheck and focused tests remain authoritative.
  "no-control-regex": "off",
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-useless-assignment": "off",
  "no-useless-escape": "off",
  "preserve-caught-error": "off",
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/generated/**",
      ".impeccable/**",
      ".tools/**",
      "attached_assets/**",
      "output/**",
      "work/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    languageOptions: {
      ecmaVersion: "latest",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      sourceType: "module",
    },
    rules: correctnessRules,
  },
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // TypeScript overloads and declarations are valid duplicates/redeclarations.
      "no-dupe-class-members": "off",
      "no-redeclare": "off",
    },
  },
  {
    files: ["**/*.{jsx,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
