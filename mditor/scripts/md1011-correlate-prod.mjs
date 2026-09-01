// MD-1011 侦查脚本：把 prod dev-events.log 中 pm:rebuild 与前后事件对齐。
import fs from "fs";

const f = "C:/Users/hh/Desktop/Tp/mditor/docs/overhaul/md1011-evidence/prod-dev-events.log";
const lines = fs
  .readFileSync(f, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
console.log("events:", lines.length);
const kinds = {};
for (const e of lines) kinds[e.kind ?? e.src] = (kinds[e.kind ?? e.src] || 0) + 1;
console.log(JSON.stringify(kinds));
const rebuilds = lines.filter((e) => e.kind === "pm:rebuild");
console.log("rebuilds:", rebuilds.length);
for (const r of rebuilds.slice(0, 14)) {
  const rt = Date.parse(r.ts);
  const near = lines
    .filter((e) => {
      const t = Date.parse(e.ts);
      return t >= rt - 3000 && t <= rt + 300;
    })
    .map(
      (e) =>
        `${Math.round(Date.parse(e.ts) - rt)}ms ${e.kind ?? e.src}${e.msg ? " | " + String(e.msg).slice(0, 70) : ""}`
    );
  console.log(`\n=== ${r.ts} -${r.data?.removed}/+${r.data?.added} ===`);
  for (const n of near) console.log("  " + n);
}
