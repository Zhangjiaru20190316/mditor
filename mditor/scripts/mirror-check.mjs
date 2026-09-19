// mirror-check.mjs —— SigV4 镜像守卫（N23）。
//
// scripts/sigv4-check.mjs 与 harmony/entry/src/main/ets/net/S3Bridge.ets 的
// SigV4 纯函数是「逐行同构镜像」（sigv4-check.mjs 头注镜像纪律），此前单侧
// 改动没有任何自动拦截，CI 依旧绿。本脚本做词法级比对：
//
//   1. 按函数签名锚点提取两侧函数体（状态机扫描，注释/字符串/模板不干扰）；
//   2. 产出「指纹序列」——按文档顺序的
//        ① 方法调用名（标识符后紧跟 `(`）
//        ② 字符串/模板字面量静态段内容（转义还原后比对）
//        ③ 数值字面量（含紧邻正负号，统一转十进制消 0xD800/0xd800 差）
//      纯标识符/关键字/类型注解不进指纹——.ets 的类型标注（string/boolean/
//      Array<StrPair> 等）与变量重命名天然被忽略，跨语言可比；
//   3. 跨语言语法 shim 归一（两侧零语义差的结构变换，缺一即误报）：
//        - `for (...)` 头部整体跳过：ArkTS 索引 for ↔ JS for-of 的机械差异；
//        - 调用名剔除 { map, push }：JS `.map(fn)` 链 ↔ ArkTS for-of+push。
//   4. 序列不一致 → FAIL，报告函数对与首个分歧 token 及两侧行号。
//
// 覆盖 5 对镜像函数：uriEncode / uriEncodePath / amzDateOf / canonicalQueryOf /
// canonicalRequestOf。mineSign↔signHeaders、mirrorTarget↔buildTarget 是**语义**
// 镜像而非逐行镜像（cfg/ReqTarget 形状不同、签名链 async 化），词法比对必然
// 误报，不纳入；其行为正确性由 sigv4-check.mjs 的 AWS SDK v3 签名器向量比对
// 守住。
//
// 用法：node scripts/mirror-check.mjs [etsPath] [mjsPath]
//       （缺省为仓库内 S3Bridge.ets 与 sigv4-check.mjs；参数供自验/测试用）

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ETS = join(HERE, "..", "harmony", "entry", "src", "main", "ets", "net", "S3Bridge.ets");
const DEFAULT_MJS = join(HERE, "sigv4-check.mjs");

const MIRROR_PAIRS = [
  "uriEncode",
  "uriEncodePath",
  "amzDateOf",
  "canonicalQueryOf",
  "canonicalRequestOf",
];
/** 语法 shim 调用名：JS .map() 链 ↔ ArkTS for-of + push，零语义差。 */
const SHIM_CALLS = new Set(["map", "push"]);
/** 关键字可后随 `(`（return ( / if ( / while ( …），不是调用，不进指纹。 */
const KEYWORD_NON_CALL = new Set([
  "return", "if", "while", "switch", "catch", "typeof", "new", "delete",
  "void", "do", "else", "function", "in", "of", "instanceof", "await", "yield",
]);

// ---- 词法扫描 ---------------------------------------------------------------

/** 转义字符还原（\' \" \\ \` \$ 及常见控制符；未知转义取原字符）。 */
function unescapeChar(c) {
  switch (c) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case "b": return "\b";
    case "f": return "\f";
    case "v": return "\v";
    case "0": return "\0";
    default: return c;
  }
}

/**
 * 扫描 [start, end) 产出指纹 token 序列。
 * stack 元素：'tmpl'（模板静态段）| number（${} 内的花括号深度）。
 * token: { t: 'c'|'s'|'n', v: string, line: number }
 */
