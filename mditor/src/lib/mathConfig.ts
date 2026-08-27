// 数学渲染配置的模块级开关（v4.6）：useSettings 在设置加载/每次更新时同步
// 维护（不在 effect 里更新——同 setBigDocModeEnabled 的理由：子组件 effect
// 先于父组件执行，同步设置才能保证消费方读到新值）。
//
// 消费方：
//   * renderMarkdown.ts —— autoNumber 驱动 remarkMathNumbering 插件，macros
//     透传给 rehype-katex；processor 缓存按 configSignature 重建。
//   * exportMath.ts —— 导出路径的块级公式再渲染同样读这两项。
//   * useMilkdown.ts —— Crepe Latex 特性的 katexOptions.macros（宏变更触发
//     编辑器重建，autoNumber 不进编辑器）。

export interface MathRenderConfig {
  /** 公式自动编号（\tag 注入），默认 false。 */
  autoNumber: boolean;
  /** 用户自定义 KaTeX 宏（键为 `\NAME`，值为展开式）。 */
  macros: Record<string, string>;
}

export const DEFAULT_MATH_CONFIG: MathRenderConfig = {
  autoNumber: false,
  macros: {},
};

let config: MathRenderConfig = DEFAULT_MATH_CONFIG;

/** 更新数学渲染配置（useSettings 同步调用；初始值与 DEFAULT_SETTINGS 一致）。 */
export function setMathRenderConfig(next: MathRenderConfig): void {
  config = next;
}

/** 读取当前数学渲染配置。 */
export function getMathRenderConfig(): MathRenderConfig {
  return config;
}

/** 配置签名（processor 缓存键）：配置不变则复用同一 processor。 */
export function mathConfigSignature(c: MathRenderConfig = config): string {
  const macroKeys = Object.keys(c.macros).sort();
  const macroPart = macroKeys.map((k) => `${k}=${c.macros[k]}`).join("\n");
  return `${c.autoNumber ? 1 : 0}|${macroPart}`;
}

/**
 * 解析设置里的宏定义 JSON 字符串（`{"\\RR": "\\mathbb{R}"}`）。空串/解析
 * 失败/非对象/值非字符串 → 返回空对象（静默降级，SettingsModal 负责提示格
 * 式，运行时不弹错）。
 */
export function parseMathMacros(json: string): Record<string, string> {
  const trimmed = (json ?? "").trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    // 键统一带反斜杠前缀：KaTeX 宏键必须是 `\NAME` 形态。
    out[k.startsWith("\\") ? k : `\\${k}`] = v;
  }
  return out;
}
