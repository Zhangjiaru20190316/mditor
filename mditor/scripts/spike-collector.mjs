// 阶段 0 Spike 采集器（dev 工具，不参与构建产物）。
// 用法：node scripts/spike-collector.mjs [输出文件]
// 监听 127.0.0.1:8901，接收测试页 POST 的自检 JSON；同一 page 取最后一条。
// 测试页在无采集器时静默失败，平时跑应用不受影响。

import { createServer } from "node:http";
import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const out = process.argv[2] ?? "spike-report.jsonl";
const latest = new Map();

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      const obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (obj?.kind !== "html-note-spike") throw new Error("bad kind");
      latest.set(obj.page ?? "?", obj);
      const line = JSON.stringify(obj) + "\n";
      appendFileSync(out, line);
      process.stdout.write(
        `[collector] ${obj.page} @${new Date(obj.at ?? Date.now()).toISOString()} ` +
          `hard=${(obj.checks ?? []).filter((c) => c.hard).map((c) => (c.pass ? "✓" : "✗") + c.id).join(" ")}\n`
      );
    } catch (e) {
      process.stdout.write(`[collector] 丢弃一条：${e}\n`);
    }
    res.writeHead(204);
    res.end();
  });
});

server.listen(8901, "127.0.0.1", () => {
  if (existsSync(out)) {
    // 冷启动：从既有 jsonl 恢复 last（多次采证不丢早前结论）。
    for (const line of readFileSync(out, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o?.kind === "html-note-spike") latest.set(o.page ?? "?", o);
      } catch { /* 忽略坏行 */ }
    }
  }
  writeFileSync(out + ".latest", "");
  process.stdout.write(`[collector] listening on http://127.0.0.1:8901 → ${out}\n`);
});
