// 轻量 BibTeX 解析器（模块 3「学术引用」，v4.7）。
//
// 目标：自研、零依赖、容错——覆盖 Zotero Better BibTeX 常见导出形态即可
// （article / inproceedings / book / misc / phdthesis / techreport / online
// 等全部按通用条目收下；字段名不设白名单，常用字段由上层格式化层消费）。
// 坏条目跳过并记入 errors（验收口径：真实 Zotero 导出 200+ 条目，坏条目
// 不中断整体解析）。
//
// 支持的语法面：
//   * @type{key, field = {braced}, field = "quoted", field = bare} 与 () 定界；
//   * 值拼接 `a # b`、@string 缩写展开（大小写不敏感）、@comment/@preamble 跳过；
//   * 字段值内花括号嵌套与转义 \{ \}；
//   * author 的 "and" 分隔（花括号内不算）、"Family, Given" / "Given Family"
//     两种人名形态（供 citation.ts 格式化）。
//
// 纯函数模块（无 IO、无 Tauri 依赖），读写盘由 lib/bibliography.ts 编排。

/** 一条文献条目。字段名统一小写；字段值保留原文（含 TeX 花括号），展示层
 *  用 bibFieldText() 清洗。 */
export interface BibEntry {
  /** citekey（原样保留大小写；检索按小写归一）。 */
  key: string;
  /** entry type（小写：article / inproceedings / …）。 */
  type: string;
  /** 字段名（小写）→ 原始值。 */
  fields: Record<string, string>;
}

export interface BibParseResult {
  entries: BibEntry[];
  /** 容错信息（含行号），坏条目跳过不中断。 */
  errors: string[];
}

/** 解析出的作者（family 名用于 author-year 引用与字母序）。 */
export interface BibAuthor {
  family: string;
  given: string;
}

interface ParseState {
  src: string;
  pos: number;
}

