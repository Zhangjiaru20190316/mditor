// ESLint 9 flat config — 前端 TS/TSX + 构建脚本（src-tauri 是 Rust，由 cargo fmt/clippy 管；
// perf/ 是一次性性能脚本、scrolltest/ 是纯浏览器独立验证页（.js + 内联全局），
// 不在 lint 范围；harmony/ 是 ArkTS 工程，由 hvigor/codelinter 管——build 产物与
// 拷入的前端 dist 更不可进 eslint）。
// G3：scripts/（签名/发布/SigV4 oracle——工具链上最危险的代码）纳入 lint，
// 配最小 Node 全局（@types/node 未安装，checkJS 暂不可行，见优化报告 G3）。
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const NODE_GLOBALS = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  queueMicrotask: "readonly",
  structuredClone: "readonly",
  globalThis: "readonly",
};

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri", "perf", "scrolltest", "harmony", "*.config.*", ".zcode"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // eslint-plugin-react-hooks v7 自带的 React-Compiler 系新规则与代码库既有
      // 模式刻意冲突：整个 App/useMilkdown 采用「render 期 ref 镜像」保持稳定
      // 引用（各处注释有说明），全面改造成本高、收益低，暂不启用。
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/set-state-in-effect": "off",
      // Milkdown 的 remark/prose facade 边界处刻意用 any（内部注释已说明）；
      // 强制收紧的迁移成本大于收益。
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // 解构丢弃占位（const { docKey: _drop, ...p } = ...）：约定 _ 前缀即弃用。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
  {
    // G3：Node 构建/签名/发布脚本——JS recommended + Node 全局，防未用变量、
    // 未定义引用、误用 eval 类低级错误（S8 的密码泄漏正发生在这一层）。
    files: ["scripts/**/*.mjs"],
    languageOptions: { sourceType: "module", ecmaVersion: 2022, globals: NODE_GLOBALS },
    rules: {
      ...eslint.configs.recommended.rules,
      "no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  }
);
