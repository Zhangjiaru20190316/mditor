// AiBridge.ets —— AI 四命令的桥实现（v4.13 P2：ArkTS SSE 代理）。
//
// 桌面契约逐条移植自 src-tauri/src/ai.rs（method 名/参数键 camelCase 与前端
// ai.ts 的 invoke 载荷逐字一致）：
//   ai_chat          非流式单发（「测试连接」），120s 总超时
//   ai_chat_stream   SSE 流式，事件 ai_stream_chunk / ai_stream_reasoning /
//                    ai_stream_tool_calls / ai_stream_done / ai_stream_error，
//                   载荷 {id, delta|tool_calls|error}（id 即 requestId）
//   ai_chat_cancel   取消登记（fire-and-forget；容量 1024 触顶整表清空）
//   ai_embed         /embeddings，按响应 data[i].index 归位回输入顺序
//
// 行为细节（对齐 ai.rs）：
//   * SSE：`data:` 前缀、`[DONE]` 终止、空行/`:`注释跳过；TextDecoder 流式
//     解码防多字节 UTF-8 跨 chunk 截断；行缓冲上限 1MiB 防服务端失控。
//   * reasoning 兼容 reasoning / reasoning_content 两种字段名（前者优先级低）。
//   * tool_calls 分片聚合：按 index 分组（缺失用数组下标兜底）、id/name 取
//     首个非空、arguments 字符串拼接；finish_reason=="tool_calls" 发射一次，
//     [DONE]/EOF 收尾安全网补发。
//   * thinking 映射：openai/openrouter/deepseek/custom/ollama →
//     reasoning_effort；glm/moonshot → thinking:{type:"enabled",budget_tokens}。
//   * 流式无总超时（readTimeout=0），仅 10s 连接超时；取消后销毁连接停拉
//     上游流（不再消耗计费 token）。
//
// 安全红线（D5）：apiKey 绝不进日志/事件/错误消息；hilog 只打 method 与
// requestId。页面重载（桥端口重建）时在途流全部取消（消费方已消失）。

import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Bridge, BridgeError } from '../bridge/Bridge';

/** hilog 域（与全工程一致，Mditor 专用 0x0D01）。 */
const DOMAIN = 0x0D01;

/** SSE 行缓冲上限（对齐 ai.rs 的 MAX_BUFFER_BYTES = 1 MiB）。 */
const MAX_LINE_BUF = 1 * 1024 * 1024;
/** 错误回显体留存上限（网关错误页可能巨大；friendlyError 本身再截 300 字符）。 */
const MAX_ERR_BODY = 64 * 1024;
/** 取消登记表容量上限（对齐 ai.rs 的 1024；触顶整表清空兜「迟到的取消」）。 */
const CANCEL_CAP = 1024;
/** 连接超时（TCP+TLS 握手，对齐 ai.rs CONNECT_TIMEOUT_SECS）。 */
const CONNECT_TIMEOUT_MS = 10000;
/** ai_chat / ai_embed 总超时（对齐 ai.rs REQUEST_TIMEOUT_SECS）。 */
const REQUEST_TIMEOUT_MS = 120000;

// ---- 纯函数区（D6：解析/聚合/映射全部可脱离网络单测） ------------------------

/** Object → Record 安全转换（非对象/数组 → null）。 */
function asRecord(v: Object | undefined): Record<string, Object> | null {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    return v as Record<string, Object>;
  }
  return null;
}

function strField(v: Object | undefined): string | null {
  return typeof v === 'string' ? v as string : null;
}

function numField(v: Object | undefined): number | null {
  return typeof v === 'number' ? v as number : null;
}

/** 截断上游错误体至 300 字符（对齐 ai.rs truncate_error_body）。 */
export function truncateErrorBody(body: string): string {
  if (body.length <= 300) {
    return body;
  }
  return `${body.slice(0, 300)}…`;
}

