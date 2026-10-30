// Tiny cross-platform path helpers.
//
// We can't use Node's `path` module in the webview, and Tauri paths arrive as
// OS-native strings (backslashes on Windows, forward slashes elsewhere). These
// helpers normalize on `/` internally and return OS-native-ish results. They're
// good enough for joining/parent/basename of absolute paths.

const SEP = "/";

function normalize(p: string): string {
  return p.replace(/\\/g, SEP).replace(/\/+$/, "");
}

export function dirname(p: string): string {
  const n = normalize(p);
  const i = n.lastIndexOf(SEP);
  if (i < 0) return ".";
  if (i === 0) return SEP; // root
  return n.slice(0, i);
}

export function basename(p: string): string {
  const n = normalize(p).replace(/\/+$/, "");
  const i = n.lastIndexOf(SEP);
  return i < 0 ? n : n.slice(i + 1);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i).toLowerCase();
}

export function join(...parts: string[]): string {
  const normed = parts.map(normalize);
  // 首段带根则保留根（Windows 盘符 `E:/` 或 POSIX `/`）：鸿蒙虚拟路径
  // `/Docs/ws-1`、`/AppData` 的前导斜杠是 UriMapper 的解析锚点，剥掉后
  // 全部子路径（树打开/重命名/新建/搜索）都变成「无法解析的虚拟路径」。
  // Windows 桌面首段是盘符（非斜杠），行为与旧实现逐字节一致。
  const root = normed.length > 0 ? (normed[0].match(/^([a-zA-Z]:\/|\/)/)?.[1] ?? "") : "";
  const tail = normed
    .map((p, i) => (i === 0 ? p.slice(root.length) : p).replace(/^\/+/, ""))
    .filter(Boolean)
    .join(SEP);
  return root + tail;
}

/** Join but keep a leading drive/root (Windows `C:/...` or POSIX `/...`). */
export function joinAbs(base: string, ...parts: string[]): string {
  const n = normalize(base);
  const rootMatch = n.match(/^([a-zA-Z]:\/|\/)/);
  const root = rootMatch ? rootMatch[1] : "";
  const tail = [n.slice(root.length), ...parts]
    .map((p) => normalize(p).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join(SEP);
  return root + tail;
}

export function toPosix(p: string): string {
  return normalize(p);
}
