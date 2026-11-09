#!/usr/bin/env bash
# TG Vault 一键更新代理（host 侧边车）。
#
# 面板后端只在共享的 /data 卷下写请求文件，本脚本轮询并执行更新。
# 协议文件（UPDATE_DIR，默认 /data/update）：
#   request.json   后端写入：{ id, requestedAt, buildFromSource }
#   heartbeat.json 本脚本每 10 秒写：{ at, version }
#   status.json    本脚本写：{ id, state, step, startedAt, finishedAt,
#                              fromSha, toSha, error, logTail }
#   lock/          执行期间的单例锁目录，超 30 分钟视为过期。
#
# 执行步骤与 deploy/install.sh 的 update_source + deploy/DEPLOY.md 第 3 节
# 手动升级命令语义一致：预检（git 仓库、非 detached HEAD、树干净、可 fetch）
# → 记录更新前 SHA 与镜像 → git 快进 → 拉取或构建镜像 → 校验前后端镜像
# 同属一个源码修订 → 停旧应用 → 数据库 plan/migrate → 替换应用 → 等 /readyz。
# 失败不自动回滚，只保留现场并写 failed 状态；回滚靠升级前备份 + 旧镜像。
#
# 环境变量：
#   PROJECT_DIR         项目目录（compose 文件所在目录），默认 /project
#   UPDATE_DIR          协议目录，默认 /data/update
#   BACKEND_URL         后端 /readyz 地址，默认 http://backend:51947/readyz
#   COMPOSE_PROJECT_NAME  Compose 项目名，默认 tg-vault（必须与安装器一致，
#                       否则会另建一个项目！不要用目录名自动推导）
#   HEALTH_TIMEOUT      健康等待秒数，默认 180
#   UPDATE_TIMEOUT_SECONDS 单次更新总超时，默认 900（15 分钟）
#   POLL_INTERVAL       轮询间隔秒数，默认 10
#   DRY_RUN=1           只打印计划步骤，不执行任何 git/docker 命令（用于测试）
set -Eeuo pipefail

UPDATER_VERSION="1.0.0"
PROJECT_DIR="${PROJECT_DIR:-/project}"
UPDATE_DIR="${UPDATE_DIR:-/data/update}"
BACKEND_URL="${BACKEND_URL:-http://backend:51947/readyz}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-tg-vault}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
UPDATE_TIMEOUT_SECONDS="${UPDATE_TIMEOUT_SECONDS:-900}"
POLL_INTERVAL="${POLL_INTERVAL:-10}"
LOCK_TTL_SECONDS=1800
DRY_RUN="${DRY_RUN:-0}"

LOCK_DIR="$UPDATE_DIR/lock"
REQUEST_FILE="$UPDATE_DIR/request.json"
STATUS_FILE="$UPDATE_DIR/status.json"
HEARTBEAT_FILE="$UPDATE_DIR/heartbeat.json"

# 当前任务的内存状态（由 write_status 写进 status.json）。
JOB_ID=""
JOB_STARTED_AT=""
JOB_FROM_SHA=""
JOB_TO_SHA=""
JOB_STEP=""
JOB_ERROR=""
RUN_LOG=""
LOCK_HELD=false

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date +%s; }

log() {
    local line="[$(now_iso)] $*"
    printf '%s\n' "$line"
    if [[ -n "$RUN_LOG" ]]; then
        printf '%s\n' "$line" >> "$RUN_LOG"
    fi
}

# 日志尾部：去 ANSI、删含凭证特征的行、只留最后 100 行。
redacted_log_tail() {
    [[ -f "$RUN_LOG" ]] || return 0
    sed -e 's/\x1b\[[0-9;]*m//g' "$RUN_LOG" \
        | grep -viE 'password|passwd|token|secret|authorization|cookie|private[_-]?key' \
        | tail -n 100
}

write_json_atomic() {
    local target="$1" content="$2"
    local tmp
    tmp="$(mktemp "$UPDATE_DIR/.tmp.XXXXXX")"
    printf '%s' "$content" > "$tmp"
    chmod 0600 "$tmp"
    mv "$tmp" "$target"
}

write_heartbeat() {
    mkdir -p "$UPDATE_DIR"
    write_json_atomic "$HEARTBEAT_FILE" "$(jq -nc \
        --arg at "$(now_iso)" --arg version "$UPDATER_VERSION" \
        '{at: $at, version: $version}')"
}

