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
      "handoff/**",
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
  {
    // 扩展跑在浏览器里，不是 Node 里：它的全局对象与 `chrome.*` 都不在 `globals.node` 里。
    // **只放行这两个**（`window`/`fetch` 等浏览器全局由 `globals.webextensions` 与
    // `globals.browser` 提供）——扩展里那几十行 DOM 胶水该有的东西就这些。
    files: ["apps/extension/src/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
];
