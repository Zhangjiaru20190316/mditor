// ESLint 9 flat config — 前端 TS/TSX only（src-tauri 是 Rust，由 cargo fmt/clippy 管；
// scripts/ 是 Node 构建脚本，不在前端 lint 范围；scrolltest/ 是纯浏览器
// 独立验证页（.js + 内联全局），同样不在前端 lint 范围）。
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri", "scripts", "scrolltest", "*.config.*"] },
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
    },
  }
);