write_status() {
    local state="$1"
    local finished_at=""
    [[ "$state" == "done" || "$state" == "failed" ]] && finished_at="$(now_iso)"
    local log_json
    log_json="$(redacted_log_tail | jq -Rs 'split("\n") | map(select(length > 0))')"
    write_json_atomic "$STATUS_FILE" "$(jq -nc \
        --arg id "$JOB_ID" --arg state "$state" --arg step "$JOB_STEP" \
        --arg startedAt "$JOB_STARTED_AT" --arg finishedAt "$finished_at" \
        --arg fromSha "$JOB_FROM_SHA" --arg toSha "$JOB_TO_SHA" \
        --arg error "$JOB_ERROR" --argjson logTail "$log_json" \
        '{id: $id, state: $state,
          step: (if $step == "" then null else $step end),
          startedAt: (if $startedAt == "" then null else $startedAt end),
          finishedAt: (if $finishedAt == "" then null else $finishedAt end),
          fromSha: (if $fromSha == "" then null else $fromSha end),
          toSha: (if $toSha == "" then null else $toSha end),
          error: (if $error == "" then null else $error end),
          logTail: $logTail}')"
}

fail_job() {
    JOB_ERROR="$1"
    log "更新失败：$1"
    JOB_STEP="failed"
    write_status failed
}

# compose 基础参数。注意：-p 必须显式指定，/project 目录名不是项目名。
compose_args() {
    local -a args=(--project-directory "$PROJECT_DIR" --env-file "$PROJECT_DIR/.env"
                   -p "$PROJECT_NAME" -f "$PROJECT_DIR/docker-compose.yml")
    if [[ "${BUILD_FROM_SOURCE:-false}" == "true" ]]; then
        args+=(-f "$PROJECT_DIR/docker-compose.build.yml")
    fi
    if grep -q '^QBITTORRENT_HOST_INTEGRATION=true' "$PROJECT_DIR/.env" 2>/dev/null; then
        args+=(-f "$PROJECT_DIR/docker-compose.qbittorrent.yml")
    fi
    printf '%s\n' "${args[@]}"
}

compose() {
    local -a args
    mapfile -t args < <(compose_args)
    docker compose "${args[@]}" "$@"
}

check_deadline() {
    local elapsed=$(( $(now_epoch) - JOB_START_EPOCH ))
    if (( elapsed > UPDATE_TIMEOUT_SECONDS )); then
        return 1
    fi
    return 0
}

step() {
    JOB_STEP="$1"
    shift
    log "步骤 [$JOB_STEP]：$*"
    write_status running
    if ! check_deadline; then
        fail_job "更新超时（超过 ${UPDATE_TIMEOUT_SECONDS} 秒）"
        return 1
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        log "DRY_RUN：跳过执行：$*"
        return 0
    fi
    "$@"
}

image_revision() {
    local image="$1"
    docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null || true
}

# 校验前后端镜像属于同一源码修订。拉取后、停旧应用前执行。
verify_image_pair() {
    local backend_image frontend_image backend_rev frontend_rev
    backend_image="$(compose config --format json | jq -r '.services.backend.image')"
    frontend_image="$(compose config --format json | jq -r '.services.frontend.image')"
    log "后端镜像：$backend_image"
    log "前端镜像：$frontend_image"
    backend_rev="$(image_revision "$backend_image")"
    frontend_rev="$(image_revision "$frontend_image")"
    log "后端镜像修订：${backend_rev:-（缺失）}"
    log "前端镜像修订：${frontend_rev:-（缺失）}"
    if [[ ! "$backend_rev" =~ ^[0-9a-f]{40}$ || ! "$frontend_rev" =~ ^[0-9a-f]{40}$ ]]; then
        log "镜像缺少有效源码修订标签，拒绝替换线上服务。"
        return 1
    fi
    if [[ "$backend_rev" != "$frontend_rev" ]]; then
        log "前后端镜像修订不一致，拒绝替换线上服务。"
        return 1
    fi
    return 0
}

wait_ready() {
    local deadline=$(( $(now_epoch) + 300 )) body
    log "等待后端 /readyz（最长 300 秒）：$BACKEND_URL"
    while (( $(now_epoch) < deadline )); do
        if curl -fsS --max-time 5 "$BACKEND_URL" >/dev/null 2>&1; then
            log "后端 /readyz 已返回 200。"
            return 0
        fi
        sleep 5
    done
    log "后端 /readyz 在 300 秒内未就绪。"
    return 1
}