/** HTTP 状态 → 可直接展示的中文错误（对齐 ai.rs friendly_error）。 */
export function friendlyError(status: number, body: string): string {
  const clipped = truncateErrorBody(body);
  if (status === 401 || status === 403) {
    return `鉴权失败（HTTP ${status}）：API Key 无效或无权访问该模型。`;
  }
  if (status === 404) {
    return `接口未找到（HTTP 404）：请检查 Base URL 是否正确（应类似 https://api.openai.com/v1）。响应：${clipped}`;
  }
  if (status === 429) {
    return '请求过于频繁或额度不足（HTTP 429），请稍后重试。';
  }
  if (status >= 500) {
    return `服务端错误（HTTP ${status}），请稍后重试。响应：${clipped}`;
  }
  return `请求失败（HTTP ${status}）：${clipped}`;
}

/** 网络/系统错误 → 中文文案（对齐 ai.rs send_request 的超时/连接归类）。 */
export function networkErrorText(err: BusinessError): string {
  const msg = err.message !== undefined ? err.message : String(err.code);
  if (msg.includes('timeout') || msg.includes('timed out') || err.code === 2300028) {
    return '请求超时：请检查网络连接，以及 Base URL 是否可达。';
  }
  if (err.code === 2300006 || msg.includes('resolve') || msg.includes('connect')) {
    return `无法连接到 AI 服务：${msg}。请确认 Base URL 正确且网络可用。`;
  }
  return `网络请求失败：${msg}`;
}

/** {base_url}/chat/completions（尾斜杠兼容，对齐 ai.rs send_request）。 */
export function chatUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? `${baseUrl}chat/completions` : `${baseUrl}/chat/completions`;
}

/** {base_url}/embeddings。 */
export function embeddingsUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? `${baseUrl}embeddings` : `${baseUrl}/embeddings`;
}

/**
 * (provider, thinkingStrength) → 请求体附加字段（逐字移植 ai.rs thinking_fields）。
 * off/未知 → null（不发送，保持与非推理模型兼容）。
 */
export function thinkingFields(provider: string, strength: string): Record<string, Object> | null {
  let effort = '';
  let budget = 0;
  if (strength === 'low') {
    effort = 'low';
    budget = 2048;
  } else if (strength === 'medium') {
    effort = 'medium';
    budget = 8192;
  } else if (strength === 'high') {
    effort = 'high';
    budget = 32768;
  } else {
    return null;
  }
  if (provider === 'glm' || provider === 'moonshot') {
    const t: Record<string, Object> = { 'type': 'enabled', 'budget_tokens': budget };
    const out: Record<string, Object> = { 'thinking': t };
    return out;
  }
  const out: Record<string, Object> = { 'reasoning_effort': effort };
  return out;
}

/**
 * 组装 chat/completions 请求体（对齐 ai.rs build_request_body）：
 * 可选采样参数仅在有值时携带；thinking 按字段名合并；tools 原样透传。
 */
export function buildChatBody(params: Record<string, Object>, stream: boolean): Record<string, Object> {
  const body: Record<string, Object> = {};
  body['model'] = strField(params['model']) ?? '';
  const messages = params['messages'];
  body['messages'] = messages !== undefined && messages !== null ? messages : [];
  body['stream'] = stream;
  const temperature = numField(params['temperature']);
  body['temperature'] = temperature !== null ? temperature : 0.7;
  const maxTokens = numField(params['maxTokens']);
  if (maxTokens !== null && maxTokens > 0) {
    body['max_tokens'] = maxTokens;
  }
  const topP = numField(params['topP']);
  if (topP !== null) {
    body['top_p'] = topP;
  }
  const thinking = thinkingFields(
    strField(params['provider']) ?? 'custom',
    strField(params['thinkingStrength']) ?? 'off');
  if (thinking !== null) {
    const keys = Object.keys(thinking);
    for (const k of keys) {
      body[k] = thinking[k];
    }
  }
  const tools = params['tools'];
  if (tools !== undefined && tools !== null) {
    body['tools'] = tools;
  }
  return body;
}

/** SSE data 帧行的解析产物（全部可空：role-only 帧 / keepalive 全 null）。 */
export interface StreamDeltaInfo {
  content: string | null;
  reasoning: string | null;
  toolCalls: Array<Object> | null;
  finishReason: string | null;
}

