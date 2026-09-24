#!/usr/bin/env bash
# G7 ABAB 交错编排：A = f4ef4f0（math 修复后、性能改动前），B = HEAD。
# select-bench.mjs 自带 reload+打开 1MB 文档+三场景；每臂切换后等 HMR 落定。
# 注：node_modules/@milkdown/plugin-listener 保持 HEAD 补丁态（lazy serializer 读
# 取在 A 代码无 wrapper 时返回同一朴素序列化器，行为等价，不重打补丁）。
set -e
cd "C:/Users/hh/Desktop/Tp/mditor"
A=f4ef4f0
B=HEAD
for round in 1 2 3; do
  for arm in A B; do
    commit=$([ $arm = A ] && echo $A || echo $B)
    echo "=== $(date +%H:%M:%S) round $round arm $arm ($commit) ==="
    git checkout -q $commit
    sleep 4
    node perf/select-bench.mjs "r${round}${arm}" 1
  done
done
git checkout -q main
echo "G7 ABAB done, back on main"
