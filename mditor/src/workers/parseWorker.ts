/// <reference lib="webworker" />
// 后台解析 worker（阶段 2）：接收 UTF-8 ArrayBuffer（Transferable，零拷贝），
// 用与编辑器一致的 remark 管线（lib/remarkPipeline）做结构化解析，把 mdast
// 树（纯 JSON，结构化克隆传回）交还主线程做轻量映射。
//
// 失败策略：任何异常都作为 {ok:false} 回传，主线程回退到原地解析（现状
// 兜底），worker 不重试、不退出——下一次请求照常处理。

import { buildEditorParseProcessor, parseMarkdownTree } from "../lib/remarkPipeline";
import type { ParseReply, ParseRequest } from "../lib/parseShared";

const processors = new Map<boolean, ReturnType<typeof buildEditorParseProcessor>>();

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { id, bytes, withMath } = e.data;
  let reply: ParseReply;
  try {
    const markdown = new TextDecoder().decode(bytes);
    let proc = processors.get(withMath);
    if (!proc) {
      proc = buildEditorParseProcessor(withMath);
      processors.set(withMath, proc);
    }
    const tree = parseMarkdownTree(proc, markdown);
    reply = { id, ok: true, tree };
  } catch (err) {
    reply = { id, ok: false, error: String(err) };
  }
  (self as unknown as Worker).postMessage(reply);
};