check_containers_running() {
    local name state health
    for name in tg-vault-backend tg-vault-frontend; do
        state="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
        health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo unknown)"
        log "容器 $name：running=$state health=$health"
        [[ "$state" == "true" ]] || return 1
        [[ "$health" == "healthy" || "$health" == "none" ]] || return 1
    done
    return 0
}

# 执行一次更新。调用前 JOB_ID / BUILD_FROM_SOURCE 已设定。
run_update() {
    JOB_START_EPOCH="$(now_epoch)"
    RUN_LOG="$(mktemp "$UPDATE_DIR/.runlog.XXXXXX")"
    chmod 0600 "$RUN_LOG"
    log "开始更新任务 $JOB_ID（buildFromSource=${BUILD_FROM_SOURCE:-false}，DRY_RUN=$DRY_RUN）"
    write_status running

    if [[ "$DRY_RUN" == "1" ]]; then
        for planned in precheck git-update pull-or-build verify-image-pair postgres-up stop-app db-plan db-migrate app-up wait-ready; do
            JOB_STEP="$planned"
            log "DRY_RUN 计划步骤：$planned"
            write_status running
        done
        JOB_STEP="dry-run"
        log "DRY_RUN 完成：未执行任何 git/docker 命令。"
        write_status done
        rm -f "$RUN_LOG"
        return 0
    fi

    log "docker：$(docker --version 2>&1)"
    log "compose：$(docker compose version 2>&1)"

    # 预检：与 install.sh update_source 语义一致，任一不满足即失败，不动容器。
    step precheck test -d "$PROJECT_DIR/.git" || { fail_job "项目目录不是 git 仓库"; return 1; }
    step precheck test -f "$PROJECT_DIR/.env" || { fail_job "项目目录缺少 .env"; return 1; }
    local branch
    branch="$(git -C "$PROJECT_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    if [[ -z "$branch" ]]; then
        fail_job "当前处于 detached HEAD，无法自动更新分支"
        return 1
    fi
    log "当前分支：$branch"
    if ! git -C "$PROJECT_DIR" diff --quiet || [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
        fail_job "项目目录有本地修改，为避免覆盖文件已停止更新"
        return 1
    fi
    if ! git -C "$PROJECT_DIR" remote get-url origin >/dev/null 2>&1; then
        fail_job "git 远端 origin 不存在"
        return 1
    fi

    # 更新前基线：SHA 与镜像 ID/修订（写进日志，供手动回滚参考）。
    JOB_FROM_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || true)"
    log "更新前 SHA：${JOB_FROM_SHA:-unknown}"
    local backend_image frontend_image compose_config
    compose_config="$(compose config --format json 2>/dev/null || true)"
    if [[ -z "$compose_config" ]]; then
        fail_job "读取 Compose 配置失败，请检查项目目录与 .env"
        return 1
    fi
    backend_image="$(printf '%s' "$compose_config" | jq -r '.services.backend.image')"
    frontend_image="$(printf '%s' "$compose_config" | jq -r '.services.frontend.image')"
    log "更新前镜像：backend=$backend_image $(docker image inspect --format '{{.Id}}' "$backend_image" 2>/dev/null || echo 未安装)"
    log "更新前镜像：frontend=$frontend_image $(docker image inspect --format '{{.Id}}' "$frontend_image" 2>/dev/null || echo 未安装)"

    step git-update env GIT_TERMINAL_PROMPT=0 git -C "$PROJECT_DIR" fetch origin \
        || { fail_job "git fetch origin 失败"; return 1; }
    step git-update git -C "$PROJECT_DIR" merge --ff-only "origin/$branch" \
        || { fail_job "git 快进失败（远端分支分叉或网络问题），未开始部署"; return 1; }
    JOB_TO_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || true)"
    log "更新后 SHA：${JOB_TO_SHA:-unknown}"

    if [[ "${BUILD_FROM_SOURCE:-false}" == "true" ]]; then
        step pull-or-build compose build backend frontend \
            || { fail_job "源码构建失败"; return 1; }
    else
        step pull-or-build compose pull backend frontend \
            || { fail_job "拉取 GHCR 镜像失败"; return 1; }
    fi

    step verify-image-pair verify_image_pair \
        || { fail_job "前后端镜像修订校验失败，未替换线上服务"; return 1; }

    step postgres-up compose up -d --no-build --no-deps --no-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" postgres \
        || { fail_job "PostgreSQL 启动失败"; return 1; }
    step stop-app compose stop backend frontend \
        || { fail_job "停止旧应用失败"; return 1; }
    step db-plan compose run --rm --no-deps --pull never backend node dist/scripts/database.js plan \
        || { fail_job "数据库迁移计划失败，应用保持停止"; return 1; }
    step db-migrate compose run --rm --no-deps --pull never backend node dist/scripts/database.js migrate \
        || { fail_job "数据库迁移失败，应用保持停止，请前向修复"; return 1; }
    step app-up compose up -d --no-build --pull never --no-deps --wait --wait-timeout "$HEALTH_TIMEOUT" backend frontend \
        || { fail_job "替换前后端失败"; return 1; }
    step wait-ready wait_ready \
        || { fail_job "更新后后端未在 300 秒内就绪"; return 1; }
    step verify-running check_containers_running \
        || { fail_job "更新后容器未处于运行/健康状态"; return 1; }

    JOB_STEP="done"
    log "更新完成：${JOB_FROM_SHA:0:7} -> ${JOB_TO_SHA:0:7}"
    write_status done
    rm -f "$RUN_LOG"
    return 0
}

