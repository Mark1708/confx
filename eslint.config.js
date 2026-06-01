import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const warnRules = (rules) =>
  Object.fromEntries(
    Object.entries(rules).map(([ruleName, ruleConfig]) => {
      if (ruleConfig === "off" || ruleConfig === 0) {
        return [ruleName, ruleConfig];
      }

      if (Array.isArray(ruleConfig)) {
        return [ruleName, ["warn", ...ruleConfig.slice(1)]];
      }

      return [ruleName, "warn"];
    }),
  );

export default [
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "release/",
      "scripts/",
      "*.js",
      "src/manifest.js",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ...js.configs.recommended,
    rules: warnRules(js.configs.recommended.rules),
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      ...warnRules(config.rules ?? {}),
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  })),
  {
    files: ["src/**/*.tsx"],
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      prettier: prettierPlugin,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...warnRules(react.configs.recommended.rules),
      ...warnRules(react.configs["jsx-runtime"].rules),
      ...warnRules(reactHooks.configs.recommended.rules),
      "react-refresh/only-export-components": "warn",
      "prettier/prettier": "warn",
    },
  },
  prettierConfig,
];
