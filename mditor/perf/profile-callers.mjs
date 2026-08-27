// 解析 .cpuprofile：对指定函数名聚合「调用方链」，看谁在强制布局。
import { readFileSync } from "node:fs";
import { argv } from "node:process";

const file = argv[2] ?? "perf/results/profile-click.cpuprofile";
const needle = argv[3] ?? "getBoundingClientRect";
const profile = JSON.parse(readFileSync(file, "utf8"));

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, byId.get(c)?.id ? c : c) || parent.set(c, n.id);

// 重新构建 parent map（上面写得绕，直接来）
const parentId = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parentId.set(c, n.id);

const self = new Map(); // nodeId → us
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
}

// 目标节点：函数名匹配 needle
const targets = profile.nodes.filter((n) => n.callFrame.functionName === needle);
console.log(`nodes named ${needle}:`, targets.length);

// 按「调用栈签名（向上 4 层）」聚合 self 时间
const stackAgg = new Map();
for (const t of targets) {
  let us = 0;
  for (const [id, u] of self) if (id === t.id) us += u;
  // 其实 self map 按 nodeId 聚合过了：直接取
  us = self.get(t.id) ?? 0;
  if (!us) continue;
  const chain = [];
  let cur = t.id;
  for (let i = 0; i < 5 && cur != null; i++) {
    const n = byId.get(cur);
    if (!n) break;
    const cf = n.callFrame;
    chain.push(`${cf.functionName || "(anon)"}@${(cf.url || "").split("/").slice(-1)[0]}:${cf.lineNumber + 1}`);
    cur = parentId.get(cur);
  }
  const key = chain.join(" ← ");
  stackAgg.set(key, (stackAgg.get(key) ?? 0) + us);
}
const sorted = [...stackAgg.entries()].sort((a, b) => b[1] - a[1]);
let sum = 0;
for (const [k, us] of sorted) sum += us;
console.log("total self in targets:", Math.round(sum / 1000) + "ms");
for (const [k, us] of sorted.slice(0, 15)) {
  console.log(String(Math.round(us / 1000)).padStart(6) + "ms  " + k);
}
