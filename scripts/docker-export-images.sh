#!/usr/bin/env bash
# Build and export every Compose image as one portable offline delivery bundle.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.yml"
OUTPUT_DIR="${ROOT_DIR}/dist"
BUILD_IMAGES=true
DRY_RUN=false

usage() {
  cat <<'USAGE'
用法：scripts/docker-export-images.sh [选项]

构建邮件分析 Docker 镜像，并导出为一个可复制到离线服务器的压缩包。

选项：
  --output-dir <目录>  导出目录；默认：仓库根目录/dist。
  --skip-build         不构建或拉取镜像，仅导出当前本机已有镜像。
  --dry-run            仅渲染 Compose 配置并展示将导出的镜像，不创建文件。
  -h, --help           显示帮助。

导出包包含：镜像归档、docker-compose.yml、环境变量模板、启动脚本、
镜像清单与 SHA-256 校验文件。运行数据不会包含在导出包中。
USAGE
}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      [[ $# -ge 2 ]] || die "--output-dir 需要目录参数"
      OUTPUT_DIR="$2"
      shift
      ;;
    --skip-build) BUILD_IMAGES=false ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
  shift
done

[[ -f "${COMPOSE_FILE}" ]] || die "未找到 ${COMPOSE_FILE}"
[[ -f "${ROOT_DIR}/scripts/docker-image-start.sh" ]] || die "未找到离线启动脚本"
command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
docker compose version >/dev/null 2>&1 || die "未找到 Docker Compose V2（docker compose）"

compose=(docker compose --project-directory "${ROOT_DIR}" --file "${COMPOSE_FILE}")
mapfile -t images < <("${compose[@]}" config --images | sort -u)
[[ ${#images[@]} -gt 0 ]] || die "Compose 配置中未发现可导出的镜像"

if [[ "${DRY_RUN}" == true ]]; then
  printf '将导出以下镜像：\n'
  printf '  - %s\n' "${images[@]}"
  printf '输出目录：%s\n' "${OUTPUT_DIR}"
  exit 0
fi

docker info >/dev/null 2>&1 || die "Docker daemon 不可用；请启动 Docker 或使用具备 docker 访问权限的账户"

if [[ "${BUILD_IMAGES}" == true ]]; then
  "${compose[@]}" pull rspamd
  "${compose[@]}" build --pull email-analysis
fi

for image in "${images[@]}"; do
  docker image inspect "${image}" >/dev/null 2>&1 || die "本机缺少镜像：${image}"
done

mkdir -p "${OUTPUT_DIR}"
staging_dir="$(mktemp -d "${OUTPUT_DIR}/.email-analysis-export.XXXXXX")"
bundle_name="email-analysis-offline-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
bundle_path="${OUTPUT_DIR}/${bundle_name}"

cleanup() {
  rm -rf "${staging_dir}"
}
trap cleanup EXIT

mkdir -p "${staging_dir}/images"
docker save "${images[@]}" | gzip -n > "${staging_dir}/images/email-analysis-images.tar.gz"
(cd "${staging_dir}/images" && sha256sum email-analysis-images.tar.gz > SHA256SUMS)

install -m 0644 "${ROOT_DIR}/docker-compose.yml" "${staging_dir}/docker-compose.yml"
install -m 0644 "${ROOT_DIR}/docker.env.template" "${staging_dir}/docker.env.template"
install -m 0755 "${ROOT_DIR}/scripts/docker-image-start.sh" "${staging_dir}/start-image.sh"

{
  printf 'bundle_format=email-analysis-offline-v1\n'
  printf 'created_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'source_commit=%s\n' "$(git -C "${ROOT_DIR}" rev-parse --verify HEAD 2>/dev/null || printf 'unknown')"
  printf 'images=\n'
  printf '%s\n' "${images[@]}" | sed 's/^/  - /'
} > "${staging_dir}/image-manifest.txt"

cat > "${staging_dir}/README-OFFLINE.md" <<'README'
# 邮件安全分析离线镜像包

本目录不包含运行数据。将整个压缩包复制到目标服务器后解压，编辑 `.env`，再以 root 运行：

```bash
cp docker.env.template .env
sudo ./start-image.sh --install
```

脚本会校验镜像归档、执行 `docker load`、启动 Compose 服务，并安装
`email-analysis-docker.service` 作为 systemd 开机自启服务。
README

tar -C "${staging_dir}" -czf "${bundle_path}" .
sha256sum "${bundle_path}" > "${bundle_path}.sha256"

printf '离线镜像包已生成：%s\n' "${bundle_path}"
printf '校验文件：%s.sha256\n' "${bundle_path}"
printf '镜像归档大小：%s\n' "$(du -h "${staging_dir}/images/email-analysis-images.tar.gz" | awk '{print $1}')"
