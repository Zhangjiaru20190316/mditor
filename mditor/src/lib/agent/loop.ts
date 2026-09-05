// Agent 主循环（v4.9）：runAgent 驱动「模型 → 工具 → 模型」迭代直到纯文本回答。
//
// 设计要点：
//   * 迭代上限 MAX_ITERATIONS；到顶后注入一条 user 消息强制收尾，再跑最后
//     一轮（不带 tools），杜绝无限循环烧 token；
//   * 降级路径：请求报错且错误信息含「不支持 tools」特征（Ollama 本地模型等）
//     时，自动改跑不带 tools 的单轮对话并广播 degraded 事件（UI 提示）；
//   * 模型给出的 arguments 先 JSON.parse，失败把原始文本与解析错误作为 tool
//     消息回传，让模型自我纠正；
//   * 工具执行异常一律捕获为 { ok: false, error }，绝不让循环崩溃；
//   * 取消：AbortSignal——轮与轮之间、每个工具执行前检查；进行中的流式请求
//     由 signal 直接触发其 handle.cancel()（复用 ai_chat_cancel 停止链路）。

import { agentChatStream } from "../ai";
import { buildAgentSystemPrompt } from "./prompt";
import { TOOL_BY_NAME, TOOL_DEFINITIONS, type ToolContext } from "./tools";
import { emptyPlan, type AgentMessage, type ChangePlan, type ToolCallRecord } from "./types";

/** 迭代上限（一轮 = 一次模型请求 + 其工具调用执行）。 */
export const MAX_ITERATIONS = 12;

/** 面向 UI 的循环事件（驱动工具卡片与提示）。 */
export type AgentEvent =
  | { type: "llm-start"; iter: number }
  | { type: "chunk"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool-start"; record: ToolCallRecord }
  | { type: "tool-end"; callId: string; status: "ok" | "error"; summary: string; result: string }
  /** 模型不支持工具调用，已降级为普通对话。 */
  | { type: "degraded" }
  /** 迭代到顶，强制收尾轮。 */
  | { type: "force-final" };

export interface AgentRunResult {
  /** 最终文本回答（降级/收尾轮的正文）。 */
  answer: string;
  /** 待应用改动清单（可能为空）。 */
  plan: ChangePlan;
  /** 用户中途取消。 */
  cancelled: boolean;
  /** 发生过 tools → 无 tools 降级。 */
  degraded: boolean;
}

export interface RunAgentOptions {
  ctx: ToolContext;
  /** 用户输入（首条 user 消息）。 */
  userMessage: string;
  onEvent: (e: AgentEvent) => void;
  /** 停止按钮触发。 */
  signal: AbortSignal;
}

/** 4xx + 错误文本含 tools 不支持特征（Ollama 等本地模型常见报错）。 */
export function isToolsUnsupportedError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  if (!/(tool|function)/.test(msg)) return false;
  return /not support|unsupported|does not|doesn't|no support|无效|不支持|unknown|invalid|error/.test(msg);
}

/** 工具参数摘要（卡片参数行 + 结果摘要用）。 */
function argsSummary(argsRaw: string): string {
  try {
    const parsed = JSON.parse(argsRaw) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return "{}";
    // 取首个字符串参数的值做摘要，其余显示键名。
    const first = keys[0];
    const v = parsed[first];
    const vs = typeof v === "string" ? v : JSON.stringify(v);
    const head = vs.length > 80 ? vs.slice(0, 80) + "…" : vs;
    return keys.length > 1 ? `${first}=${head} 等 ${keys.length} 项` : `${first}=${head}`;
  } catch {
    return argsRaw.slice(0, 80) || "{}";
  }
}