function scanTokens(src, start, end, baseLine) {
  const toks = [];
  const stack = [];
  let tmplBuf = "";
  let line = baseLine;
  let i = start;
  const flush = () => {
    if (tmplBuf.length > 0) {
      toks.push({ t: "s", v: tmplBuf, line });
      tmplBuf = "";
    }
  };
  while (i < end) {
    const ch = src[i];
    const top = stack[stack.length - 1];
    if (top === "tmpl") {
      if (ch === "\\") {
        tmplBuf += unescapeChar(src[i + 1]);
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.pop();
        flush();
        i += 1;
        continue;
      }
      if (ch === "$" && src[i + 1] === "{") {
        flush();
        stack.push(1);
        i += 2;
        continue;
      }
      if (ch === "\n") line += 1;
      tmplBuf += ch;
      i += 1;
      continue;
    }
    const inInterp = typeof top === "number";
    if (ch === "\n") { line += 1; i += 1; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i += 1; continue; }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < end && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < end && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let buf = "";
      i += 1;
      while (i < end && src[i] !== ch) {
        if (src[i] === "\\") {
          buf += unescapeChar(src[i + 1]);
          i += 2;
        } else {
          buf += src[i];
          i += 1;
        }
      }
      i += 1;
      toks.push({ t: "s", v: buf, line });
      continue;
    }
    if (ch === "`") {
      stack.push("tmpl");
      tmplBuf = "";
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < end && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      if (word === "for" && !inInterp) {
        i = skipForHeader(src, end, j);
        continue;
      }
      let k = j;
      while (k < end && (src[k] === " " || src[k] === "\t")) k += 1;
      if (src[k] === "(" && !KEYWORD_NON_CALL.has(word)) {
        if (!SHIM_CALLS.has(word)) toks.push({ t: "c", v: word, line });
        i = j;
        continue;
      }
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || ((ch === "-" || ch === "+") && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[-+]?0[xX][0-9a-fA-F]+|^[-+]?[0-9]+(\.[0-9]+)?/
        .exec(src.slice(i, Math.min(end, i + 24)));
      const text = m !== null ? m[0] : ch;
      toks.push({ t: "n", v: String(Number(text)), line });
      i += text.length;
      continue;
    }
    if (ch === "{" && inInterp) {
      stack[stack.length - 1] = top + 1;
      i += 1;
      continue;
    }
    if (ch === "}" && inInterp) {
      if (top === 1) stack.pop();
      else stack[stack.length - 1] = top - 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return toks;
}

/** 跳过 for 头部：从 word 后扫描到配对 ')'（字符串/模板/注释感知）。 */
function skipForHeader(src, end, from) {
  let i = from;
  while (i < end && (src[i] === " " || src[i] === "\t")) i += 1;
  if (src[i] !== "(") return from; // 异常形态：不跳，保守处理
  let depth = 1;
  i += 1;
  while (i < end && depth > 0) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < end && src[i] !== ch) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "`") {
      i += 1;
      while (i < end && src[i] !== "`") {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < end && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < end && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    i += 1;
  }
  return i;
}

// ---- 函数体提取 --------------------------------------------------------------

/** 在 src 中找 NAME 的定义锚点，返回 { scanFrom, parenDepth }。
 *  扫描起点定在定义名之后（名字自身不进指纹）；函数声明形态锚点止于参数
 *  `(`，故初始括号深度为 1。 */
function findAnchor(src, name) {
  const patterns = [
    { re: new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`), parenDepth: 1 },
    { re: new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=`), parenDepth: 0 },
  ];
  for (const p of patterns) {
    const m = p.re.exec(src);
    if (m !== null) return { scanFrom: m.index + m[0].length, parenDepth: p.parenDepth };
  }
  return null;
}

