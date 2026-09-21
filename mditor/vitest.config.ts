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
      // Q12 覆盖率防回退：只对两个有测试承接的目录设下限，阈值放在基线
      // （第四批实测：src/lib 行 57.01%、src/components 行 12.26%）略下方
      // 防抖动；总行 34.78% 不设全局线，给后续组件测试留抬升空间。vitest 4
      // per-glob 语法：键为 glob，值只含所设指标（未设的指标不校验）。
      thresholds: {
        "src/lib/**": { lines: 55 },
        "src/components/**": { lines: 12 },
      },
    },
  },
});