/** 单个工具调用的执行（含解析回传）。返回追加进 messages 的 tool 消息。 */
async function executeToolCall(
  call: { id: string; function: { name: string; arguments: string } },
  ctx: ToolContext,
  onEvent: (e: AgentEvent) => void
): Promise<AgentMessage> {
  const name = call.function.name;
  const tool = TOOL_BY_NAME.get(name);
  const fallbackId = call.id || `call-${Math.random().toString(36).slice(2, 8)}`;

  if (!tool) {
    const result = JSON.stringify({ ok: false, error: `未知工具：${name}。可用工具见 tools 列表。` });
    onEvent({
      type: "tool-end",
      callId: fallbackId,
      status: "error",
      summary: `未知工具 ${name}`,
      result,
    });
    return { role: "tool", content: result, tool_call_id: fallbackId };
  }

  onEvent({
    type: "tool-start",
    record: {
      callId: fallbackId,
      name,
      argsRaw: call.function.arguments,
      status: "running",
      summary: argsSummary(call.function.arguments),
      result: "",
    },
  });

  let result: string;
  let status: "ok" | "error";
  let summary: string;
  try {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch (e) {
      // arguments 非法 JSON：原样回传让模型自我纠正。
      result = JSON.stringify({
        ok: false,
        error: `arguments 不是合法 JSON：${String(e)}`,
        raw: call.function.arguments,
      });
      status = "error";
      summary = "参数解析失败";
      onEvent({ type: "tool-end", callId: fallbackId, status, summary, result });
      return { role: "tool", content: result, tool_call_id: fallbackId };
    }
    result = await tool.execute(args, ctx);
    status = result.includes(`"ok":false`) ? "error" : "ok";
    summary = status === "ok" ? tool.label : extractError(result) ?? tool.label;
  } catch (e) {
    result = JSON.stringify({ ok: false, error: `工具执行异常：${String(e)}` });
    status = "error";
    summary = `执行异常：${String(e).slice(0, 80)}`;
  }
  onEvent({ type: "tool-end", callId: fallbackId, status, summary, result });
  return { role: "tool", content: result, tool_call_id: fallbackId };
}

/** 从 { ok:false, error } 形态的工具结果里抽 error（摘要用）。 */
function extractError(resultJson: string): string | null {
  try {
    const parsed = JSON.parse(resultJson) as { ok?: boolean; error?: string };
    if (parsed && parsed.ok === false && typeof parsed.error === "string") {
      return parsed.error.length > 90 ? parsed.error.slice(0, 90) + "…" : parsed.error;
    }
  } catch {
    /* 非 JSON 结果按成功处理 */
  }
  return null;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { ctx, userMessage, onEvent, signal } = opts;
  const plan: ChangePlan = emptyPlan();
  // 工具上下文里的 plan 就是本结果对象（写类工具往里暂存）。
  ctx.plan = plan;

  const messages: AgentMessage[] = [
    { role: "system", content: buildAgentSystemPrompt(ctx) },
    { role: "user", content: userMessage },
  ];

  let degraded = false;
  let answer = "";

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal.aborted) {
      return { answer, plan, cancelled: true, degraded };
    }
    const forceFinal = iter === MAX_ITERATIONS - 1;
    if (forceFinal) {
      messages.push({
        role: "user",
        content: "（系统提示：已达工具调用轮次上限。请基于已获得的信息直接给出最终答案，不要再调用工具。）",
      });
      onEvent({ type: "force-final" });
    }
    onEvent({ type: "llm-start", iter });

    const requestId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = agentChatStream({
      settings: ctx.settings,
      messages,
      tools: forceFinal || degraded ? null : TOOL_DEFINITIONS,
      requestId,
      onChunk: (d) => onEvent({ type: "chunk", delta: d }),
      onReasoning: (d) => onEvent({ type: "reasoning", delta: d }),
    });
    const onAbort = () => handle.cancel();
    signal.addEventListener("abort", onAbort, { once: true });

    let result;
    try {
      result = await handle.promise;
    } catch (e) {
      signal.removeEventListener("abort", onAbort);
      // 降级判定：仅在仍带 tools 且首次失败时尝试；降级后重跑本轮。
      if (!degraded && !forceFinal && isToolsUnsupportedError(e)) {
        degraded = true;
        onEvent({ type: "degraded" });
        messages.push({
          role: "user",
          content: "（系统提示：当前模型不支持工具调用，请直接以普通对话回答。）",
        });
        iter--; // 重跑本轮（iter-- + for 的 iter++ = 原地重试一次）
        continue;
      }
      throw e;
    }
    signal.removeEventListener("abort", onAbort);

    if (result.cancelled || signal.aborted) {
      answer = answer || result.content;
      return { answer, plan, cancelled: true, degraded };
    }

    if (result.toolCalls.length > 0 && !forceFinal && !degraded) {
      // 工具轮：assistant 带 tool_calls 原样入史，逐个执行后继续循环。
      messages.push({
        role: "assistant",
        content: result.content,
        tool_calls: result.toolCalls,
      });
      for (const call of result.toolCalls) {
        if (signal.aborted) {
          return { answer, plan, cancelled: true, degraded };
        }
        messages.push(await executeToolCall(call, ctx, onEvent));
      }
      continue;
    }

    // 纯文本回答：循环结束。
    answer = result.content;
    return { answer, plan, cancelled: false, degraded };
  }

  // 理论不可达（收尾轮在循环内 return）；防御性兜底。
  return { answer, plan, cancelled: false, degraded };
}
