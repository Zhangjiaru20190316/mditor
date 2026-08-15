import { defineConfig } from "vitest/config";

// 只测纯逻辑模块（outline / annotations / path-shim / renderMarkdown / 扩展名
// 辅助函数），node 环境即可；组件测试后续按需再加 jsdom。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
