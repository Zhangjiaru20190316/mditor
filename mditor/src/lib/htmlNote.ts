// 可交互 HTML 笔记（HN 轮，阶段 1）：扩展名 / asset URL / TabItem 纯函数 +
// 导入（拷贝入 vault）。设计铁律见 docs/html-note-spike-report.md：
//   * HTML 笔记是只读视图对象，不进 Milkdown/双链/闪卡/批注/RAG；
//   * 不消毒——隔离由「asset 协议独立 origin + sandbox + capability ACL」承担；
//   * 导入 = 拷贝进 vault（原文件不动，冲突自动改名，绝不覆盖）。
// 副作用面（fs 拷贝）只在本模块的 import* 函数；其余全部纯函数可 vitest。

import { getAdapter } from "../platform";
import { basename, dirname, extname, join, toPosix } from "./path-shim";
import type { TabItem } from "../types";

/** HTML 笔记扩展名集合（与 tauriFs.MD_EXTS 平行的单一来源）。 */
export const HTML_EXTS = new Set([".html", ".htm"]);

/** 文件名/路径是否为 HTML 笔记。 */
export function isHtmlNote(name: string): boolean {
  return HTML_EXTS.has(extname(name).toLowerCase());
}

/** 标签类型判别（TabItem.kind 缺省 = md，兼容既有构造点）。 */
export function isHtmlTab(tab: TabItem | null | undefined): boolean {
  return tab?.kind === "html";
}

/** html 标签的稳定 key：路径归一小写（Windows 大小写不敏感，对齐 tabPathKey）。 */
export function htmlTabKey(path: string): string {
  return `html-${toPosix(path).toLowerCase()}`;
}

/** 由磁盘路径构造 html 标签（dirty 恒 false、content 恒空——只读视图对象）。 */
export function makeHtmlTab(path: string): TabItem {
  return {
    key: htmlTabKey(path),
    path,
    name: basename(path),
    dirty: false,
    content: "",
    kind: "html",
  };
}

/**
 * asset 协议的「目录友好」URL：按路径段编码、保留字面 `/`。
 *
 * spike ②实测：convertFileSrc 对路径整体 encodeURIComponent，分隔符全成
 * %2F —— 文档 URL 无字面斜杠，相对引用（img/link/script src）会全部解析到
 * 协议根而 404。保留斜杠后 RFC 3986 相对解析按目录层级自然工作。
 * 仅 Tauri 运行时改写；其余运行时（harmony 未验证）返回适配器原样输出。
 */
export function assetFrameUrl(path: string): string {
  const raw = getAdapter().app.convertFileSrc(path);
  if (getAdapter().runtime !== "tauri") return raw;
  const m = raw.match(/^([a-zA-Z][\w+.-]*:\/\/[^/]*\/)(.*)$/);
  if (!m) return raw;
  const segments = path.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent);
  return m[1] + segments.join("/");
}

/** 生产 iframe sandbox：允许脚本/表单/弹窗，不给 allow-same-origin
 *  （独立 origin 已由协议保证；sandbox 是第二层，spike 纵深探针证实两层
 *  各自独立成立）。 */
export const HTML_NOTE_SANDBOX = "allow-scripts allow-forms allow-popups";

// ---- 导入（拷贝入 vault）-----------------------------------------------------

/** 浏览器「保存完整网页」的伴随资源目录命名惯例。 */
const COMPANION_SUFFIXES = ["_files", ".assets"];

/** 同目录已占用名集合下的自动改名：`note.html` → `note (1).html`…（纯函数）。 */
export function conflictFreeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!taken.has(cand)) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** 递归拷贝目录（vault 内布局 = 原目录名/原结构；根名冲突自动改名）。
 *  返回根目录最终名 + 拷贝文件清单。 */
async function copyDirTree(
  srcDir: string,
  destDir: string,
  taken: Set<string>
): Promise<{ rootName: string; copied: string[] }> {
  const rootName = conflictFreeName(basename(srcDir), taken);
  taken.add(rootName);
  const copied: string[] = [];
  const stack: Array<[string, string]> = [[srcDir, join(destDir, rootName)]];
  while (stack.length > 0) {
    const [cur, dest] = stack.pop()!;
    const entries = await getAdapter().fs.readDir(cur);
    await getAdapter().fs.mkdir(dest, { recursive: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const from = join(cur, e.name);
      const to = join(dest, e.name);
      if (e.isDirectory) stack.push([from, to]);
      else {
        await copyFileBinary(from, to);
        copied.push(to);
      }
    }
  }
  return { rootName, copied };
}

async function copyFileBinary(from: string, to: string): Promise<void> {
  const bytes = await getAdapter().fs.readFile(from);
  await getAdapter().fs.mkdir(dirname(to), { recursive: true });
  await getAdapter().fs.writeFile(to, new Uint8Array(bytes));
}

export interface HtmlImportResult {
  /** 拷贝清单（from → to），供结果提示。 */
  copied: Array<{ from: string; to: string }>;
  /** 拷贝后 vault 内的 html 文件（导入完成后直接打开第一个）。 */
  htmlFiles: string[];
  /** 目标名因冲突被改名的提示（空串 = 无冲突）。 */
  renamed: string[];
}

/**
 * 把一批外部 HTML 笔记（.html 文件与/或包含资源的文件夹）拷贝进 vault 根。
 * 不做任何内容转换；同名冲突自动改名（绝不覆盖）；隐藏文件跳过。
 * 伴随资源目录惯例（`<stem>_files` / `<stem>.assets`）随单文件导入一并带走。
 */
export async function importHtmlNotes(
  sources: string[],
  vaultRoot: string
): Promise<HtmlImportResult> {
  const res: HtmlImportResult = { copied: [], htmlFiles: [], renamed: [] };
  const fs = getAdapter().fs;
  const rootTaken = new Set<string>(
    (await fs.readDir(vaultRoot).catch(() => [])).map((e) => e.name)
  );

  for (const src of sources) {
    const st = await fs.stat(src).catch(() => null);
    if (!st) continue;
    if (st.isDirectory) {
      const { rootName, copied } = await copyDirTree(src, vaultRoot, rootTaken);
      if (rootName !== basename(src)) {
        res.renamed.push(`${basename(src)} → ${rootName}`);
      }
      for (const to of copied) {
        res.copied.push({ from: src, to });
        if (isHtmlNote(to)) res.htmlFiles.push(to);
      }
      continue;
    }
    if (!isHtmlNote(src)) continue;
    const name = basename(src);
    const destName = conflictFreeName(name, rootTaken);
    if (destName !== name) res.renamed.push(`${name} → ${destName}`);
    rootTaken.add(destName);
    const dest = join(vaultRoot, destName);
    await copyFileBinary(src, dest);
    res.copied.push({ from: src, to: dest });
    res.htmlFiles.push(dest);
    // 伴随资源目录惯例：整目录拷贝到 vault 根（同名跟随改名，避免半新半旧）。
    const stem = name.slice(0, name.length - extname(name).length);
    for (const suf of COMPANION_SUFFIXES) {
      const companion = join(dirname(src), stem + suf);
      const cst = await fs.stat(companion).catch(() => null);
      if (cst?.isDirectory) {
        await copyDirTree(companion, vaultRoot, rootTaken);
      }
    }
  }
  return res;
}