lock_is_stale() {
    local owner_mtime
    [[ -d "$LOCK_DIR" ]] || return 1
    owner_mtime="$(stat -c %Y "$LOCK_DIR/owner" 2>/dev/null || echo 0)"
    (( $(now_epoch) - owner_mtime > LOCK_TTL_SECONDS ))
}

release_lock() {
    if [[ "$LOCK_HELD" == "true" ]]; then
        rm -rf "$LOCK_DIR"
        LOCK_HELD=false
    fi
}

# 认领一个请求并执行。返回 0 表示处理过一个请求。
process_request() {
    local request_id build_from_source
    request_id="$(jq -r '.id // empty' "$REQUEST_FILE" 2>/dev/null || true)"
    build_from_source="$(jq -r '.buildFromSource // false' "$REQUEST_FILE" 2>/dev/null || true)"
    if [[ -z "$request_id" ]]; then
        log "请求文件格式无效，已删除：$REQUEST_FILE"
        rm -f "$REQUEST_FILE"
        return 0
    fi
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        return 0
    fi
    LOCK_HELD=true
    printf '%s %s\n' "$$" "$(now_iso)" > "$LOCK_DIR/owner"
    chmod 0600 "$LOCK_DIR/owner"
    # 认领后立即删除请求文件；任务状态以 status.json 为准。
    rm -f "$REQUEST_FILE"
    JOB_ID="$request_id"
    JOB_STARTED_AT="$(now_iso)"
    JOB_FROM_SHA=""
    JOB_TO_SHA=""
    JOB_STEP="queued"
    JOB_ERROR=""
    BUILD_FROM_SOURCE="$build_from_source"
    write_status queued
    # run_update 内部失败已写 failed 状态；此处不因 set -e 退出主循环。
    run_update || true
    release_lock
    return 0
}

main() {
    mkdir -p "$UPDATE_DIR"
    chmod 0700 "$UPDATE_DIR" 2>/dev/null || true
    trap 'release_lock; exit 0' TERM INT
    log "updater 启动（版本 $UPDATER_VERSION，项目 $PROJECT_DIR，轮询 ${POLL_INTERVAL}s）"
    while true; do
        write_heartbeat
        if lock_is_stale; then
            log "检测到过期锁（超 30 分钟），清理并标记任务失败。"
            local stale_job
            stale_job="$(jq -r '.state // empty' "$STATUS_FILE" 2>/dev/null || true)"
            rm -rf "$LOCK_DIR"
            if [[ "$stale_job" == "running" || "$stale_job" == "queued" ]]; then
                JOB_ID="$(jq -r '.id // empty' "$STATUS_FILE" 2>/dev/null || true)"
                JOB_STARTED_AT="$(jq -r '.startedAt // empty' "$STATUS_FILE" 2>/dev/null || true)"
                JOB_FROM_SHA="$(jq -r '.fromSha // empty' "$STATUS_FILE" 2>/dev/null || true)"
                JOB_TO_SHA="$(jq -r '.toSha // empty' "$STATUS_FILE" 2>/dev/null || true)"
                fail_job "更新代理锁过期，任务未完成（可能为代理重启或中断）"
            fi
        fi
        if [[ -f "$REQUEST_FILE" ]] && [[ ! -d "$LOCK_DIR" ]]; then
            process_request
        fi
        sleep "$POLL_INTERVAL"
    done
}

main "$@"
