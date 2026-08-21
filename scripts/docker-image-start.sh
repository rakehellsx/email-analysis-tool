#!/usr/bin/env bash
# Load an offline image bundle, start Compose services, and optionally enable boot startup.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "${SCRIPT_PATH}")"
SOURCE_DIR="${SCRIPT_DIR}"
DEPLOY_DIR="/opt/email-analysis-docker"
if [[ -f "${SCRIPT_DIR}/.email-analysis-deployment" ]]; then
  DEPLOY_DIR="${SCRIPT_DIR}"
fi
ACTION="install"
INSTALL_SERVICE=true
SKIP_IMAGE_LOAD=false
DRY_RUN=false

usage() {
  cat <<'USAGE'
用法：start-image.sh [选项]

默认行为：校验并导入离线镜像，部署到 /opt/email-analysis-docker，启动服务，
并注册 email-analysis-docker.service 为 systemd 开机自启服务。

选项：
  --install-dir <目录>  部署目录；默认：/opt/email-analysis-docker。
  --install             执行默认安装流程；该行为也是不带参数时的默认值。
  --skip-image-load     不执行 docker load，适用于镜像已经导入目标主机的情况。
  --no-enable           启动服务但不注册 systemd 开机自启。
  --start               使用已有部署目录启动服务，不导入镜像。
  --stop                停止服务；不会删除命名数据卷。
  --status              显示 systemd 与 Compose 状态。
  --dry-run             仅验证离线包内容和 Compose 配置，不修改系统。
  -h, --help            显示帮助。
USAGE
}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ "$(id -u)" = "0" ]] || die "该操作需要 root 权限，请使用 sudo 执行"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      [[ $# -ge 2 ]] || die "--install-dir 需要目录参数"
      DEPLOY_DIR="$2"
      shift
      ;;
    --install) ACTION="install" ;;
    --skip-image-load) SKIP_IMAGE_LOAD=true ;;
    --no-enable) INSTALL_SERVICE=false ;;
    --start)
      ACTION="start"
      SKIP_IMAGE_LOAD=true
      ;;
    --stop) ACTION="stop" ;;
    --status) ACTION="status" ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
docker compose version >/dev/null 2>&1 || die "未找到 Docker Compose V2（docker compose）"

compose_in_dir() {
  docker compose --project-directory "${DEPLOY_DIR}" --file "${DEPLOY_DIR}/docker-compose.yml" "$@"
}

case "${ACTION}" in
  status)
    systemctl status email-analysis-docker.service --no-pager || true
    [[ -f "${DEPLOY_DIR}/docker-compose.yml" ]] && compose_in_dir ps || true
    exit 0
    ;;
  stop)
    require_root
    [[ -f "${DEPLOY_DIR}/docker-compose.yml" ]] || die "未找到部署配置：${DEPLOY_DIR}/docker-compose.yml"
    compose_in_dir down --remove-orphans
    printf '服务已停止；命名数据卷未删除。\n'
    exit 0
    ;;
esac

compose_source="${SOURCE_DIR}/docker-compose.yml"
template_source="${SOURCE_DIR}/docker.env.template"
image_archive="${SOURCE_DIR}/images/email-analysis-images.tar.gz"
checksum_file="${SOURCE_DIR}/images/SHA256SUMS"

if [[ "${ACTION}" == "install" ]]; then
  [[ -f "${compose_source}" ]] || die "未找到离线包中的 docker-compose.yml"
  [[ -f "${template_source}" ]] || die "未找到离线包中的 docker.env.template"
  if [[ "${SKIP_IMAGE_LOAD}" == false ]]; then
    [[ -f "${image_archive}" ]] || die "未找到镜像归档：${image_archive}"
    [[ -f "${checksum_file}" ]] || die "未找到镜像校验文件：${checksum_file}"
  fi
fi

if [[ "${DRY_RUN}" == true ]]; then
  if [[ "${ACTION}" == "install" && "${SKIP_IMAGE_LOAD}" == false ]]; then
    gzip -t "${image_archive}"
    (cd "$(dirname "${checksum_file}")" && sha256sum --check "$(basename "${checksum_file}")")
  fi
  if [[ -f "${compose_source}" ]]; then
    docker compose --project-directory "${SOURCE_DIR}" --file "${compose_source}" config >/dev/null
  elif [[ -f "${DEPLOY_DIR}/docker-compose.yml" ]]; then
    compose_in_dir config >/dev/null
  fi
  printf '离线镜像包与 Compose 配置验证通过；不会修改系统。\n'
  exit 0
fi

require_root
docker info >/dev/null 2>&1 || die "Docker daemon 不可用；请先启动 Docker 服务"

if [[ "${ACTION}" == "install" ]]; then
  if [[ "${SKIP_IMAGE_LOAD}" == false ]]; then
    gzip -t "${image_archive}"
    (cd "$(dirname "${checksum_file}")" && sha256sum --check "$(basename "${checksum_file}")")
    docker load --input "${image_archive}"
  fi

  install -d -m 0750 "${DEPLOY_DIR}"
  install -m 0644 "${compose_source}" "${DEPLOY_DIR}/docker-compose.yml"
  install -m 0644 "${template_source}" "${DEPLOY_DIR}/docker.env.template"
  install -m 0755 "${SCRIPT_PATH}" "${DEPLOY_DIR}/start-image.sh"
  install -m 0644 /dev/null "${DEPLOY_DIR}/.email-analysis-deployment"
  if [[ ! -f "${DEPLOY_DIR}/.env" ]]; then
    install -m 0640 "${template_source}" "${DEPLOY_DIR}/.env"
    printf '已创建 %s/.env；请在生产使用前设置 MAIL_ANALYZER_CORS_ORIGINS。\n' "${DEPLOY_DIR}"
  fi
fi

[[ -f "${DEPLOY_DIR}/docker-compose.yml" ]] || die "未找到部署配置：${DEPLOY_DIR}/docker-compose.yml"
compose_in_dir config >/dev/null
compose_in_dir up --detach --remove-orphans

if [[ "${INSTALL_SERVICE}" == true ]]; then
  cat > /etc/systemd/system/email-analysis-docker.service <<UNIT
[Unit]
Description=Email Analysis Docker Compose Stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${DEPLOY_DIR}
ExecStart=/usr/bin/docker compose --project-directory ${DEPLOY_DIR} --file ${DEPLOY_DIR}/docker-compose.yml up --detach --remove-orphans
ExecStop=/usr/bin/docker compose --project-directory ${DEPLOY_DIR} --file ${DEPLOY_DIR}/docker-compose.yml down --remove-orphans
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now email-analysis-docker.service
  printf '已启用开机自启：email-analysis-docker.service\n'
fi

compose_in_dir ps
