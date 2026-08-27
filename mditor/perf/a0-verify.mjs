import fs from 'node:fs';
const base = process.env.APPDATA + '/com.mditor.app/logs/';
const anoms = fs.readFileSync(base + 'dev-anomalies.log', 'utf8').split('\n').filter(Boolean);
for (const l of anoms) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.code !== 'MD-1003') continue;
  if (!j.ts.startsWith('2026-08-27T07:1') && !j.ts.startsWith('2026-08-27T07:2')) continue;
  const acts = (j.data?.ctx?.actions || []).slice(-6).map(a => {
    const t = new Date(a.ts).toISOString().slice(11, 19);
    return `${t} ${a.kind}:${(a.label || '').slice(0, 40)}`;
  });
  console.log('---', j.ts, 'dur=' + j.data?.durationMs + 'ms name=' + j.data?.name);
  console.log('  actions(tail):'); for (const a of acts) console.log('   ', a);
  const d = j.data?.ctx?.doc; if (d) console.log('  doc:', d.chars, 'chars', d.lines, 'lines', (d.path || '').split('\\').pop());
}
