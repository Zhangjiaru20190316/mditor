import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const fontkit = require("@pdf-lib/fontkit");
const font = fontkit.create(fs.readFileSync("public/assets/fonts/NotoSansSC-Regular.otf"));
const codePoints = JSON.parse(fs.readFileSync("perf/results/rvf-subset/user-codepoints.json", "utf8"));
const subset = font.createSubset();
for (const cp of codePoints) subset.includeGlyph(font.glyphForCodePoint(cp));
const cff = subset.cff;
const ranges = cff.topDict.FDSelect.ranges;
function fdTrue(gid){let fd=ranges[0].fd;for(const r of ranges){if(gid>=r.first)fd=r.fd;else break;}return fd;}

const origSubsetFontdict = subset.subsetFontdict.bind(subset);
subset.subsetFontdict = function(topDict){
  const used_fds = {}; const arr = [];
  const glyphs = [...subset.glyphs];
  const log = [];
  for (let i = 0; i < glyphs.length; i++) {
    const gid = glyphs[i];
    const fd = cff.fdForGlyph(gid);
    if (fd == null) { log.push([i, gid, 'NULL']); continue; }
    if (!used_fds[fd]) { arr.push(fd); used_fds[fd] = true; }
    const mapped = arr.length - 1;
    const expectMapped = arr.indexOf(fd);
    if (i < 40 || mapped !== expectMapped) log.push([i, gid, fd, mapped, arr.join('|')]);
  }
  console.log('first 45 entries:'); console.log(log.slice(0, 45));
  return origSubsetFontdict(topDict);
};
await new Promise((res,rej)=>subset.encodeStream().on('data',()=>{}).on('end',res).on('error',rej));
console.log('done');
