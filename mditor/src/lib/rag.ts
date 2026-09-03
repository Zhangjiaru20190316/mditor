// 库级问答（RAG）纯函数（模块 5，v4.7）：按标题分节分块、余弦相似、top-k
// 检索与问答消息组装。嵌入调用经注入面进入（测试 mock、生产走
// lib/ai.embedTexts → Rust ai_embed——铁律 1：渲染层不得直连外网）。
//
// 分块策略（docs/research-features.md）：按标题分节（H1-H6 均切段语境），
// 节内文本按 ~1200 字符（约 500 token）切分，块间重叠 1 句；块文本携带
// 「文件标题 > 节标题」前缀以保留语境。

import type { ChatMessage } from "./ai";

/** 单块目标字符数（≈500 token，中英混合按 2.4 字符/token 估算）。 */
export const CHUNK_TARGET_CHARS = 1200;
/** 碎片下限：短于此的节/残段不进索引。 */
export const MIN_CHUNK_CHARS = 4;
/** 块间重叠句数。 */
export const CHUNK_OVERLAP_SENTENCES = 1;
/** 检索返回的来源块数。 */
export const RAG_TOP_K = 8;

export interface RagChunk {
  /** path\u0000line 的稳定 id。 */
  id: string;
  path: string;
  /** 所属节标题（最近的 heading 文本；文首为空串）。 */
  heading: string;
  /** 块文本（含「文件标题 > 节标题」语境前缀，供嵌入与上下文拼装）。 */
  text: string;
  /** 块源文本的内容哈希（缓存嵌入向量的键）。 */
  hash: string;
  /** 起始行（0-based）。 */
  line: number;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)\s*$/;

/** FNV-1a（与 lib/flashcards 同源；非密码学，作内容指纹）。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function splitSentences(text: string): string[] {
  // 中英句末标点后切分（保留标点）；无标点的长文本退化为整段。
  const parts = text.split(/(?<=[。！？!?])/).filter((s) => s.trim());
  if (parts.length > 1) return parts;
  return text.split(/(?<=\.)\s+/).filter((s) => s.trim());
}

/**
 * 单文档分块。`title` 为文件标题（vaultIndex 条目），进块文本前缀。
 * 代码围栏整体归入当前节（按原文行拼接，不特殊处理——嵌入模型对代码块
 * 的检索价值通常较低，但保持原文有利于引用回看）。
 */
export function chunkDocument(title: string, content: string, path: string): RagChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: RagChunk[] = [];
  let heading = "";
  let buf: string[] = [];
  let bufStartLine = 0;

  const flush = (endLine: number) => {
    const body = buf.join("\n").trim();
    buf = [];
    if (body.length < MIN_CHUNK_CHARS) return; // 空节/极短碎片不进索引
    const prefix =
      heading && heading !== title ? `${title} > ${heading}` : title || heading;
    const text = prefix ? `${prefix}\n${body}` : body;
    chunks.push({
      id: `${path}\u0000${bufStartLine}`,
      path,
      heading,
      text,
      hash: fnv1a(text),
      line: bufStartLine,
    });
    // 重叠：保留末 1 句作为下一块开头（bufStartLine 相应前移不可精确——
    // 以句为单位的行近似即可，重叠只为召回，不做位置精确性承诺）。
    const tail = splitSentences(body).slice(-CHUNK_OVERLAP_SENTENCES).join("");
    if (tail && tail.length < body.length) {
      buf = [tail];
    }
    bufStartLine = endLine;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(HEADING_RE);
    if (m) {
      flush(i);
      heading = m[2].trim();
      bufStartLine = i;
      continue;
    }
    buf.push(line);
    if (buf.join("\n").length >= CHUNK_TARGET_CHARS) {
      flush(i + 1);
    }
  }
  flush(lines.length);
  return chunks;
}

/** 余弦相似（零向量防护）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ScoredChunk {
  chunk: RagChunk;
  score: number;
}

/** 全量余弦打分取 top-k（块数与查询量级下线性扫描足够）。 */
export function topKBySimilarity(
  query: number[],
  entries: Array<{ chunk: RagChunk; vector: number[] }>,
  k = RAG_TOP_K
): ScoredChunk[] {
  return entries
    .map((e) => ({ chunk: e.chunk, score: cosineSimilarity(query, e.vector) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export interface RagSource {
  path: string;
  /** 文件显示名（basename 去扩展名）。 */
  name: string;
  heading: string;
  snippet: string;
  score: number;
}

/** ScoredChunk → UI 来源条目（snippet 裁剪）。 */
export function toSources(scored: ScoredChunk[]): RagSource[] {
  return scored.map(({ chunk, score }) => {
    const name =
      chunk.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? chunk.path;
    return {
      path: chunk.path,
      name,
      heading: chunk.heading,
      snippet: chunk.text.length > 300 ? chunk.text.slice(0, 299) + "…" : chunk.text,
      score,
    };
  });
}

/** 全库问答的系统提示 + 上下文消息（流式回答复用 AiPanel 的 chatStream）。 */
export function buildRagMessages(question: string, sources: RagSource[]): ChatMessage[] {
  const blocks = sources
    .map(
      (s, i) =>
        `<source index="${i + 1}" file="${s.name}" heading="${s.heading}">\n${s.snippet}\n</source>`
    )
    .join("\n\n");
  const system = [
    "你是 Mditor 笔记库的检索问答助手。用户对整个笔记库提问，下面给出",
    "与问题最相关的笔记片段（<source> 标注来源文件与节标题）。",
    "",
    "回答要求：",
    "- 优先依据 <source> 片段作答；片段不足以回答时明确说明「笔记库中未找到",
    "  直接相关的内容」，再谨慎补充常识并注明是补充；",
    "- 回答末尾不要罗列来源（界面会自动展示可点击的来源列表）；",
    "- 涉及代码用 Markdown 代码块；涉及公式用 LaTeX（$...$ / $$...$$）。",
  ].join("\n");
  const user = `${question}\n\n<context>\n${blocks || "（无相关片段）"}\n</context>`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
