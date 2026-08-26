// Token 降本层测试（v3.9）：估算函数、四种截断策略、历史预算裁剪、
// 批注精炼截断、系统提示词的截断接线。

import { describe, expect, it } from "vitest";
import {
  buildAnnotationMessages,
  buildFormatFixMessages,
  buildHistoryWithBudget,
  buildSelectionMessages,
  buildSystemPrompt,
  estimateTokens,
  truncateNoteForContext,
  type ChatMessage,
} from "./ai";

describe("estimateTokens", () => {
  it("空串为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("纯 ASCII 约 4 字符/token", () => {
    // 40 个 ASCII 字符 → 10 token
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
  it("纯 CJK 约 1.5 字符/token", () => {
    // 9 个汉字 → 6 token
    expect(estimateTokens("批注内容测试一二三")).toBe(6);
  });
  it("中英混合相加", () => {
    // 3 汉字 = 2 + 8 ASCII = 2 → 4
    expect(estimateTokens("批注内容abcd")).toBe(4);
  });
});

describe("truncateNoteForContext", () => {
  // 块级填充：让 smart 场景的文档总长超过预算（12000），否则走“整体不截
  // 断”快路径，块选择逻辑不会运行；且单块要大到只容得下一个中选块。
  const filler = (s: string) => `${s} ${"填充".repeat(3000)}`;
  const bigNote = [
    "# 标题开头",
    filler("苹果香蕉橙子内容一"),
    filler("量子物理 unrelated block"),
    filler("部署相关 docker kubernetes 发布流程"),
    "结尾段落收尾",
  ].join("\n\n");

  it("full 原样返回（仅去首尾空白）", () => {
    expect(truncateNoteForContext(`  ${bigNote}  `, "full")).toBe(bigNote);
  });
  it("standard 超长截断并附尾标", () => {
    const note = "x".repeat(7000);
    const out = truncateNoteForContext(note, "standard");
    expect(out.length).toBeLessThanOrEqual(6000 + "\n\n（笔记过长，已截断）".length);
    expect(out.endsWith("（笔记过长，已截断）")).toBe(true);
  });
  it("standard 短文原样返回", () => {
    expect(truncateNoteForContext("短笔记", "standard")).toBe("短笔记");
  });
  it("large 上限 12000", () => {
    const note = "y".repeat(20000);
    const out = truncateNoteForContext(note, "large");
    expect(out.startsWith("yyy")).toBe(true);
    expect(out.endsWith("（笔记过长，已截断）")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(12000 + "\n\n（笔记过长，已截断）".length);
  });
  it("smart 保留头尾与相关块，丢弃无关块", () => {
    const out = truncateNoteForContext(bigNote, "smart", "怎么部署发布");
    expect(out).toContain("标题开头");
    expect(out).toContain("结尾段落收尾");
    expect(out).toContain("部署相关"); // 与提问相关
    expect(out).not.toContain("量子物理"); // 无关被裁
    expect(out).toContain("已按相关度节选");
  });
  it("smart 无提问时退化为头尾保留", () => {
    const out = truncateNoteForContext(bigNote, "smart");
    expect(out).toContain("标题开头");
    expect(out).toContain("结尾段落收尾");
    expect(out).not.toContain("量子物理");
  });
  it("smart 不超预算", () => {
    const note = Array.from({ length: 200 }, (_, i) => `块${i}部署发布`).join("\n\n");
    const out = truncateNoteForContext(note, "smart", "部署");
    expect(out.length).toBeLessThanOrEqual(13000);
  });
});

describe("buildHistoryWithBudget", () => {
  const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({
    role,
    content,
  });

  it("预算内全保留", () => {
    const msgs = [
      msg("system", "sys"),
      msg("user", "问题一"),
      msg("assistant", "回答一"),
      msg("user", "问题二"),
    ];
    const r = buildHistoryWithBudget(msgs, 8000);
    expect(r.messages).toEqual(msgs);
    expect(r.dropped).toBe(0);
  });
  it("超预算从最旧丢弃", () => {
    const long = (s: string) => s.repeat(200); // ~数百 token
    const msgs = [
      msg("system", "sys"),
      msg("user", long("最旧问题")),
      msg("assistant", long("最旧回答")),
      msg("user", "最新问题"),
    ];
    const r = buildHistoryWithBudget(msgs, 300);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.messages[r.messages.length - 1].content).toBe("最新问题");
    expect(r.messages[0].role).toBe("system"); // system 恒保留
  });
  it("孤儿回答被修剪（其问题已被裁掉）", () => {
    const long = (s: string) => s.repeat(200);
    const msgs = [
      msg("system", "sys"),
      msg("user", long("问题")),
      msg("assistant", long("孤儿回答")),
      msg("user", "新问题"),
      msg("assistant", "新回答"),
    ];
    const r = buildHistoryWithBudget(msgs, 350);
    // 最早的保留消息不得是 assistant
    expect(r.messages[0].role === "system" || r.messages[0].role === "user").toBe(true);
  });
  it("单条超预算仍保留最新消息", () => {
    const msgs = [msg("user", "z".repeat(4000))];
    const r = buildHistoryWithBudget(msgs, 10);
    expect(r.messages).toHaveLength(1);
  });
  it("空列表", () => {
    expect(buildHistoryWithBudget([], 100).messages).toEqual([]);
  });
});

describe("buildAnnotationMessages（批注精炼降本）", () => {
  it("超长回复截断到 maxChars", () => {
    const reply = "r".repeat(5000);
    const msgs = buildAnnotationMessages(reply, 4000);
    expect(msgs[1].content.length).toBeLessThanOrEqual(
      4000 + "\n\n（内容过长，已截断）".length
    );
    expect(msgs[1].content.endsWith("（内容过长，已截断）")).toBe(true);
  });
  it("短回复原样", () => {
    expect(buildAnnotationMessages("短回复", 4000)[1].content).toBe("短回复");
  });
});

describe("buildSystemPrompt / buildSelectionMessages 接线", () => {
  it("standard 策略截断 note", () => {
    const note = "n".repeat(7000);
    const out = buildSystemPrompt(note, "", "standard");
    expect(out).toContain("<note>");
    expect(out).not.toContain("n".repeat(6500));
  });
  it("full 策略保留完整 note", () => {
    const note = "n".repeat(7000);
    const out = buildSystemPrompt(note, "", "full");
    expect(out).toContain(note);
  });
  it("选区模式带截断的 note 上下文", () => {
    const note = "n".repeat(7000);
    const msgs = buildSelectionMessages({
      instruction: "解释",
      selection: "选中文字",
      noteContext: note,
      strategy: "standard",
    });
    expect(msgs[0].content).toContain("<note>");
    expect(msgs[0].content).not.toContain("n".repeat(6500));
    expect(msgs[1].content).toContain("<selection>");
  });
  it("选区模式无 note 时不输出 <note>", () => {
    const msgs = buildSelectionMessages({
      instruction: "解释",
      selection: "选中文字",
    });
    // 默认系统提示词的说明文字里提到 <note> 标签名，断言实际的注入形态。
    expect(msgs[0].content).not.toContain("\n<note>\n");
  });
});

describe("buildFormatFixMessages", () => {
  it("返回 system + user 两条消息", () => {
    const msgs = buildFormatFixMessages("# 标题\n\n正文");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
  });

  it("user 原样携带全文，超长也不截断", () => {
    // 超过 large 策略的 12000 上限：修复任务是"输出完整全文"，截断即破坏任务。
    const note = "z".repeat(20000);
    const msgs = buildFormatFixMessages(note);
    expect(msgs[1].content).toBe(note);
    expect(msgs[1].content).not.toContain("已截断");
  });

  it("空文档给占位提示", () => {
    const msgs = buildFormatFixMessages("   ");
    expect(msgs[1].content).toBe("（当前笔记为空）");
  });

  it("system 含关键约束：只输出全文、逐字保留内容", () => {
    const sys = buildFormatFixMessages("内容")[0].content;
    expect(sys).toContain("只输出修复后的完整全文");
    expect(sys).toContain("逐字保留全部文字内容");
    expect(sys).toContain("Markdown 格式修复器");
  });
});
