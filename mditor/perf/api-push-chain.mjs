// GitHub Git Data API 链式推送（github.com 443 不通、api.github.com 通时的
// 应急通道）：把本地领先远端的整条提交链逐个复刻上推（blob 去重 + SHA 校验，
// 每个提交的最终 SHA 与本地一致——git 对象全部内容寻址）。用法：
//   node perf/api-push-chain.mjs            # 自动检测 remote main 落后点
import { execFile } from "node:child_process";
import { promisify } from "node:util";


const run = promisify(execFile);
const ROOT = new URL("../../", import.meta.url); // git 仓库根是 Tp 工作区（mditor 为子目录）
const REPO = "Zhangjiaru20190316/mditor";
const TOKEN = (await run("gh", ["auth", "token"])).stdout.trim();
const git = async (...args) => (await run("git", args, { cwd: ROOT })).stdout;
/** 原始 blob 字节（绕开工作区 CRLF 转换——cat-file 直读对象库，buffer 编码二进制安全）。 */
const gitBuf = async (...args) =>
  (await run("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 })).stdout;

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mditor-release",
      ...(init.body && { "Content-Type": "application/json" }),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// ---- 0. 链区间：remote main（含）→ 本地 main（不含）----
const ref = await api(`/repos/${REPO}/git/ref/heads/main`);
const remoteSha = ref.object.sha;
const localMain = (await git("rev-parse", "main")).trim();
// 远端 tip 可能是 API 复刻 SHA（本地无此对象）——用 MDITOR_API_PUSH_BASE
// 指定「已知已推送」的本地基准提交（缺省尝试直接 rev-list）。
let chain;
try {
  chain = (await git("rev-list", "--reverse", `${remoteSha}..${localMain}`))
    .trim()
    .split("\n")
    .filter(Boolean);
} catch (e) {
  const base = process.env.MDITOR_API_PUSH_BASE;
  if (!base) throw e;
  chain = (await git("rev-list", "--reverse", `${base}..${localMain}`))
    .trim()
    .split("\n")
    .filter(Boolean);
}
console.log(`远端 ${remoteSha.slice(0, 7)} → 本地 ${localMain.slice(0, 7)}：${chain.length} 个提交待复刻`);

// 已上传 blob 缓存（本地 SHA → 已确认）：同内容跨提交只传一次。
const uploaded = new Set();
// 远端实际的父提交 SHA（首个 = remote main；若某提交元数据取整导致 SHA
// 漂移，后续提交的 parent 用远端实际值——内容一致，SHA 链在远端自洽）。
let remoteParent = remoteSha;

for (const commit of chain) {
  const parent = (await git("rev-parse", `${commit}^`)).trim();
  const diff = await git("diff-tree", "-r", "--no-renames", parent, commit);
  const entries = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith(":")) continue;
    const m = line.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (?:[A-Z]\t)?(.+)$/);
    if (!m) throw new Error(`diff-tree 行解析失败: ${line}`);
    const [, oldMode, newMode, , newSha, rawPath] = m;
    const path = rawPath.replace(/^"|"$/g, "");
    if (newMode === "000000") {
      entries.push({ path, mode: oldMode, type: "blob", sha: null });
      continue;
    }
    if (!uploaded.has(newSha)) {
      const buf = await gitBuf("cat-file", "blob", newSha);
      const blob = await api(`/repos/${REPO}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: buf.toString("base64"), encoding: "base64" }),
      });
      if (blob.sha !== newSha) throw new Error(`blob SHA 不一致 ${path}: ${blob.sha} != ${newSha}`);
      uploaded.add(newSha);
    }
    entries.push({ path, mode: newMode, type: "blob", sha: newSha });
  }
  const parentTree = (await git("rev-parse", `${parent}^{tree}`)).trim();
  const localTree = (await git("rev-parse", `${commit}^{tree}`)).trim();
  const tree = entries.length
    ? await api(`/repos/${REPO}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: parentTree, tree: entries }),
      })
    : { sha: parentTree };
  if (tree.sha !== localTree) throw new Error(`tree SHA 不一致 @${commit.slice(0, 7)}: ${tree.sha} != ${localTree}`);

  const meta = await git("log", "-1", "--format=%an%x00%ae%x00%aI%x00%cI", commit);
  const [an, ae, aI, cI] = meta.trim().split("\x00");
  const body = (await run("git", ["log", "-1", "--format=%B", commit], { cwd: ROOT })).stdout;
  const created = await api(`/repos/${REPO}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: body,
      tree: tree.sha,
      parents: [remoteParent],
      author: { name: an, email: ae, date: aI },
      committer: { name: an, email: ae, date: cI },
    }),
  });
  const ok = created.sha === commit ? "精确" : `SHA 漂移(${created.sha.slice(0, 7)})`;
  console.log(`commit ${commit.slice(0, 7)} ${ok}  ${body.split("\n")[0].slice(0, 46)}`);
  remoteParent = created.sha;
  await api(`/repos/${REPO}/git/refs/heads/main`, {
    method: "PATCH",
    body: JSON.stringify({ sha: created.sha, force: false }),
  });
}
console.log("完成：远端 main 已推进至本地 HEAD 内容。");