function lineAt(src: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function skipWs(s: ParseState): void {
  while (s.pos < s.src.length && /\s/.test(s.src[s.pos])) s.pos++;
}

/** 读到配对 closer（配对计数花括号；转义 \{ \} 跳过）。返回内部内容。
 *  失败（未闭合）时恢复进入位置——调用方的 skipToNextEntry 才能从值内
 *  找到下一条目（容错恢复的关键）。 */
function readBalanced(s: ParseState, open: string): string | null {
  if (s.src[s.pos] !== open) return null;
  const entryPos = s.pos;
  const start = ++s.pos;
  let depth = 1;
  while (s.pos < s.src.length) {
    const ch = s.src[s.pos];
    if (ch === "\\") {
      s.pos += 2;
      continue;
    }
    if (open === "{" && ch === "{") depth++;
    else if ((open === "{" && ch === "}") || (open === "(" && ch === ")")) {
      depth--;
      if (depth === 0) {
        const body = s.src.slice(start, s.pos);
        s.pos++;
        return body;
      }
    }
    s.pos++;
  }
  s.pos = entryPos; // 未闭合：恢复到定界符处，供容错跳转
  return null;
}

/** 一个值片段：{braced} / "quoted" / bare（数字或 @string 缩写）。 */
function readValuePiece(s: ParseState, strings: Map<string, string>): string | null {
  const ch = s.src[s.pos];
  if (ch === "{") {
    const body = readBalanced(s, "{");
    return body === null ? null : body;
  }
  if (ch === '"') {
    // 引号串：花括号内的引号不算结束。
    const start = ++s.pos;
    let depth = 0;
    while (s.pos < s.src.length) {
      const c = s.src[s.pos];
      if (c === "\\") {
        s.pos += 2;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
      else if (c === '"' && depth === 0) {
        const body = s.src.slice(start, s.pos);
        s.pos++;
        return body;
      }
      s.pos++;
    }
    return null;
  }
  // bare word：数字 / 缩写 / 月份缩写。
  const m = s.src.slice(s.pos).match(/^[^\s,#{}()"=]+/);
  if (!m) return null;
  s.pos += m[0].length;
  const word = m[0];
  if (/^\d+$/.test(word)) return word;
  const expanded = strings.get(word.toLowerCase());
  return expanded !== undefined ? expanded : word;
}

/** 值 = 片段（# 片段）*；归一化内部空白（换行折成单空格）。 */
function readValue(s: ParseState, strings: Map<string, string>): string | null {
  const parts: string[] = [];
  for (;;) {
    skipWs(s);
    const piece = readValuePiece(s, strings);
    if (piece === null) return parts.length > 0 ? parts.join("") : null;
    parts.push(piece);
    skipWs(s);
    if (s.src[s.pos] === "#") {
      s.pos++;
      continue;
    }
    break;
  }
  return parts
    .join("")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** 跳过坏条目：前进到下一个「看起来像条目开头」的 @（后随词字符 + 定界符）。 */
function skipToNextEntry(s: ParseState): void {
  while (s.pos < s.src.length) {
    const at = s.src.indexOf("@", s.pos);
    if (at < 0) {
      s.pos = s.src.length;
      return;
    }
    const m = s.src.slice(at, at + 80).match(/^@\s*([A-Za-z]+)\s*[({]/);
    if (m) {
      s.pos = at;
      return;
    }
    s.pos = at + 1;
  }
}

/**
 * 解析 .bib 源文本。容错策略：单条目内部任何语法错 → 记录 error（含行号）
 * 并跳到下一条目；@string 需在引用它之前定义（BibTeX 语义本就如此）。
 */
export function parseBibtex(src: string): BibParseResult {
  const entries: BibEntry[] = [];
  const errors: string[] = [];
  const strings = new Map<string, string>();
  const s: ParseState = { src, pos: 0 };

  while (s.pos < s.src.length) {
    const at = s.src.indexOf("@", s.pos);
    if (at < 0) break;
    s.pos = at + 1;
    skipWs(s);
    const typeM = s.src.slice(s.pos).match(/^[A-Za-z]+/);
    if (!typeM) continue; // 孤立 @（邮箱等）——继续找下一个
    const type = typeM[0].toLowerCase();
    s.pos += typeM[0].length;
    skipWs(s);
    const opener = s.src[s.pos];
    if (opener !== "{" && opener !== "(") continue;
    const closer = opener === "{" ? "}" : ")";

    // @comment/@preamble：整段平衡读取后丢弃（readBalanced 自带 opener）。
    if (type === "comment" || type === "preamble") {
      const body = readBalanced(s, opener);
      if (body === null) skipToNextEntry(s);
      continue;
    }
    s.pos++;
    skipWs(s);
    if (type === "string") {
      // name = value（无 key、无后续字段）。
      const nameM = s.src.slice(s.pos).match(/^[^\s=,]+/);
      if (!nameM) {
        errors.push(`第 ${lineAt(src, at)} 行：@string 缺少名称，已跳过。`);
        skipToNextEntry(s);
        continue;
      }
      s.pos += nameM[0].length;
      skipWs(s);
      if (s.src[s.pos] !== "=") {
        errors.push(`第 ${lineAt(src, at)} 行：@string 语法错误，已跳过。`);
        skipToNextEntry(s);
        continue;
      }
      s.pos++;
      const value = readValue(s, strings);
      if (value === null) {
        errors.push(`第 ${lineAt(src, at)} 行：@string 值缺失，已跳过。`);
        skipToNextEntry(s);
        continue;
      }
      strings.set(nameM[0].toLowerCase(), value);
      skipWs(s);
      if (s.src[s.pos] === closer) s.pos++;
      continue;
    }

    // ---- 普通条目：key, field = value, … ----
    const entryStart = s.pos;
    const keyM = s.src.slice(s.pos).match(/^[^\s,{}()"=]+/);
    if (!keyM) {
      errors.push(`第 ${lineAt(src, at)} 行：@${type} 缺少 citekey，已跳过。`);
      skipToNextEntry(s);
      continue;
    }
    const key = keyM[0];
    s.pos += key.length;
    const fields: Record<string, string> = {};
    let ok = true;

    for (;;) {
      skipWs(s);
      if (s.pos >= s.src.length) {
        errors.push(`第 ${lineAt(src, at)} 行：@${type}「${key}」未闭合，已跳过。`);
        ok = false;
        break;
      }
      if (s.src[s.pos] === closer) {
        s.pos++;
        break;
      }
      if (s.src[s.pos] === ",") {
        s.pos++; // 容忍多余逗号
        continue;
      }
      const nameM = s.src.slice(s.pos).match(/^[A-Za-z][\w+.-]*\s*=/);
      if (!nameM) {
        errors.push(
          `第 ${lineAt(src, s.pos)} 行：@${type}「${key}」字段语法错误，已跳过该条目。`
        );
        ok = false;
        break;
      }
      const fname = nameM[0].replace(/\s*=$/, "").toLowerCase();
      s.pos += nameM[0].length;
      const value = readValue(s, strings);
      if (value === null) {
        errors.push(
          `第 ${lineAt(src, s.pos)} 行：@${type}「${key}」字段 ${fname} 值缺失，已跳过该条目。`
        );
        ok = false;
        break;
      }
      if (!(fname in fields)) fields[fname] = value;
      skipWs(s);
      if (s.src[s.pos] === ",") s.pos++;
      else if (s.src[s.pos] !== closer) {
        errors.push(
          `第 ${lineAt(src, s.pos)} 行：@${type}「${key}」字段间缺少逗号，已跳过该条目。`
        );
        ok = false;
        break;
      }
    }

    if (!ok) {
      skipToNextEntry(s);
      continue;
    }
    if (s.pos === entryStart) continue; // 空条目 @type{}——静默跳过
    // 重复 citekey：后者覆盖前者（Zotero 导出偶发），不计错误。
    const prev = entries.findIndex((e) => e.key.toLowerCase() === key.toLowerCase());
    if (prev >= 0) entries[prev] = { key, type, fields };
    else entries.push({ key, type, fields });
  }

  return { entries, errors };
}

// ---- 字段清洗与人名解析（供格式化层与引用选择器共用） ------------------------

/** 展示用字段文本：剥 TeX 花括号保护、常见强调命令、双空白折叠。 */
export function bibFieldText(entry: BibEntry, field: string): string {
  const raw = entry.fields[field];
  if (!raw) return "";
  return raw
    .replace(/\\[a-zA-Z]+/g, (cmd) =>
      // 保留命令参数文本：\emph{X} 之类在剥括号后剩 X。
      ["\\emph", "\\textit", "\\textbf", "\\mkbibemph", "\\texttt"].includes(cmd) ? "" : cmd
    )
    .replace(/\\[{}%&$#_~^]/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** 花括号感知的作者分隔（BibTeX 的 " and " 只在顶层生效）。 */
function splitTopLevelAnd(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && /^ and /i.test(raw.slice(i, i + 5))) {
      out.push(cur);
      cur = "";
      i += 4;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out
    .map((x) => x.trim())
    .filter((x) => x && !/^(others|other)$/i.test(x));
}

/** 解析 author/editor 字段为人名列表（"Family, Given" / "Given Family"）。 */
export function parseBibAuthors(raw: string): BibAuthor[] {
  if (!raw) return [];
  return splitTopLevelAnd(raw).map((name) => {
    const unbraced = name.replace(/[{}]/g, "").trim();
    const comma = unbraced.indexOf(",");
    if (comma > 0) {
      return {
        family: unbraced.slice(0, comma).trim(),
        given: unbraced.slice(comma + 1).trim(),
      };
    }
    // "Given Family" / "Given von Family"：末词为 family（简化规则）。
    const words = unbraced.split(/\s+/);
    if (words.length <= 1) return { family: unbraced, given: "" };
    return { family: words[words.length - 1], given: words.slice(0, -1).join(" ") };
  });
}

/** 给出名 → 缩写首字母（"John Alan" → "J. A."）。 */
export function initialsOf(given: string): string {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w[0] ? w[0].toUpperCase() + "." : ""))
    .join(" ");
}

/** 按小写 key 检索（citekey 大小写不敏感）。 */
export function findBibEntry(entries: BibEntry[], key: string): BibEntry | null {
  const want = key.trim().toLowerCase();
  return entries.find((e) => e.key.toLowerCase() === want) ?? null;
}
