# StudentBuddy v2 · 容器运行时（构建期烘焙 dist）
# ⚠️ EXPERIMENTAL（2026-09-24 定性）：本 Dockerfile 与 docker-compose.yml **从未实机跑通**——
#   线上真实形态是「ssh 直传 + systemd」（DEPLOY.md）。已知最大风险点：better-sqlite3
#   原生模块在 slim 镜像里的编译链。跑通验证前，请不要把 `docker compose up` 当作 quick start，
#   判据与缺口清单见 docs/dev/launch-plan.md §3.5 与 tools/docker/部署切换手册.md。
# ★ **2026-09-27 本机（Windows·Docker Desktop/WSL2）首次实机跑通**：`docker compose build` 成功
#   （better-sqlite3 v11.10.0 命中 node-v127 prebuilt，未走 gyp 现编）；全栈（server+web+caddy）
#   注册→登录→/me→`down` 不带 -v 重起后数据在，实测通过。**但线上服务器尚未切容器形态**
#   （服务器 compose 从未跑过，且现网 80/443 被 systemd caddy 占用＝切换前必停旧形态，见手册 §4）。
#   本地当时的拦路石是镜像拉取源失效（ustc/163 死、换 daocloud 后通），与本文件无关。
# ★ 本文件只烘焙构建产物，挂载/反代编排见 docker-compose.yml；
#   首次上服务器前必须先跑 tools/docker/部署切换手册.md 的构建验证。
FROM node:22-bookworm AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build   # web dist + server dist（esbuild bundle）

FROM node:22-bookworm-slim
WORKDIR /app
# 依赖：走根 pruned package.json（workspaces 展开）；better-sqlite3 若无 prebuilt 需编译工具链
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
# 运行期 env 全部由 compose 注入（见 docker-compose.yml 注释），镜像内不设默认值
EXPOSE 18791
ENV SB_DATA_DIR=/data
CMD ["node", "packages/server/dist/index.js"]
