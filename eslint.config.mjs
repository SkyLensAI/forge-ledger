// @ts-check
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "data/**",
      "docs/**",
      "**/*.md",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // 闸门脚本是"必须确定性地失败"的代码：禁止静默吞错。
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-console": "off",
    },
  },
];
