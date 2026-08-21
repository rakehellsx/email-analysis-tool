#!/usr/bin/env bash
# Build, start and verify the Docker Compose delivery of the mail analysis API.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.yml"
ACTION="up"

usage() {
  cat <<'USAGE'
用法：scripts/docker-deploy.sh [--build-only | --down | --dry-run]

默认行为：构建邮件分析镜像，后台启动 Docker Compose 服务，并验证 /healthz。
  --build-only  仅构建 Python 服务镜像并拉取 Rspamd 镜像。
  --down        停止并移除容器和网络；保留命名数据卷。
  --dry-run     渲染并验证 Compose 配置，不启动或修改容器。
  -h, --help    显示此帮助。

可在仓库根目录的 .env 中设置 EMAIL_ANALYSIS_PORT、RSPAMD_IMAGE 等变量。
USAGE
}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) ACTION="build" ;;
    --down) ACTION="down" ;;
    --dry-run) ACTION="dry-run" ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
  shift
done

[[ -f "${COMPOSE_FILE}" ]] || die "未找到 ${COMPOSE_FILE}"
command -v docker >/dev/null 2>&1 || die "未找到 docker 命令，请先安装 Docker Engine 和 Compose V2"
docker compose version >/dev/null 2>&1 || die "未找到 Docker Compose V2（docker compose）"

compose=(docker compose --project-directory "${ROOT_DIR}" --file "${COMPOSE_FILE}")

if [[ "${ACTION}" == "dry-run" ]]; then
  "${compose[@]}" config >/dev/null
  printf 'Docker Compose 配置有效：%s\n' "${COMPOSE_FILE}"
  exit 0
fi

docker info >/dev/null 2>&1 || die "Docker daemon 不可用；请启动 Docker 或使用具备 docker 访问权限的账户"

case "${ACTION}" in
  build)
    "${compose[@]}" pull rspamd
    "${compose[@]}" build --pull email-analysis
    printf '镜像构建完成。\n'
    ;;
  down)
    "${compose[@]}" down --remove-orphans
    printf '容器与网络已停止并移除；命名数据卷仍被保留。\n'
    ;;
  up)
    "${compose[@]}" pull rspamd
    "${compose[@]}" up --detach --build --remove-orphans

    health_port="${EMAIL_ANALYSIS_PORT:-3200}"
    health_url="${EMAIL_ANALYSIS_HEALTHCHECK_URL:-http://127.0.0.1:${health_port}/healthz}"
    for _ in $(seq 1 30); do
      if curl --fail --silent --show-error --max-time 3 "${health_url}" >/dev/null; then
        printf '服务健康检查成功：%s\n' "${health_url}"
        "${compose[@]}" ps
        exit 0
      fi
      sleep 2
    done

    "${compose[@]}" ps >&2 || true
    "${compose[@]}" logs --tail=100 >&2 || true
    die "服务未能在 60 秒内通过健康检查：${health_url}"
    ;;
esac
