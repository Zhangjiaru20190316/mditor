#!/usr/bin/env bash
# G2 ABAB 交错编排：A = f4ef4f0（math 修复后、性能改动前），B = HEAD。
# 每臂切换后等 HMR 落定再跑同一脚本（脚本自带 reload+打开+同口径打字）。
set -e
cd "C:/Users/hh/Desktop/Tp/mditor"
A=f4ef4f0
B=HEAD
for round in 1 2 3; do
  for arm in A B; do
    commit=$([ $arm = A ] && echo $A || echo $B)
    echo "=== round $round arm $arm ($commit) ==="
    git checkout -q $commit
    sleep 4
    node perf/g2-typing.mjs "r${round}${arm}"
  done
done
git checkout -q main
echo "ABAB done, back on main"
