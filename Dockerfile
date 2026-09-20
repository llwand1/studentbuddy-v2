# StudentBuddy v2 · 容器运行时（构建期烘焙 dist）
# ★ 本文件只烘焙构建产物，挂载/反代编排见 docker-compose.yml；
#   首次上服务器前必须先跑 §docker/部署切换手册.md 的构建验证（better-sqlite3 原生编译是已知风险点）。
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
