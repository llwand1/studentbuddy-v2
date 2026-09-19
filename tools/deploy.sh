#!/usr/bin/env bash
# deploy.sh — 一键发布（本机执行）：check → build → 代码+dist 上传 → 重启 → 健康检查。
# 任一步失败即停（set -e）；服务器信息见根目录《部署手册》。
set -euo pipefail
SERVER=${SERVER:-root@107.172.96.209}
KEY=${KEY:-$HOME/.ssh/id_ed25519}
APP=/opt/studentbuddy/app

npm run check
npm run build

tar -C packages/web -cf - dist | ssh -i "$KEY" "$SERVER" "tar -xf - -C $APP/packages/web/"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .zcode ./ "$SERVER:$APP/"
ssh -i "$KEY" "$SERVER" "systemctl restart studentbuddy && sleep 5 && curl -sf http://127.0.0.1:18791/api/health"
echo "✓ deployed to $SERVER"
