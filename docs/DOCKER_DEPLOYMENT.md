# Docker 镜像部署

本方案以两个容器交付邮件分析服务：`email-analysis` 运行 FastAPI、同源静态控制台、规则引擎和本地模型；`rspamd` 提供内部的 `/checkv2` 扫描服务。Compose 仅映射 Python API 的主机端口，Rspamd 端口不发布到主机或公网。官方 Rspamd 镜像以非特权 UID/GID `11333:11333` 运行，并将学习数据放在 `/var/lib/rspamd`；该目录必须由命名卷持久化。[1]

> **安全边界：** 默认 API 仅绑定 `127.0.0.1:3200`。生产环境应由 HTTPS 反向代理转发该端口；不要将 `11333`、`11334` 或 `11332` 映射到公网。官方 Rspamd 镜像的 controller 带有已知默认密码，因此本项目将 controller 保留在容器自身回环地址，且不发布该端口。[1]

## 1. 文件与镜像结构

| 文件 | 作用 |
|---|---|
| `api-service/Dockerfile` | 多阶段构建 FastAPI 镜像，运行阶段使用非特权 `mailanalyzer` 用户。 |
| `api-service/docker-entrypoint.sh` | 初始化命名卷的目录权限后，降权启动 Uvicorn。 |
| `docker-compose.yml` | 编排 `email-analysis` 和内部 `rspamd` 服务、网络、健康依赖和命名数据卷。 |
| `docker/rspamd/local.d/*.inc` | 仅启用内部 normal worker 的 HTTP 扫描接口；controller 和 proxy 不对 Compose 网络开放。 |
| `scripts/docker-deploy.sh` | 构建、启动、停止及健康检查命令的封装。 |

邮件任务 SQLite 数据库、上传的 EML、训练数据和模型文件都位于 `email_analysis_data` 命名卷；Rspamd 统计与学习数据位于 `email_analysis_rspamd_data` 命名卷。两者不会被写进镜像，也不会随着默认停止命令删除。

## 2. 前置条件

目标主机需要 Docker Engine 和 Docker Compose V2，且执行账户能运行 `docker`。以下示例在仓库根目录执行。

```bash
git clone https://github.com/rakehellsx/email-analysis-tool.git
cd email-analysis-tool
cp docker.env.template .env
chmod 0755 scripts/docker-deploy.sh
```

编辑 `.env` 时至少应将 `MAIL_ANALYZER_CORS_ORIGINS` 改为实际 HTTPS 域名。若 Nginx 与容器部署在同一主机，请保留 `EMAIL_ANALYSIS_BIND_ADDRESS=127.0.0.1`；若在受控的私有网络中由另一台反向代理访问，可谨慎改为专用内网地址。

| 变量 | 默认值 | 含义 |
|---|---:|---|
| `EMAIL_ANALYSIS_IMAGE` | `email-analysis:local` | 构建完成的本地 API 镜像名与标签。 |
| `EMAIL_ANALYSIS_BIND_ADDRESS` | `127.0.0.1` | API 映射到宿主机的地址。 |
| `EMAIL_ANALYSIS_PORT` | `3200` | 宿主机 API 端口。 |
| `MAIL_ANALYZER_CORS_ORIGINS` | `https://mail.example.com` | 允许调用 API 的浏览器来源，多个来源使用逗号分隔。 |
| `RSPAMD_IMAGE` | `rspamd/rspamd:4.0` | 官方稳定系列 Rspamd 镜像；生产环境可锁定经过批准的精确版本。 |
| `RSPAMD_TIMEOUT_SECONDS` | `30` | Python 服务等待 `/checkv2` 的最大秒数；容器初次加载 DNS 规则或外部映射时可避免过早降级为超时。 |
| `RSPAMD_FLAGS` | `pass_all,groups,no_log` | 发送给 `/checkv2` 的扫描标志。默认不包含 `ext_urls`，以避免 Rspamd 主动抓取邮件 URL；仅在已批准相关网络访问后才应添加。 |

Rspamd 官方镜像通过 `/var/lib/rspamd` 保存 Bayes、fuzzy 和缓存等状态；使用命名卷可避免宿主机目录的 UID/GID 写权限问题。[1]

## 3. 构建和启动

先运行不创建容器的配置渲染检查：

```bash
scripts/docker-deploy.sh --dry-run
```

构建 Python 镜像并拉取 Rspamd 镜像：

```bash
scripts/docker-deploy.sh --build-only
```

启动服务后，脚本将轮询 `GET /healthz`，成功时显示 Compose 服务状态：

```bash
scripts/docker-deploy.sh
curl --fail http://127.0.0.1:3200/healthz
```

也可以直接使用 Compose：

```bash
docker compose build email-analysis
docker compose up -d
docker compose ps
```

`email-analysis` 会等待 Rspamd 镜像内置健康检查成功后启动。Rspamd 官方镜像的健康检查使用 controller 的未认证 `/ping` 路径；本项目仍不将该 controller 端口发布给主机。[1]

## 4. API 验收