/** 解析一条 SSE data JSON（不可解析/无 choices → null，调用方跳过）。 */
export function parseStreamChunk(data: string): StreamDeltaInfo | null {
  let parsed: Object | null = null;
  try {
    parsed = JSON.parse(data) as Object;
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (root === null) {
    return null;
  }
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const choice = asRecord(choices[0] as Object);
  if (choice === null) {
    return null;
  }
  const delta = asRecord(choice['delta']);
  let content: string | null = null;
  let reasoning: string | null = null;
  let toolCalls: Array<Object> | null = null;
  if (delta !== null) {
    const c = strField(delta['content']);
    if (c !== null && c.length > 0) {
      content = c;
    }
    // reasoning_content（DeepSeek-R1/GLM/Qwen3/Kimi）优先于 reasoning（OpenAI o 系）。
    const rc = strField(delta['reasoning_content']);
    const r = strField(delta['reasoning']);
    const win = rc !== null && rc.length > 0 ? rc : r;
    if (win !== null && win.length > 0) {
      reasoning = win;
    }
    const tcs = delta['tool_calls'];
    if (Array.isArray(tcs)) {
      toolCalls = tcs as Array<Object>;
    }
  }
  const info: StreamDeltaInfo = {
    content: content,
    reasoning: reasoning,
    toolCalls: toolCalls,
    finishReason: strField(choice['finish_reason']),
  };
  return info;
}

/** 聚合中的单个工具调用（空串 = 尚未见到该字段；对齐 ai.rs AggToolCall）。 */
export class AggToolCall {
  id: string = '';
  name: string = '';
  arguments: string = '';
}

/**
 * delta.tool_calls 分片并入聚合表（对齐 ai.rs merge_tool_call_deltas）：
 * index 缺失用数组下标兜底；id/name 取首个非空；arguments 拼接。
 */
export function mergeToolCallDeltas(agg: Map<number, AggToolCall>, deltas: Array<Object>): void {
  for (let i = 0; i < deltas.length; i++) {
    const d = asRecord(deltas[i]);
    if (d === null) {
      continue;
    }
    const idx = numField(d['index']);
    const key = idx !== null ? idx : i;
    let slot = agg.get(key);
    if (slot === undefined) {
      slot = new AggToolCall();
      agg.set(key, slot);
    }
    const id = strField(d['id']);
    if (id !== null && id.length > 0 && slot.id.length === 0) {
      slot.id = id;
    }
    const fn = asRecord(d['function']);
    if (fn !== null) {
      const nm = strField(fn['name']);
      if (nm !== null && nm.length > 0 && slot.name.length === 0) {
        slot.name = nm;
      }
      const args = strField(fn['arguments']);
      if (args !== null) {
        slot.arguments += args;
      }
    }
  }
}

/** 聚合表 → OpenAI 完整 tool_calls 数组（按 index 升序；对齐 finalize_tool_calls）。 */
export function finalizeToolCalls(agg: Map<number, AggToolCall>): Array<Record<string, Object>> {
  const keys: number[] = [];
  agg.forEach((v: AggToolCall, k: number) => {
    keys.push(k);
  });
  keys.sort((a: number, b: number) => a - b);
  const out: Array<Record<string, Object>> = [];
  for (const k of keys) {
    const c = agg.get(k);
    if (c === undefined) {
      continue;
    }
    const fn: Record<string, Object> = { 'name': c.name, 'arguments': c.arguments };
    const item: Record<string, Object> = { 'id': c.id, 'type': 'function', 'function': fn };
    out.push(item);
  }
  return out;
}

/** 取消登记表（语义对齐 ai.rs CancelRegistry：触顶整表清空）。 */
export class CancelRegistry {
  private readonly inner: Map<string, boolean> = new Map();
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  cancel(id: string): void {
    if (this.inner.size >= this.cap) {
      this.inner.clear();
    }
    this.inner.set(id, true);
  }

  isCancelled(id: string): boolean {
    return this.inner.has(id);
  }

  finish(id: string): void {
    this.inner.delete(id);
  }
}

/** 单条流的解析状态（行缓冲 / 解码器 / 聚合表 / 错误体留存）。 */
class StreamState {
  finished: boolean = false;
  lineBuf: string = '';
  errBody: string = '';
  decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
  toolAgg: Map<number, AggToolCall> = new Map();
}

// ---- 桥实现 -----------------------------------------------------------------

export class AiBridge {
  private readonly bridge: Bridge;
  private readonly cancels: CancelRegistry = new CancelRegistry(CANCEL_CAP);
  /** 在途流 requestId → HttpRequest（重载取消 / 主动销毁用）。 */
  private readonly activeStreams: Map<string, http.HttpRequest> = new Map();

  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  registerAll(): void {
    this.bridge.register('ai_chat', (p) => this.aiChat(p));
    this.bridge.register('ai_chat_stream', (p) => this.aiChatStream(p));
    this.bridge.register('ai_chat_cancel', (p) => this.aiChatCancel(p));
    this.bridge.register('ai_embed', (p) => this.aiEmbed(p));
    hilog.info(DOMAIN, 'mditor', 'AiBridge: 四命令已注册');
  }

  /** 页面重载（桥端口重建）：流消费方已消失，全部按取消收尾并断开连接。 */
  onReload(): void {
    const ids: string[] = [];
    this.activeStreams.forEach((v: http.HttpRequest, k: string) => {
      ids.push(k);
    });
    for (const id of ids) {
      this.cancels.cancel(id);
    }
    this.activeStreams.forEach((client: http.HttpRequest) => {
      try {
        client.destroy();
      } catch {
        // 已销毁 — 忽略
      }
    });
  }

  // ---- ai_chat（非流式） ----------------------------------------------------

  async aiChat(params: Record<string, Object>): Promise<Object | null> {
    const baseUrl = this.requireBaseUrl(params);
    const model = strField(params['model']) ?? '';
    if (model.trim().length === 0) {
      throw new BridgeError('E_ARGS', '未配置模型名称，请在「设置 → AI」中填写。');
    }
    const apiKey = strField(params['apiKey']) ?? '';
    const body = buildChatBody(params, false);
    const client = http.createHttp();
    try {
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: this.buildHeaders(apiKey),
        extraData: JSON.stringify(body),
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: REQUEST_TIMEOUT_MS,
        usingCache: false,
      };
      const resp = await client.request(chatUrl(baseUrl), options);
      const code = resp.responseCode;
      const text = typeof resp.result === 'string' ? resp.result as string : '';
      if (code >= 400) {
        throw new BridgeError('E_AI', friendlyError(code, text));
      }
      let parsed: Object | null = null;
      try {
        parsed = JSON.parse(text) as Object;
      } catch (err) {
        throw new BridgeError('E_AI',
          `无法解析 AI 响应（可能 Base URL 不是 OpenAI 兼容接口）：${String(err)}\n原始响应：${truncateErrorBody(text)}`);
      }
      const root = asRecord(parsed);
      const choices = root === null ? undefined : root['choices'];
      let content = '';
      let toolCalls: Object | null = null;
      if (Array.isArray(choices) && choices.length > 0) {
        const choice = asRecord(choices[0] as Object);
        const message = choice === null ? null : asRecord(choice['message']);
        if (message !== null) {
          const c = strField(message['content']);
          if (c !== null) {
            content = c;
          }
          const tc = message['tool_calls'];
          if (tc !== undefined && tc !== null) {
            toolCalls = tc;
          }
        }
      }
      const out: Record<string, Object> = { 'content': content };
      if (toolCalls !== null) {
        out['tool_calls'] = toolCalls;
      }
      return out;
    } catch (err) {
      if (err instanceof BridgeError) {
        throw err;
      }
      const e = err as BusinessError;
      throw new BridgeError('E_AI', networkErrorText(e));
    } finally {
      try {
        client.destroy();
      } catch {
        // 已销毁 — 忽略
      }
    }
  }

  // ---- ai_chat_stream（SSE） --------------------------------------------------

  async aiChatStream(params: Record<string, Object>): Promise<Object | null> {
    const baseUrl = this.requireBaseUrl(params);
    const requestId = strField(params['requestId']) ?? '';
    if (requestId.length === 0) {
      throw new BridgeError('E_ARGS', '参数缺失或类型错误：requestId');
    }
    const model = strField(params['model']) ?? '';
    if (model.trim().length === 0) {
      const msg = '未配置模型名称，请在「设置 → AI」中填写。';
      this.sendStreamError(requestId, msg);
      throw new BridgeError('E_ARGS', msg);
    }
    const apiKey = strField(params['apiKey']) ?? '';
    const body = buildChatBody(params, true);
    const client = http.createHttp();
    this.activeStreams.set(requestId, client);
    const state = new StreamState();
    client.on('dataReceive', (chunk: ArrayBuffer) => {
      this.onDataChunk(state, requestId, chunk, client);
    });
    hilog.info(DOMAIN, 'mditor', 'AiBridge: 流开始 %{public}s', requestId);
    try {
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: this.buildHeaders(apiKey),
        extraData: JSON.stringify(body),
        connectTimeout: CONNECT_TIMEOUT_MS,
        // 流式无总超时（慢而健康的流可跑数分钟）；0 = 不设读超时。
        readTimeout: 0,
        usingCache: false,
      };
      // requestInStream resolve 值即 HTTP 状态码（Promise<number>，无响应体）。
      const code: number = await client.requestInStream(chatUrl(baseUrl), options);
      if (state.finished) {
        return null; // 行内已收尾（[DONE]/finish_reason/取消）
      }
      if (code >= 400) {
        const msg = friendlyError(code, state.errBody);
        this.sendStreamError(requestId, msg);
        throw new BridgeError('E_AI', msg);
      }
      // EOF 无显式终止符：补发未决 tool_calls（安全网）+ done。
      this.emitPendingToolCalls(state, requestId);
      this.sendDone(requestId);
      return null;
    } catch (err) {
      if (state.finished) {
        return null; // destroy 后的迟到拒绝
      }
      if (err instanceof BridgeError) {
        throw err; // ≥400 分支已发事件
      }
      // 重载/取消触发的 destroy：按正常收尾（done 事件对死页面无害）。
      if (this.cancels.isCancelled(requestId)) {
        this.sendDone(requestId);
        return null;
      }
      const msg = networkErrorText(err as BusinessError);
      this.sendStreamError(requestId, msg);
      throw new BridgeError('E_AI', msg);
    } finally {
      state.finished = true;
      this.cancels.finish(requestId);
      this.activeStreams.delete(requestId);
      try {
        client.off('dataReceive');
      } catch {
        // 已销毁 — 忽略
      }
      try {
        client.destroy();
      } catch {
        // 已销毁 — 忽略
      }
      hilog.info(DOMAIN, 'mditor', 'AiBridge: 流结束 %{public}s', requestId);
    }
  }

  // ---- ai_chat_cancel --------------------------------------------------------

  async aiChatCancel(params: Record<string, Object>): Promise<Object | null> {
    const id = strField(params['requestId']);
    if (id !== null && id.length > 0) {
      this.cancels.cancel(id);
      // 主动断连：空闲等下一 chunk 的流也能立即停（不再消耗计费 token）。
      const client = this.activeStreams.get(id);
      if (client !== undefined) {
        try {
          client.destroy();
        } catch {
          // 已销毁 — 忽略
        }
      }
    }
    return null;
  }

  // ---- ai_embed ---------------------------------------------------------------

  async aiEmbed(params: Record<string, Object>): Promise<Object | null> {
    const baseUrl = strField(params['baseUrl']) ?? '';
    if (baseUrl.trim().length === 0) {
      throw new BridgeError('E_ARGS', '未配置嵌入 Base URL，请在「设置 → 知识功能」中填写。');
    }
    const model = strField(params['model']) ?? '';
    if (model.trim().length === 0) {
      throw new BridgeError('E_ARGS', '未配置嵌入模型名称，请在「设置 → 知识功能」中填写。');
    }
    const apiKey = strField(params['apiKey']) ?? '';
    const input = params['input'];
    const inputArr: Array<Object> = Array.isArray(input) ? input as Array<Object> : [];
    if (inputArr.length === 0) {
      const empty: Record<string, Object> = { 'vectors': [] };
      return empty;
    }
    const body: Record<string, Object> = { 'model': model, 'input': inputArr };
    const client = http.createHttp();
    try {
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: this.buildHeaders(apiKey),
        extraData: JSON.stringify(body),
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: REQUEST_TIMEOUT_MS,
        usingCache: false,
      };
      const resp = await client.request(embeddingsUrl(baseUrl), options);
      const code = resp.responseCode;
      const text = typeof resp.result === 'string' ? resp.result as string : '';
      if (code >= 400) {
        throw new BridgeError('E_AI', friendlyError(code, text));
      }
      let parsed: Object | null = null;
      try {
        parsed = JSON.parse(text) as Object;
      } catch (err) {
        throw new BridgeError('E_AI',
          `无法解析嵌入响应（可能不是 OpenAI 兼容 /embeddings 接口）：${String(err)}\n原始响应：${truncateErrorBody(text)}`);
      }
      const root = asRecord(parsed);
      const data = root === null ? undefined : root['data'];
      if (!Array.isArray(data)) {
        throw new BridgeError('E_AI', '无法解析嵌入响应：缺少 data 数组。');
      }
      if (data.length !== inputArr.length) {
        throw new BridgeError('E_AI',
          `嵌入响应数量不匹配：请求 ${inputArr.length} 条，返回 ${data.length} 条。`);
      }
      // data[i].index 指回输入序号；服务器不保证按序返回，按 index 归位。
      const slots: Array<Array<number> | null> = [];
      for (let i = 0; i < inputArr.length; i++) {
        slots.push(null);
      }
      for (let di = 0; di < data.length; di++) {
        const itemObj: Object = data[di] as Object;
        const item = asRecord(itemObj);
        if (item === null) {
          continue;
        }
        const idx = numField(item['index']);
        if (idx === null || idx < 0 || idx >= slots.length) {
          throw new BridgeError('E_AI', `嵌入响应 index 越界：${idx}`);
        }
        const emb = item['embedding'];
        if (!Array.isArray(emb)) {
          continue;
        }
        const vec: Array<number> = [];
        for (let ei = 0; ei < emb.length; ei++) {
          const n = numField(emb[ei] as Object);
          vec.push(n !== null ? n : 0);
        }
        slots[idx] = vec;
      }
      const vectors: Array<Array<number>> = [];
      for (let i = 0; i < slots.length; i++) {
        const v = slots[i];
        if (v === null) {
          throw new BridgeError('E_AI', `嵌入响应缺少第 ${i} 条输入的向量。`);
        }
        vectors.push(v);
      }
      const out: Record<string, Object> = { 'vectors': vectors };
      return out;
    } catch (err) {
      if (err instanceof BridgeError) {
        throw err;
      }
      const e = err as BusinessError;
      const msg = e.message !== undefined ? e.message : String(e.code);
      let text: string;
      if (msg.includes('timeout') || msg.includes('timed out') || e.code === 2300028) {
        text = '嵌入请求超时：请检查网络连接，以及 Base URL 是否可达。';
      } else if (e.code === 2300006 || msg.includes('resolve') || msg.includes('connect')) {
        text = `无法连接到嵌入服务：${msg}。请确认 Base URL 正确且网络可用。`;
      } else {
        text = `嵌入请求失败：${msg}`;
      }
      throw new BridgeError('E_AI', text);
    } finally {
      try {
        client.destroy();
      } catch {
        // 已销毁 — 忽略
      }
    }
  }

  // ---- 流内部 -----------------------------------------------------------------

  /** dataReceive 回调：增量解码 → 行拆分 → 逐行处理；任意终止路径置 finished。 */
  private onDataChunk(state: StreamState, requestId: string, chunk: ArrayBuffer,
    client: http.HttpRequest): void {
    if (state.finished) {
      return;
    }
    if (this.cancels.isCancelled(requestId)) {
      // 前端已取消：停拉上游流，按正常收尾通知。
      this.sendDone(requestId);
      state.finished = true;
      try {
        client.destroy();
      } catch {
        // 已销毁 — 忽略
      }
      return;
    }
    let text = '';
    try {
      // stream:true：多字节 UTF-8 跨 chunk 截断由解码器内部缓冲。
      text = state.decoder.decodeToString(new Uint8Array(chunk), { stream: true });
    } catch {
      text = '';
    }
    if (state.errBody.length < MAX_ERR_BODY) {
      state.errBody += text;
    }
    const combined = state.lineBuf + text;
    const lines = combined.split('\n');
    state.lineBuf = lines.length > 0 ? lines[lines.length - 1] : '';
    for (let i = 0; i < lines.length - 1; i++) {
      if (this.processLine(state, requestId, lines[i], client)) {
        return; // 已终止（done/error 已发射、连接已销毁）
      }
    }
    if (state.lineBuf.length > MAX_LINE_BUF) {
      const msg = `SSE 缓冲区超出上限（${MAX_LINE_BUF} 字节），服务端可能未按行分隔响应。`;
      this.sendStreamError(requestId, msg);
      state.finished = true;
      try {
        client.destroy();
      } catch {
        // 已销毁 — 忽略
      }
    }
  }

  /** 处理一条完整行；返回 true = 流终止。 */
  private processLine(state: StreamState, requestId: string, rawLine: string,
    client: http.HttpRequest): boolean {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith(':')) {
      return false; // 空行 / SSE 注释
    }
    if (!trimmed.startsWith('data:')) {
      return false; // event/id 等不用的行
    }
    const data = trimmed.slice('data:'.length).trim();
    if (data === '[DONE]') {
      // 安全网：部分兼容实现流完 tool_calls 分片却不给显式 finish_reason。
      this.emitPendingToolCalls(state, requestId);
      this.sendDone(requestId);
      state.finished = true;
      try {
        client.destroy();
      } catch {
        // 已销毁 — 忽略
      }
      return true;
    }
    const info = parseStreamChunk(data);
    if (info === null) {
      return false; // 不可解析帧（keepalive 等）— 跳过
    }
    if (info.content !== null) {
      this.sendDelta('ai_stream_chunk', requestId, info.content);
    }
    if (info.reasoning !== null) {
      this.sendDelta('ai_stream_reasoning', requestId, info.reasoning);
    }
    if (info.finishReason === 'stop') {
      this.sendDone(requestId);
      state.finished = true;
      try {
        client.destroy();
      } catch {
        // 已销毁 — 忽略
      }
      return true;
    }
    if (info.finishReason === 'tool_calls') {
      if (state.toolAgg.size > 0) {
        this.emitPendingToolCalls(state, requestId);
      }
      this.sendDone(requestId);
      state.finished = true;
      try {
        client.destroy();
      } catch {
        // 已销毁 — 忽略
      }
      return true;
    }
    if (info.toolCalls !== null) {
      mergeToolCallDeltas(state.toolAgg, info.toolCalls);
    }
    return false;
  }

  /** 流正常收尾时的未决工具调用安全网（空表无操作）。 */
  private emitPendingToolCalls(state: StreamState, requestId: string): void {
    if (state.toolAgg.size === 0) {
      return;
    }
    const payload: Record<string, Object> = {
      'id': requestId,
      'tool_calls': finalizeToolCalls(state.toolAgg),
    };
    this.bridge.sendEvent('ai_stream_tool_calls', payload);
    state.toolAgg.clear();
  }

  private sendDelta(event: string, requestId: string, delta: string): void {
    const payload: Record<string, Object> = { 'id': requestId, 'delta': delta };
    this.bridge.sendEvent(event, payload);
  }

  private sendDone(requestId: string): void {
    const payload: Record<string, Object> = { 'id': requestId };
    this.bridge.sendEvent('ai_stream_done', payload);
  }

  private sendStreamError(requestId: string, error: string): void {
    const payload: Record<string, Object> = { 'id': requestId, 'error': error };
    this.bridge.sendEvent('ai_stream_error', payload);
  }

  // ---- 通用 -------------------------------------------------------------------

  private requireBaseUrl(params: Record<string, Object>): string {
    const baseUrl = strField(params['baseUrl']) ?? '';
    if (baseUrl.trim().length === 0) {
      throw new BridgeError('E_ARGS', '未配置 AI Base URL，请在「设置 → AI」中填写。');
    }
    return baseUrl;
  }

  /** 请求头：apiKey 为空不带 Authorization（Ollama / LM Studio 本地服务）。 */
  private buildHeaders(apiKey: string): Record<string, Object> {
    const h: Record<string, Object> = { 'Content-Type': 'application/json' };
    if (apiKey.trim().length > 0) {
      h['Authorization'] = `Bearer ${apiKey}`;
    }
    return h;
  }
}
