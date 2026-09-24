#!/usr/bin/env bash
# G6 修复验证：相邻交错 A-on/B-on/A-off/B-off × 2 组（共 8 轮次）。
# A = f4ef4f0（优化前），B = main（含 R1b+ 调参）。
cd "C:/Users/hh/Desktop/Tp/mditor" || exit 1
A=f4ef4f0
B=main
DOC=一元微分学习题集_1MB压测副本
run1 () {
  for try in 1 2 3; do
    node perf/scroll-abab.mjs --doc "$DOC" --viewport "$1" --round "$2" --tag g6v && return 0
    echo "  !! 失败（第 $try 次）"
    netstat -ano 2>/dev/null | grep ":1420.*LISTENING" | awk '{print $NF}' | sort -u | while read pid; do
      echo "  清理孤儿 vite $pid"; taskkill //F //PID $pid 2>/dev/null
    done
    sleep 2
  done
  return 1
}
fail=0
for grp in 1 2; do
  echo "=== $(date +%H:%M:%S) group $grp ==="
  git checkout -q $A || exit 1; run1 on  "v$grp-A-on"  || fail=1
  git checkout -q $B || exit 1; run1 on  "v$grp-B-on"  || fail=1
  git checkout -q $A || exit 1; run1 off "v$grp-A-off" || fail=1
  git checkout -q $B || exit 1; run1 off "v$grp-B-off" || fail=1
done
git checkout -q main
echo "G6 verify done, fail=$fail"