/** 从锚点起状态机扫描，返回函数体 [start, end)（含花括号体或语句分号）。 */
function extractRange(src, anchor, initialParenDepth) {
  const stack = []; // 'tmpl' | number
  let parenDepth = initialParenDepth;
  let braceDepth = 0;
  let i = anchor;
  while (i < src.length) {
    const ch = src[i];
    const top = stack[stack.length - 1];
    if (top === "tmpl") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { stack.pop(); i += 1; continue; }
      if (ch === "$" && src[i + 1] === "{") { stack.push(1); i += 2; continue; }
      i += 1;
      continue;
    }
    if (typeof top === "number") {
      if (ch === "{") { stack[stack.length - 1] = top + 1; i += 1; continue; }
      if (ch === "}") {
        if (top === 1) stack.pop();
        else stack[stack.length - 1] = top - 1;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "`") { stack.push("tmpl"); i += 1; continue; }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "(") { parenDepth += 1; i += 1; continue; }
    if (ch === ")") { parenDepth -= 1; i += 1; continue; }
    if (ch === "{") { braceDepth += 1; i += 1; continue; }
    if (ch === "}") {
      braceDepth -= 1;
      i += 1;
      if (braceDepth === 0 && parenDepth === 0) return [anchor, i];
      continue;
    }
    if (ch === ";" && braceDepth === 0 && parenDepth === 0) return [anchor, i + 1];
    i += 1;
  }
  return [anchor, src.length];
}

function extractFingerprint(src, name) {
  const anchor = findAnchor(src, name);
  if (anchor === null) return null;
  const [start, end] = extractRange(src, anchor.scanFrom, anchor.parenDepth);
  // 行号：锚点之前完整行数 + 1（即锚点定义所在行）
  const lineOfAnchor = src.slice(0, start).split("\n").length;
  return scanTokens(src, start, end, lineOfAnchor);
}

// ---- 比对与输出 ---------------------------------------------------------------

function tokenDesc(tok) {
  if (tok === undefined) return "（序列已尽）";
  if (tok.t === "c") return `call ${tok.v}() @${tok.line}`;
  if (tok.t === "s") return `str ${JSON.stringify(tok.v)} @${tok.line}`;
  return `num ${tok.v} @${tok.line}`;
}

function renderSeq(toks, from, count) {
  return toks.slice(from, from + count)
    .map((t) => (t.t === "c" ? `${t.v}()` : t.t === "s" ? JSON.stringify(t.v) : t.v))
    .join(" ");
}

const etsPath = process.argv[2] ?? DEFAULT_ETS;
const mjsPath = process.argv[3] ?? DEFAULT_MJS;
const etsSrc = readFileSync(etsPath, "utf8");
const mjsSrc = readFileSync(mjsPath, "utf8");

let failed = 0;
for (const name of MIRROR_PAIRS) {
  const etsToks = extractFingerprint(etsSrc, name);
  const mjsToks = extractFingerprint(mjsSrc, name);
  if (etsToks === null || mjsToks === null) {
    failed += 1;
    console.log(`FAIL ${name} —— 锚点缺失：${etsToks === null ? "S3Bridge.ets" : ""}` +
      `${etsToks === null && mjsToks === null ? " 与 " : ""}${mjsToks === null ? "sigv4-check.mjs" : ""} 找不到函数定义（重命名/删除须两侧同步）`);
    continue;
  }
  let diverge = -1;
  const n = Math.max(etsToks.length, mjsToks.length);
  for (let k = 0; k < n; k++) {
    const a = mjsToks[k];
    const b = etsToks[k];
    if (a === undefined || b === undefined || a.t !== b.t || a.v !== b.v) {
      diverge = k;
      break;
    }
  }
  if (diverge < 0) {
    console.log(`PASS ${name}（${mjsToks.length} 项指纹一致）`);
  } else {
    failed += 1;
    console.log(`FAIL ${name} —— 首个分歧 #${diverge}: mjs[${tokenDesc(mjsToks[diverge])}] vs ets[${tokenDesc(etsToks[diverge])}]`);
    console.log(`  mjs: …${renderSeq(mjsToks, Math.max(0, diverge - 2), 6)}…`);
    console.log(`  ets: …${renderSeq(etsToks, Math.max(0, diverge - 2), 6)}…`);
  }
}

console.log(failed === 0
  ? `\n镜像核验全部通过 ✅（${MIRROR_PAIRS.length} 对：${MIRROR_PAIRS.join(" / ")}）`
  : `\n${failed}/${MIRROR_PAIRS.length} 对镜像失同步 ❌ —— 按 sigv4-check.mjs 头注镜像纪律双向同步后重跑`);
process.exit(failed === 0 ? 0 : 1);
