// Agent 链路共享类型（v4.9）：与 Rust ai.rs 的 ChatMessage 扩展一一对应，
// 外加工具定义、工具调用记录与「待应用改动清单 ChangePlan」。
//
// 设计约束（docs/agent-overhaul 方案）：
//   * 普通对话的 ChatMessage（lib/ai.ts）不动——AgentMessage 是它的超集镜像；
//   * 写类工具在循环期间只改内存工作副本 + 追加 op，绝不直接落盘；
//   * ops 上限 100，超出由工具执行器返回错误让模型收敛。

/** OpenAI 线格式的单次工具调用（Rust 聚合产物）。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** 完整 JSON 字符串（可能非法——loop 会 JSON.parse 并回传解析错误）。 */
    arguments: string;
  };
}

/** Agent 消息（system/user/assistant/tool 四角色）。 */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant：模型发起的工具调用数组。 */
  tool_calls?: ToolCall[];
  /** tool：回执 id（对应某个 tool_calls[i].id）。 */
  tool_call_id?: string;
}

/** OpenAI function 工具定义（发给模型的 tools 数组元素）。 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema 形态的参数定义（object）。 */
    parameters: Record<string, unknown>;
  };
}

/** 一次暂存的改动操作（应用前均不落盘）。 */
export type ChangeOperation =
  | {
      kind: "edit";
      opId: string;
      path: string;
      title: string;
      oldText: string;
      newText: string;
      /** 工具调用带了 replace_all 时为 true（部分勾选后重算需保持原语义）。 */
      replaceAll?: boolean;
    }
  | { kind: "append"; opId: string; path: string; title: string; text: string }
  | { kind: "create"; opId: string; path: string; title: string; content: string }
  | { kind: "rename"; opId: string; fromPath: string; toPath: string; title: string }
  | { kind: "delete"; opId: string; path: string; title: string };

/**
 * Agent 循环产出的「待应用改动清单」。
 *
 * workingCopies 是每个文件的工作副本（path → 最新内容）：edit/append 连续
 * 生效，后一条的 old_text 匹配针对第一条改后的内容。应用阶段对磁盘/编辑器
 * 实际内容重新校验 old_text，冲突的 op 标记失败并展示原因。
 */
export interface ChangePlan {
  ops: ChangeOperation[];
  workingCopies: Map<string, string>;
}

/** 工具调用的一次执行记录（渲染为消息流内的工具卡片）。 */
export interface ToolCallRecord {
  /** 对应 ToolCall.id（模型未给 id 时由 loop 生成）。 */
  callId: string;
  name: string;
  /** 原始 arguments 字符串（展示参数摘要用）。 */
  argsRaw: string;
  status: "running" | "ok" | "error";
  /** 一行结果摘要（卡片标题右侧）。 */
  summary: string;
  /** 可展开的结果预览（截断后的 JSON 字符串）。 */
  result: string;
}

/** Agent 消息时间线：文本段与工具卡片按发生顺序穿插展示。 */
export type AgentTimelineItem =
  | { type: "text"; text: string }
  | { type: "tool"; record: ToolCallRecord };

/** 空计划（循环无写操作时）。 */
export function emptyPlan(): ChangePlan {
  return { ops: [], workingCopies: new Map() };
}

/** ChangePlan 里允许暂存的最大 op 数（超出工具返回错误让模型收敛）。 */
export const MAX_OPS = 100;
