# Build stage
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /app

# Native dependencies may not ship prebuilt binaries for every supported architecture.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

# 复制源代码并构建
COPY . .
RUN npm run build


# Production stage
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ARG SOURCE_REVISION=unknown
ARG SOURCE_VERSION=worktree
ARG SOURCE_URL=https://github.com/hicocos/tg-vault
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$SOURCE_VERSION \
      org.opencontainers.image.source=$SOURCE_URL

WORKDIR /app

# 安装 sharp 需要的依赖 和 ffmpeg (用于视频处理)
RUN apk add --no-cache vips-dev ffmpeg ca-certificates curl

# 安装 rclone（固定版本；>= 1.73 才有官方 Drime 后端）。官方 tarball 按目标架构安装，
# 仅进生产镜像；装完自检版本号。
ARG TARGETARCH
RUN apk add --no-cache unzip \
    && curl -fsSL "https://downloads.rclone.org/v1.76.0/rclone-v1.76.0-linux-${TARGETARCH}.zip" -o /tmp/rclone.zip \
    && unzip -o /tmp/rclone.zip -d /tmp/rclone \
    && install -m 0755 "/tmp/rclone/rclone-v1.76.0-linux-${TARGETARCH}/rclone" /usr/local/bin/rclone \
    && rm -rf /tmp/rclone /tmp/rclone.zip \
    && apk del unzip \
    && rclone version

# 复制依赖
COPY package*.json ./
RUN apk add --no-cache --virtual .native-build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .native-build-deps

# 复制构建产物
COPY --from=builder /app/dist ./dist
COPY scripts/runtime-supervisor.mjs ./runtime-supervisor.mjs
# 复制数据库方案文件 (esbuild 模式下与 index.js 同级)
COPY --from=builder /app/src/db/schema.sql ./dist/schema.sql
COPY --from=builder /app/src/db/migrations ./dist/migrations

# 创建数据目录
RUN mkdir -p /data/uploads /data/thumbnails /data/previews

# 设置权限
RUN chown -R node:node /app /data

USER node

EXPOSE 51947

CMD ["node", "runtime-supervisor.mjs"]
