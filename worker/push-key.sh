#!/bin/sh
# 把 .dev.vars 里的 key 推进 Cloudflare Pages 项目的 secret（key 不回显、不进产物）。
# 用法：在 worker/ 目录执行 ./push-key.sh
set -e
cd "$(dirname "$0")"

KEY=$(sed -n 's/^MOMO_API_KEY=//p' .dev.vars | tail -1 | tr -d '\r' | sed 's/^ *//;s/ *$//')
if [ -z "$KEY" ]; then
  echo "还没填：请先编辑 worker/.dev.vars，把 MOMO_API_KEY= 后面写上你的 key。"
  exit 1
fi

printf '%s' "$KEY" | npx --yes wrangler@3 pages secret put MOMO_API_KEY --project-name momo-chat-api
echo ""
echo "已推送。等 5~10 秒后验证："
echo "  curl -s https://momo-chat-api.pages.dev/chat"
