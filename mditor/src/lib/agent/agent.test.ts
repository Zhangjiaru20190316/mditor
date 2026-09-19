// Agent 核心单测（v4.9）：工具执行器（edit_note 匹配语义 / 路径安全边界 /
// 工作副本链式生效）、大纲解析、prompt 注入阈值、主循环（消息序列 /
// ChangePlan 产出 / 迭代上限 / 降级）。
//
// Tauri fs 插件与 agentChatStream 全部 mock——零真实 IO / 零真实 API 调用。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(async (p: string) => {
    const hit = FILES[p];
    if (hit === undefined) throw new Error("not found: " + p);
    return hit;
  }),
  stat: vi.fn(async () => ({ size: 100, mtime: 1 })),
  writeTextFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
}));

vi.mock("../ai", () => ({
  agentChatStream: vi.fn(),
  embedTexts: vi.fn(async () => [[0, 1]]),
  isEmbedConfigured: vi.fn(() => false),
  // S5：prompt.ts 现在调用零宽间隔中和，mock 给出与真实实现等价的简化版。
  neutralizeDelimiters: (text: string) => text.replaceAll("</note", "</​note"),
}));

vi.mock("../ragIndex", () => ({
  ragIndex: { isBuilt: () => false, search: vi.fn(() => []) },
}));

vi.mock("../workspaceSearch", () => ({
  collectMdFiles: vi.fn(async () => []),
  searchWorkspaces: vi.fn(async () => ({
    files: [],
    scanned: 0,
    totalHits: 0,
    truncated: false,
  })),
}));

import { readTextFile } from "@tauri-apps/plugin-fs";
import { agentChatStream } from "../ai";
import {
  CURRENT_KEY,
  TOOL_BY_NAME,
  extractOutline,
  normPath,
  resolveToolPath,
  type ToolContext,
} from "./tools";
import { runAgent, MAX_ITERATIONS, isToolsUnsupportedError } from "./loop";
import { buildAgentSystemPrompt, FULL_NOTE_INLINE_LIMIT } from "./prompt";
import { emptyPlan } from "./types";

// ---- 测试脚手架 -------------------------------------------------------------

let FILES: Record<string, string>;

const CURRENT = "C:/ws/note.md";
const OTHER = "C:/ws/sub/other.md";
const NOTE = "# 标题\n\n第一段内容。\n\n## 小节\n\n第二段内容。\n";

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    currentPath: CURRENT,
    getCurrentNote: () => NOTE,
    workspaces: ["C:/ws"],
    settings: {} as ToolContext["settings"],
    plan: emptyPlan(),
    ...over,
  };
}