服务健康后，可上传仓库提供的无害测试邮件，再以返回的 `task_id` 查询结果。Rspamd 的成功结果应当出现在 `analysis.external_engines` 的 `rspamd` 条目中，含 `status: completed`、`score` 与 `action`。

```bash
curl -F 'file=@api-service/samples/phishing_with_attachment.eml;type=message/rfc822' \
  http://127.0.0.1:3200/api/v1/emails

curl http://127.0.0.1:3200/api/v1/tasks/<task_id>
```

容器日志与实时状态可通过以下命令查看：

```bash
docker compose ps
docker compose logs --follow email-analysis rspamd
```

## 5. 反向代理与 HTTPS

Docker Compose 不负责签发证书。若 API 由互联网访问，应将 Nginx 或 Caddy 配置为仅代理 `http://127.0.0.1:3200`，并在代理层设置 TLS、上传大小限制、认证及速率限制。可复用 [HTTP 服务接口部署文档](./HTTP_SERVICE_DEPLOYMENT.md) 的 Nginx 配置，只需确认 `proxy_pass` 指向 Docker 映射的回环地址。

不要在 `docker-compose.yml` 中为 Rspamd 添加 `ports:`。`expose: 11333` 仅使同一 Compose 网络中的 `email-analysis` 服务通过 `http://rspamd:11333` 调用扫描接口，不会创建主机端口映射。

## 6. 更新、备份和下线

升级应用代码后，在仓库根目录重新构建并启动：

```bash
git pull --ff-only
scripts/docker-deploy.sh
```

停止服务但保留邮件任务和模型数据：

```bash
scripts/docker-deploy.sh --down
```

请在维护窗口备份命名卷；原始邮件和训练数据可能包含敏感信息。仅当确认不再需要数据时，才删除对应卷：

```bash
docker volume inspect email_analysis_data email_analysis_rspamd_data
# 确认备份后，再手动删除指定卷。
```

## 7. 离线导出镜像与开机启动

若目标服务器无法访问 Docker Hub 或 npm 等外部软件源，应在一台可联网的构建主机完成镜像构建与导出。导出包包含 Python 服务镜像、官方 Rspamd 镜像、Compose 配置、环境变量模板、启动脚本和镜像 SHA-256 校验文件；**不包含**邮件、SQLite 任务数据库、训练数据、模型工件或 Rspamd 学习数据。

### 7.1 在联网构建主机导出

```bash
cd email-analysis-tool
chmod 0755 scripts/docker-export-images.sh scripts/docker-image-start.sh
scripts/docker-export-images.sh --output-dir ./dist
sha256sum -c ./dist/email-analysis-offline-*.tar.gz.sha256
```

导出完成后，将生成的 `email-analysis-offline-<UTC 时间>.tar.gz` 及对应 `.sha256` 文件复制到目标服务器。可使用受控的文件传输通道；不要把包含运行数据的 Docker 卷打包到镜像交付文件中。

### 7.2 在离线目标服务器导入并启动

目标服务器需要预先安装并启动 Docker Engine 与 Docker Compose V2。解压镜像包后，先编辑 `.env` 中的浏览器来源和端口设置，再以 root 执行导入与安装：

```bash
mkdir -p /tmp/email-analysis-offline
tar -xzf email-analysis-offline-*.tar.gz -C /tmp/email-analysis-offline
cd /tmp/email-analysis-offline

cp docker.env.template .env
# 编辑 .env：至少将 MAIL_ANALYZER_CORS_ORIGINS 改为实际 HTTPS 域名。
sudo ./start-image.sh --dry-run
sudo ./start-image.sh --install
```

默认安装目录为 `/opt/email-analysis-docker`。启动脚本首先校验 `images/SHA256SUMS` 和 gzip 归档，再执行 `docker load`，最后创建或保留部署目录的 `.env`、启动 Compose 栈并注册 systemd 单元。已有 `.env` 不会被新的离线包自动覆盖，因此可在升级镜像时保留已审核的生产设置。

| 运维目的 | 命令 |
|---|---|
| 查看开机自启状态 | `sudo systemctl is-enabled email-analysis-docker.service` |
| 查看服务与容器状态 | `sudo systemctl status email-analysis-docker.service --no-pager` 和 `sudo /opt/email-analysis-docker/start-image.sh --status` |
| 立即重启容器栈 | `sudo systemctl restart email-analysis-docker.service` |
| 停止容器但保留数据卷 | `sudo /opt/email-analysis-docker/start-image.sh --stop` |
| 取消开机自启并停止服务 | `sudo systemctl disable --now email-analysis-docker.service` |

> **开机启动行为：** `email-analysis-docker.service` 使用 `Requires=docker.service`，并在 Docker 服务就绪后执行 `docker compose up --detach`。Compose 中的 `restart: unless-stopped` 同时负责 Docker daemon 重启后的容器恢复。请不要手工删除 `/opt/email-analysis-docker/.env` 或命名数据卷，除非已经完成敏感邮件与模型数据的备份。

## 参考资料

[1]: https://github.com/rspamd/rspamd-docker "Rspamd 官方 Docker 镜像说明"
