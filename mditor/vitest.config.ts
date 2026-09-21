import { defineConfig } from "vitest/config";

// 纯逻辑模块（outline / annotations / …）用默认 node 环境；组件测试
// （*.test.tsx）在文件头用 `@vitest-environment jsdom` docblock 声明环境，
// 互不拖累（node 快、jsdom 仅按需）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