function args(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

async function exec(name: string, json: string, ctx: ToolContext): Promise<Record<string, unknown>> {
  const tool = TOOL_BY_NAME.get(name)!;
  expect(tool, `工具 ${name} 应注册`).toBeTruthy();
  return JSON.parse(await tool.execute(args(json), ctx)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  FILES = { [OTHER]: "# 其他\n\n别的文件内容。\n" };
});

// ---- resolveToolPath：路径安全边界 -------------------------------------------

describe("resolveToolPath（安全边界）", () => {
  it("缺省 → 当前笔记", () => {
    const r = resolveToolPath(undefined, makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.abs).toBe(CURRENT);
      expect(r.current).toBe(true);
    }
  });

  it("未命名笔记：abs = null", () => {
    const r = resolveToolPath(undefined, makeCtx({ currentPath: null }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBeNull();
  });

  it("工作区内绝对路径通过（反斜杠归一）", () => {
    const r = resolveToolPath("C:\\ws\\sub\\a.md", makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe("C:/ws/sub/a.md");
  });

  it("../ 穿越被拒绝", () => {
    const r = resolveToolPath("C:/ws/../outside.md", makeCtx());
    expect(r.ok).toBe(false);
  });

  it("工作区外绝对路径被拒绝", () => {
    const r = resolveToolPath("C:/Users/evil/secret.md", makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("安全边界");
  });

  it("相对路径挂第一个工作区根", () => {
    const r = resolveToolPath("sub/a.md", makeCtx({ workspaces: ["C:/ws", "C:/ws2"] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe("C:/ws/sub/a.md");
  });

  it("相对路径含 .. 被拒绝（拼根后仍不放过）", () => {
    expect(resolveToolPath("../x.md", makeCtx()).ok).toBe(false);
  });

  it("无工作区时相对路径报错", () => {
    const r = resolveToolPath("a.md", makeCtx({ workspaces: [] }));
    expect(r.ok).toBe(false);
  });
});

// ---- edit_note：匹配语义与工作副本链式生效 -----------------------------------

describe("edit_note", () => {
  it("唯一匹配成功并暂存 op", async () => {
    const ctx = makeCtx();
    const r = await exec("edit_note", JSON.stringify({ old_text: "第一段内容。", new_text: "第一段（已改）。" }), ctx);
    expect(r.ok).toBe(true);
    expect(ctx.plan.ops).toHaveLength(1);
    expect(ctx.plan.ops[0]).toMatchObject({ kind: "edit", oldText: "第一段内容。", newText: "第一段（已改）。" });
    // 工作副本已更新：当前笔记 key。
    expect(ctx.plan.workingCopies.get(CURRENT)).toContain("第一段（已改）。");
  });

  it("多重匹配且未 replace_all → 报错", async () => {
    const ctx = makeCtx({ getCurrentNote: () => "重复\n重复\n重复\n" });
    const r = await exec("edit_note", JSON.stringify({ old_text: "重复", new_text: "X" }), ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("3 次");
    expect(ctx.plan.ops).toHaveLength(0);
  });

  it("replace_all 全部替换", async () => {
    const ctx = makeCtx({ getCurrentNote: () => "重复\n重复\n重复\n" });
    const r = await exec("edit_note", JSON.stringify({ old_text: "重复", new_text: "X", replace_all: true }), ctx);
    expect(r.ok).toBe(true);
    expect(ctx.plan.workingCopies.get(CURRENT)).toBe("X\nX\nX\n");
  });

  it("未找到 old_text → 报错并提示重读", async () => {
    const ctx = makeCtx();
    const r = await exec("edit_note", JSON.stringify({ old_text: "不存在的内容", new_text: "X" }), ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("read_note");
  });

  it("同一文件多条 edit 链式生效（第二条匹配第一条改后的内容）", async () => {
    const ctx = makeCtx();
    await exec("edit_note", JSON.stringify({ old_text: "第一段内容。", new_text: "中间结果。" }), ctx);
    const r2 = await exec("edit_note", JSON.stringify({ old_text: "中间结果。", new_text: "最终结果。" }), ctx);
    expect(r2.ok).toBe(true);
    expect(ctx.plan.ops).toHaveLength(2);
    expect(ctx.plan.workingCopies.get(CURRENT)).toContain("最终结果。");
    expect(ctx.plan.workingCopies.get(CURRENT)).not.toContain("中间结果。");
  });

  it("其他文件：读盘 → 暂存（不落盘）", async () => {
    const ctx = makeCtx();
    const r = await exec("edit_note", JSON.stringify({ path: OTHER, old_text: "别的文件内容。", new_text: "改过的内容。" }), ctx);
    expect(r.ok).toBe(true);
    expect(ctx.plan.workingCopies.get(OTHER)).toContain("改过的内容。");
    expect(readTextFile).toHaveBeenCalledWith(OTHER);
    // 磁盘原文件内容不变（writeTextFile 未被工具调用）。
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    expect(vi.mocked(writeTextFile)).not.toHaveBeenCalled();
  });

  it("越界路径拒绝", async () => {
    const ctx = makeCtx();
    const r = await exec("edit_note", JSON.stringify({ path: "C:/other/x.md", old_text: "a", new_text: "b" }), ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("安全边界");
  });

  it("未命名笔记可编辑（内存副本，key = CURRENT_KEY）", async () => {
    const ctx = makeCtx({ currentPath: null });
    const r = await exec("edit_note", JSON.stringify({ old_text: "第一段内容。", new_text: "X" }), ctx);
    expect(r.ok).toBe(true);
    expect(ctx.plan.workingCopies.get(CURRENT_KEY)).toContain("X");
    expect(ctx.plan.ops[0].kind).toBe("edit");
    expect((ctx.plan.ops[0] as { path: string }).path).toBe(CURRENT_KEY);
  });
});

describe("append_to_note / create_note / delete_note", () => {
  it("追加到当前笔记末尾（已有换行不补空行）", async () => {
    const ctx = makeCtx();
    const r = await exec("append_to_note", JSON.stringify({ text: "## 新增小节\n\n内容。" }), ctx);
    expect(r.ok).toBe(true);
    const wc = ctx.plan.workingCopies.get(CURRENT)!;
    expect(wc.endsWith("## 新增小节\n\n内容。")).toBe(true);
    expect(ctx.plan.ops[0].kind).toBe("append");
  });

  it("create_note：工作区内合法路径暂存；非 md 拒绝", async () => {
    const ctx = makeCtx();
    const r = await exec("create_note", JSON.stringify({ path: "C:/ws/new/计划.md", content: "# 计划\n" }), ctx);
    expect(r.ok).toBe(true);
    expect(ctx.plan.ops[0].kind).toBe("create");

    const bad = await exec("create_note", JSON.stringify({ path: "C:/ws/x.txt", content: "x" }), ctx);
    expect(bad.ok).toBe(false);
  });

  it("create_note：目标与当前笔记相同 → 拒绝", async () => {
    const ctx = makeCtx();
    const r = await exec("create_note", JSON.stringify({ path: CURRENT, content: "x" }), ctx);
    expect(r.ok).toBe(false);
  });

  it("delete_note：暂存 delete op；越界拒绝", async () => {
    const ctx = makeCtx();
    const r = await exec("delete_note", JSON.stringify({ path: OTHER }), ctx);
    expect(r.ok).toBe(true);
    expect(ctx.plan.ops[0].kind).toBe("delete");

    const bad = await exec("delete_note", JSON.stringify({ path: "C:/elsewhere/x.md" }), ctx);
    expect(bad.ok).toBe(false);
  });
});

// ---- extractOutline ----------------------------------------------------------

describe("extractOutline（大纲纯函数）", () => {
  it("各级标题解析 + 行号", () => {
    const out = extractOutline("# 一\n\n正文\n\n## 二\n\n### 三\n");
    expect(out).toEqual([
      { level: 1, text: "一", line: 0 },
      { level: 2, text: "二", line: 4 },
      { level: 3, text: "三", line: 6 },
    ]);
  });

  it("代码围栏内的 # 不误判（``` 与 ~~~）", () => {
    const text = "# 真\n\n```md\n# 假\n```\n\n~~~\n# 也假\n~~~\n\n## 真二\n";
    const out = extractOutline(text);
    expect(out.map((h) => h.text)).toEqual(["真", "真二"]);
  });

  it("# 后无空格不算标题；关闭的围栏恢复解析", () => {
    const text = "#无空格\n\n```\n# 围栏\n```\n# 围栏后\n";
    const out = extractOutline(text);
    expect(out.map((h) => h.text)).toEqual(["围栏后"]);
  });
});

// ---- prompt -----------------------------------------------------------------

describe("buildAgentSystemPrompt", () => {
  it("注入当前路径、大纲与工作区根；短文全文内联", () => {
    const p = buildAgentSystemPrompt(makeCtx());
    expect(p).toContain(CURRENT);
    expect(p).toContain("H1 L0 标题");
    expect(p).toContain("C:/ws");
    expect(p).toContain("<note>");
    expect(p).toContain(NOTE.trim());
  });

  it("长文（≥ FULL_NOTE_INLINE_LIMIT）只给大纲不内联全文", () => {
    const long = "长".repeat(FULL_NOTE_INLINE_LIMIT) + "\n# 标\n";
    const p = buildAgentSystemPrompt(makeCtx({ getCurrentNote: () => long }));
    expect(p).not.toContain("<note>");
    expect(p).toContain("未内联");
  });

  it("未命名笔记明确标注", () => {
    const p = buildAgentSystemPrompt(makeCtx({ currentPath: null }));
    expect(p).toContain("未命名");
  });
});

// ---- runAgent 主循环 ---------------------------------------------------------

/** 构造一轮 agentChatStream 的 mock 返回。 */
function streamRound(result: {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args?: string }>;
  error?: string;
}) {
  return () => {
    const handle = {
      cancel: vi.fn(),
      promise: result.error
        ? Promise.reject(new Error(result.error))
        : Promise.resolve({
            content: result.content ?? "",
            reasoning: "",
            toolCalls:
              result.toolCalls?.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.args ?? "{}" },
              })) ?? [],
            cancelled: false,
          }),
    };
    return handle;
  };
}

function lastCallMessages(): Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: string }> {
  const calls = vi.mocked(agentChatStream).mock.calls;
  return calls[calls.length - 1][0].messages as Array<{
    role: string;
    content: string;
    tool_calls?: unknown;
    tool_call_id?: string;
  }>;
}

describe("runAgent", () => {
  it("一轮 tool_calls + 一轮纯文本：消息序列正确且产出 ChangePlan", async () => {
    vi.mocked(agentChatStream)
      .mockImplementationOnce(
        streamRound({
          content: "我先检索一下。",
          toolCalls: [{ id: "call_1", name: "search_notes", args: JSON.stringify({ query: "苹果" }) }],
        }) as never
      )
      .mockImplementationOnce(
        streamRound({ content: "共 2 篇笔记提到苹果。" }) as never
      );

    const events: string[] = [];
    const res = await runAgent({
      ctx: makeCtx(),
      userMessage: "哪几篇笔记讲过苹果？",
      onEvent: (e) => events.push(e.type),
      signal: new AbortController().signal,
    });

    expect(res.cancelled).toBe(false);
    expect(res.answer).toBe("共 2 篇笔记提到苹果。");
    expect(res.plan.ops).toHaveLength(0);
    // 两轮请求；第一轮带 tools，第二轮也带（未到收尾轮）。
    expect(agentChatStream).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agentChatStream).mock.calls[0][0].tools).toBeTruthy();
    // 第二轮消息序列：system, user, assistant(tool_calls), tool。
    const msgs = lastCallMessages();
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[2].tool_calls).toHaveLength(1);
    expect(msgs[3].tool_call_id).toBe("call_1");
    expect(String(msgs[3].content)).toContain('"ok"');
    // 事件流含工具卡片生命周期。
    expect(events).toContain("tool-start");
    expect(events).toContain("tool-end");
  });

  it("edit_note 暂存进入 ChangePlan", async () => {
    vi.mocked(agentChatStream)
      .mockImplementationOnce(
        streamRound({
          toolCalls: [{ id: "c1", name: "edit_note", args: JSON.stringify({ old_text: "第一段内容。", new_text: "X" }) }],
        }) as never
      )
      .mockImplementationOnce(streamRound({ content: "已完成修改。" }) as never);

    const ctx = makeCtx();
    const res = await runAgent({
      ctx,
      userMessage: "把第一段改成 X",
      onEvent: () => {},
      signal: new AbortController().signal,
    });
    expect(res.plan.ops).toHaveLength(1);
    expect(res.plan.ops[0].kind).toBe("edit");
    expect(res.plan.workingCopies.get(CURRENT)).toContain("X");
  });

  it("arguments 非法 JSON：解析错误回传给模型，循环不崩溃", async () => {
    vi.mocked(agentChatStream)
      .mockImplementationOnce(
        streamRound({ toolCalls: [{ id: "c1", name: "search_notes", args: "{不是json" }] }) as never
      )
      .mockImplementationOnce(streamRound({ content: "好的。" }) as never);

    const res = await runAgent({
      ctx: makeCtx(),
      userMessage: "q",
      onEvent: () => {},
      signal: new AbortController().signal,
    });
    expect(res.answer).toBe("好的。");
    const toolMsg = lastCallMessages()[3] as { content: string; tool_call_id: string };
    expect(toolMsg.tool_call_id).toBe("c1");
    expect(toolMsg.content).toContain("不是合法 JSON");
  });

  it("迭代上限：到顶注入收尾指令且最后一轮不带 tools", async () => {
    // 每轮都返回工具调用 → 顶到上限。
    vi.mocked(agentChatStream).mockImplementation(
      streamRound({
        toolCalls: [{ id: "c", name: "search_notes", args: '{"query":"x"}' }],
      }) as never
    );
    const res = await runAgent({
      ctx: makeCtx(),
      userMessage: "q",
      onEvent: () => {},
      signal: new AbortController().signal,
    });
    expect(agentChatStream).toHaveBeenCalledTimes(MAX_ITERATIONS);
    // 最后一轮：tools 为 null，且消息里有收尾指令。
    const lastCall = vi.mocked(agentChatStream).mock.calls[MAX_ITERATIONS - 1][0];
    expect(lastCall.tools).toBeNull();
    const lastMsg = (lastCall.messages as Array<{ content: string }>).at(-1);
    expect(String(lastMsg?.content)).toContain("最终答案");
    expect(res.cancelled).toBe(false);
  });

  it("取消：signal 中止后返回 cancelled", async () => {
    const ac = new AbortController();
    vi.mocked(agentChatStream).mockImplementation(
      streamRound({ toolCalls: [{ id: "c", name: "search_notes", args: '{"query":"x"}' }] }) as never
    );
    const res = await runAgent({
      ctx: makeCtx(),
      userMessage: "q",
      onEvent: () => {
        ac.abort();
      },
      signal: ac.signal,
    });
    expect(res.cancelled).toBe(true);
  });

  it("降级：tools 不被支持时自动去掉 tools 重试并标记 degraded", async () => {
    vi.mocked(agentChatStream)
      .mockImplementationOnce(() => ({
        cancel: vi.fn(),
        promise: Promise.reject(new Error("请求失败（HTTP 400）：tools is not supported")),
      }))
      .mockImplementationOnce(streamRound({ content: "普通回答。" }) as never);

    let degraded = false;
    const res = await runAgent({
      ctx: makeCtx(),
      userMessage: "q",
      onEvent: (e) => {
        if (e.type === "degraded") degraded = true;
      },
      signal: new AbortController().signal,
    });
    expect(degraded).toBe(true);
    expect(res.degraded).toBe(true);
    expect(res.answer).toBe("普通回答。");
    // 降级轮不带 tools。
    const second = vi.mocked(agentChatStream).mock.calls[1][0];
    expect(second.tools).toBeNull();
  });

  it("与 tools 无关的错误正常抛出（不降级）", async () => {
    vi.mocked(agentChatStream).mockImplementation(
      () => ({
        cancel: vi.fn(),
        promise: Promise.reject(new Error("鉴权失败（HTTP 401）")),
      }) as never
    );
    await expect(
      runAgent({
        ctx: makeCtx(),
        userMessage: "q",
        onEvent: () => {},
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("401");
    expect(agentChatStream).toHaveBeenCalledTimes(1);
  });
});

describe("isToolsUnsupportedError", () => {
  it("命中：tools 不支持特征", () => {
    expect(isToolsUnsupportedError("HTTP 400: tools is not supported")).toBe(true);
    expect(isToolsUnsupportedError("function calling not supported by model")).toBe(true);
    expect(isToolsUnsupportedError("模型不支持 tool_calls")).toBe(true);
  });
  it("不命中：无关错误或不含关键词", () => {
    expect(isToolsUnsupportedError("鉴权失败（HTTP 401）")).toBe(false);
    expect(isToolsUnsupportedError("connect timeout")).toBe(false);
  });
});

// ---- apply 重算纯函数 --------------------------------------------------------

describe("applyContentOp（部分勾选重算）", () => {
  it("edit 唯一匹配替换；append 补换行", async () => {
    const { applyContentOp } = await import("./apply");
    const r1 = applyContentOp("aa\nbb\ncc\n", {
      kind: "edit", opId: "o1", path: "x", title: "x", oldText: "bb", newText: "BB",
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.text).toBe("aa\nBB\ncc\n");

    const r2 = applyContentOp("末尾无换行", {
      kind: "append", opId: "o2", path: "x", title: "x", text: "追加",
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.text).toBe("末尾无换行\n追加");
  });

  it("old_text 失配（外部修改）标记失败", async () => {
    const { applyContentOp } = await import("./apply");
    const r = applyContentOp("内容变了", {
      kind: "edit", opId: "o1", path: "x", title: "x", oldText: "旧内容", newText: "新",
    });
    expect(r.ok).toBe(false);
  });

  it("replaceAll 多重匹配仍可重算", async () => {
    const { applyContentOp } = await import("./apply");
    const r = applyContentOp("x\nx\nx\n", {
      kind: "edit", opId: "o1", path: "x", title: "x", oldText: "x", newText: "y", replaceAll: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("y\ny\ny\n");
  });
});

// ---- normPath ----------------------------------------------------------------

describe("normPath", () => {
  it("反斜杠归一 / 去尾斜杠", () => {
    expect(normPath("C:\\ws\\a.md")).toBe("C:/ws/a.md");
    expect(normPath("C:/ws/")).toBe("C:/ws");
  });
});
