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
  return parts
    .map(normalize)
    .map((p) => p.replace(/^\/+/, ""))
    .filter(Boolean)
    .join(SEP);
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
