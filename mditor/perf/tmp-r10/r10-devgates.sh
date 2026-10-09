#!/bin/bash
# r10 阶段六 dev 侧门禁批（沿承 r9-devgates.sh 全口径，tag 换 r10）
# 前置：prod 批次已结束（测量隔离，禁止并行）
cd "C:/Users/hh/Desktop/Tp/mditor" || exit 1

# R5a: scroll-abab 1MB vp on ×3（基线 r8r5 p95 中位 165）
for r in 1 2 3; do
  echo "=== R5a scroll-abab round $r ==="
  timeout 600 node perf/scroll-abab.mjs --doc 1MB压测 --viewport on --round $r --duration 60 --tag r10f || echo "R5a-$r EXIT=$?"
done

# R5b: ghost-stress 5min（基线 ghost=11 / anomalies+0 / block.rebase=0）
echo "=== R5b ghost-stress ==="
timeout 900 node perf/ghost-stress.mjs --minutes 5 --tag r10f || echo "R5b EXIT=$?"

# R5c: R8 上滚对称比（两档 up/down 同位对照，修正口径；基线 ≤1.25）
for spec in "1MB压测|up-slow|1" "1MB压测|down-slow|2" "无穷级数_密度档|up-slow|1" "无穷级数_密度档|down-slow|2"; do
  IFS='|' read -r doc sc rn <<< "$spec"
  echo "=== R5c r8probe $doc $sc ==="
  timeout 600 node perf/tmp-r8/probe-jank.mjs --scenario "$sc" --doc "$doc" --tag r10f --run "$rn" --prewarm-wait || echo "R5c-$doc-$sc EXIT=$?"
done

# T1/T2: scroll-flash-bench（normal 臂 ×3，R8 r8t1 同口径；基线 events 0/p95 0、peak 10/durP95 124~130）
for r in 1 2 3; do
  echo "=== T flash-bench round $r ==="
  timeout 600 node perf/scroll-flash-bench.mjs --doc 无穷级数_密度档 --viewport on --scenario upscroll --round $r --tag r10f || echo "T-$r EXIT=$?"
done

# M1+M2: formula-probe traverse（基线 vpUnready=0 / bandUnready=0 / katexErrors=0 / pump.queue=0）
echo "=== M1/M2 formula traverse ==="
timeout 600 node perf/tmp-r6/formula-probe.mjs --scenario traverse --doc 无穷级数_密度档 --tag r10m || echo "M12 EXIT=$?"

# M3: formula-probe blocks（基线 latex 23 / latexK 23 / mountRate 1 / neverK []）
echo "=== M3 formula blocks ==="
timeout 600 node perf/tmp-r6/formula-probe.mjs --scenario blocks --doc 解题技巧 --tag r10m || echo "M3 EXIT=$?"

# R1: open-1mb ×3（基线 4565ms 中位）
echo "=== R1 open-1mb ==="
timeout 600 env MDITOR_DOC=1MB node perf/open-1mb.mjs 3 r10r1 || echo "R1 EXIT=$?"

# R2: g2-typing 密度档 + 1MB（基线 112ms / 404ms）
echo "=== R2 typing density ==="
timeout 600 env MDITOR_DOC=无穷级数_密度档 MDITOR_MIN_BLOCKS=500 node perf/g2-typing.mjs r10r2d || echo "R2d EXIT=$?"
echo "=== R2 typing 1mb ==="
timeout 600 env MDITOR_DOC=1MB MDITOR_MIN_BLOCKS=500 node perf/g2-typing.mjs r10r2m || echo "R2m EXIT=$?"

# R3: switch-bench 20 往返（基线 2010ms 中位）
echo "=== R3 switch ==="
timeout 900 node perf/switch-bench.mjs --doc-a 无穷级数_密度档 --doc-b 解题技巧_密度档 --viewport off --switches 20 --tag r10f || echo "R3 EXIT=$?"

echo "=== dev gates batch done ==="
