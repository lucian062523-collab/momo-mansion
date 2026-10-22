#!/bin/bash
# 串行构建锁：多个 agent 同时跑 build_dist.py 会互相踩 dist/，所以统一从这里进。
# 用法：bash _tools/build_locked.sh [--zip|--single]
set -e
cd "$(dirname "$0")/.."
LOCK=/tmp/momo_build.lock
for i in $(seq 1 900); do
  if mkdir "$LOCK" 2>/dev/null; then
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    /usr/bin/python3 _tools/build_dist.py "$@"
    exit $?
  fi
  sleep 2
done
echo "[build_locked] 等锁超时（30 分钟），可能有人在构建；先确认 pgrep -fl build_dist.py" >&2
exit 1
