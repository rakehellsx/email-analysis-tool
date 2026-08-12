#!/usr/bin/env bash
# Deploy FastAPI email analysis service + local-only Rspamd + Nginx.
# Run as root from this repository root on Ubuntu 24.04/22.04.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/email-analysis-python}"
DATA_DIR="${DATA_DIR:-/var/lib/email-analysis-python}"
APP_USER="${APP_USER:-mailanalysis}"
APP_GROUP="${APP_GROUP:-mailanalysis}"
HTTP_PORT="${HTTP_PORT:-8081}"
UVICORN_PORT="${UVICORN_PORT:-3200}"
RSPAMD_PORT="${RSPAMD_PORT:-11333}"
DOMAIN="${DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
RSPAMD_TIMEOUT_SECONDS="${RSPAMD_TIMEOUT_SECONDS:-10}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SOURCE_DIR="${REPO_ROOT}/api-service"

log() { printf '\n[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
on_error() { printf 'ERROR: deployment stopped at line %s\n' "$1" >&2; }
trap 'on_error "$LINENO"' ERR

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "请以 root 或 sudo bash 运行此脚本"
}

require_ubuntu() {
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "脚本仅支持 Ubuntu；当前系统为 ${ID:-unknown}"
  [[ -d "${SOURCE_DIR}" ]] || die "未找到 ${SOURCE_DIR}。请从仓库根目录运行脚本"
  [[ -z "${DOMAIN}" || -n "${ACME_EMAIL}" ]] || die "设置 DOMAIN 时必须同时设置 ACME_EMAIL，以避免明文 HTTP 生产部署"
}

install_packages() {
  log "安装 Rspamd、Nginx 和 Python 运行时依赖"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y \
    nginx rspamd rsync curl ca-certificates \
    python3-fastapi python3-uvicorn python3-multipart python3-dotenv \
    python3-yaml python3-sklearn python3-joblib python3-requests
}

install_application() {
  log "安装邮件分析应用到 ${APP_DIR}"
  getent group "${APP_GROUP}" >/dev/null || groupadd --system "${APP_GROUP}"
  id "${APP_USER}" >/dev/null 2>&1 || useradd --system --gid "${APP_GROUP}" --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
  install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0750 "${APP_DIR}" "${DATA_DIR}/jobs" "${DATA_DIR}/models"
  rsync -a --delete \
    --exclude '.env' --exclude 'data' --exclude 'models/*.joblib' --exclude '__pycache__' \
    "${SOURCE_DIR}/" "${APP_DIR}/"
  chown -R root:"${APP_GROUP}" "${APP_DIR}"
  chmod -R g+rX "${APP_DIR}"
  chown -R "${APP_USER}:${APP_GROUP}" "${DATA_DIR}"
  chmod -R 0750 "${DATA_DIR}"
}

configure_rspamd() {
  log "配置 Rspamd：仅允许应用通过 127.0.0.1:${RSPAMD_PORT} 调用 /checkv2"
  install -d -m 0755 /etc/rspamd/local.d
  cat >/etc/rspamd/local.d/worker-normal.inc <<EOF
# Managed by deploy-rspamd-stack.sh
bind_socket = "127.0.0.1:${RSPAMD_PORT}";
count = 1;
EOF
  systemctl enable rspamd
  systemctl restart rspamd
}

configure_systemd() {
  log "创建受限的 email-analysis-python systemd 服务"
  cat >/etc/systemd/system/email-analysis-python.service <<EOF
[Unit]
Description=Email Analysis API with local Rspamd
After=network-online.target rspamd.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
Environment=RSPAMD_URL=http://127.0.0.1:${RSPAMD_PORT}
Environment=RSPAMD_TIMEOUT_SECONDS=${RSPAMD_TIMEOUT_SECONDS}
Environment=MAIL_ANALYZER_DATABASE=${DATA_DIR}/mail_analyzer.db
Environment=MAIL_ANALYZER_JOB_DIR=${DATA_DIR}/jobs
Environment=MAIL_ANALYZER_MODEL=${DATA_DIR}/models/baseline_model.joblib
Environment=MAIL_ANALYZER_CORS_ORIGINS=https://${DOMAIN:-localhost}
ExecStart=/usr/bin/python3 -m uvicorn app.main:app --host 127.0.0.1 --port ${UVICORN_PORT} --workers 1
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now email-analysis-python
}

configure_nginx() {
  log "配置 Nginx 反向代理"
  local listen_port="${HTTP_PORT}"
  local server_name="_"
  if [[ -n "${DOMAIN}" ]]; then
    listen_port="80"
    server_name="${DOMAIN}"
  fi
  cat >/etc/nginx/sites-available/email-analysis-python <<EOF
server {
    listen ${listen_port};
    server_name ${server_name};
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:${UVICORN_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 90s;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/email-analysis-python /etc/nginx/sites-enabled/email-analysis-python
  nginx -t
  systemctl enable nginx
  systemctl reload nginx
}

optional_tls() {
  [[ -n "${DOMAIN}" ]] || return 0
  log "为 ${DOMAIN} 申请 Let's Encrypt 证书"
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx --non-interactive --agree-tos --redirect --email "${ACME_EMAIL}" -d "${DOMAIN}"
}

verify() {
  log "执行健康检查与 Rspamd /checkv2 验收"
  systemctl --quiet is-active rspamd || die "Rspamd 未运行"
  systemctl --quiet is-active email-analysis-python || die "邮件分析服务未运行"
  systemctl --quiet is-active nginx || die "Nginx 未运行"
  curl --fail --silent --show-error "http://127.0.0.1:${UVICORN_PORT}/healthz" | grep -q '"status":"ok"'
  curl --fail --silent --show-error \
    -H 'Content-Type: message/rfc822' \
    --data-binary "@${APP_DIR}/samples/phishing_with_attachment.eml" \
    "http://127.0.0.1:${RSPAMD_PORT}/checkv2" | grep -q '"action"'
  ss -ltn | grep -q "127.0.0.1:${RSPAMD_PORT}" || die "Rspamd 未绑定到指定回环端口"
  log "部署成功"
  if [[ -n "${DOMAIN}" ]]; then
    printf '控制台地址：https://%s/\n' "${DOMAIN}"
  else
    printf '临时控制台地址：http://<服务器地址>:%s/\n' "${HTTP_PORT}"
    printf '提示：此地址为明文 HTTP，仅适用于受控内网验证；生产使用请设置 DOMAIN 与 ACME_EMAIL。\n'
  fi
}

require_root
require_ubuntu
install_packages
install_application
configure_rspamd
configure_systemd
configure_nginx
optional_tls
verify
