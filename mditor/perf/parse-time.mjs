// 页内测量 worker 管线的 remark 解析耗时（当前 fixture 文档）。
import { findPageTarget, Cdp } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const r = await cdp.eval(`(async () => {
  const { buildEditorParseProcessor, parseMarkdownTree } = await import('/src/lib/remarkPipeline.ts');
  const content = await window.__TAURI_INTERNALS__.invoke('plugin:fs|read_text_file', { path: 'C:/Users/hh/Desktop/Tp/mditor/perf/fixtures/一元微分学习题集_CMC备战.md' });
  const proc = buildEditorParseProcessor(true);
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const tree = parseMarkdownTree(proc, content);
    runs.push(Math.round(performance.now() - t0));
    if (!tree && i === 0) return { error: 'no tree' };
  }
  return { runs, chars: content.length };
})()`);
console.log(JSON.stringify(r));
cdp.close();
