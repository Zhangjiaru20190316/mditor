#!/usr/bin/env bash
# G6 代码版本 ABAB：A = f4ef4f0（优化前），B = HEAD(main)。scroll-abab 自管实例。
# 冷启动偶发「文件树 0 行」竞态（getWorkspaces 冷启动读空，reload 即恢复，
# 与代码臂无关，本轮复现 3 失败后 3 成功）——单次失败退出码 2 时重试至多 2 次。
# 每轮 4 臂：A-on A-off B-on B-off；r2 反序平衡漂移。共 12 轮次 × ~100s。
cd "C:/Users/hh/Desktop/Tp/mditor" || exit 1
A=f4ef4f0
B=main
DOC=一元微分学习题集_1MB压测副本
run1 () { # $1=vp $2=round-label
  for try in 1 2 3; do
    node perf/scroll-abab.mjs --doc "$DOC" --viewport "$1" --round "$2" --tag g6ab && return 0
    echo "  !! scroll-abab 失败（第 $try 次），$([ $try = 3 ] && echo 放弃 || echo 重试)"
  done
  return 1
}
run4 () { # $1=commit $2=arm
  git checkout -q "$1" || return 1
  run1 on  "$2-on"  || return 1
  run1 off "$2-off" || return 1
}
fail=0
for round in 1 2 3; do
  echo "=== $(date +%H:%M:%S) round $round ==="
  if [ "$round" = 2 ]; then
    run4 "$B" B || fail=1
    run4 "$A" A || fail=1
  else
    run4 "$A" A || fail=1
    run4 "$B" B || fail=1
  fi
done
git checkout -q main
echo "G6 ABAB done, back on main, fail=$fail"
