// 「从模板新建」的内置模板（V3.6）。内容为纯 Markdown，插入新标签页后由
// 用户自行填充；日期占位（{date}）在创建时替换为当天。

export interface DocTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
}

export const TEMPLATES: DocTemplate[] = [
  {
    id: "blank",
    name: "空白文档",
    description: "从一个干净的页面开始",
    content: "",
  },
  {
    id: "meeting",
    name: "会议纪要",
    description: "议题 / 讨论 / 决议 / 待办",
    content: `# 会议纪要

- **日期**：{date}
- **参会人**：
- **缺席人**：

## 会议目的

## 讨论内容

### 议题一

### 议题二

## 决议

-

## 待办事项

- [ ] 
- [ ] 
`,
  },
  {
    id: "weekly",
    name: "周报",
    description: "本周进展 / 数据 / 下周计划",
    content: `# 周报 · {date}

## 本周进展

-

## 关键数据

| 指标 | 本周 | 上周 | 变化 |
| --- | --- | --- | --- |
|  |  |  |  |

## 问题与风险

-

## 下周计划

- [ ] 
- [ ] 
`,
  },
  {
    id: "reading",
    name: "阅读笔记",
    description: "书目信息 / 摘录 / 心得",
    content: `# 阅读笔记

- **书名**：
- **作者**：
- **读完日期**：{date}
- **评分**：⭐⭐⭐⭐⭐

## 一句话总结

## 摘录

> 

## 心得

## 行动项

- [ ] 
`,
  },
  {
    id: "tech",
    name: "技术文档",
    description: "背景 / 方案 / 接口 / 上线",
    content: `# 

## 背景

## 方案设计

### 总体思路

### 关键细节

## 接口 / 数据结构

\`\`\`
\`\`\`

## 测试与验证

- [ ] 

## 上线计划

| 阶段 | 时间 | 负责人 |
| --- | --- | --- |
|  |  |  |
`,
  },
];

/** 用当天日期替换模板中的 {date} 占位符。 */
export function renderTemplate(t: DocTemplate): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return t.content.replaceAll("{date}", `${y}-${m}-${d}`);
}
