# 邮件安全分析工具

本仓库交付一套可部署的邮件安全分析工具。系统接收 RFC 822/EML 邮件，异步解析邮件头、正文、链接和附件，组合 **YAML 规则**、**本地机器学习模型**与可选 **Rspamd `/checkv2`** 结果，返回可审阅的风险结论。项目包含两种界面实现：与 Python 服务同源部署的轻量控制台，以及可独立演进的全栈 Web 控制台。

| 目录 | 内容 | 适用场景 |
|---|---|---|
| [`api-service/`](./api-service/) | FastAPI 邮件分析 API、规则、模型训练、同源静态控制台与测试 | 自建服务器、单机部署、与本地 Rspamd 组合使用 |
| [`web-console/`](./web-console/) | React + Express + tRPC 全栈控制台源码 | 托管 Web 控制台、任务持久化、独立前端迭代 |
| [`docs/HTTP_SERVICE_DEPLOYMENT.md`](./docs/HTTP_SERVICE_DEPLOYMENT.md) | FastAPI、Rspamd、Nginx 与 systemd 部署指南 | HTTP 服务接口部署 |
| [`docs/WEB_CONSOLE_DEPLOYMENT.md`](./docs/WEB_CONSOLE_DEPLOYMENT.md) | 两种 Web 界面部署与运行指南 | Web 界面部署 |
| [`docs/RSPAMD_DEPLOYMENT.md`](./docs/RSPAMD_DEPLOYMENT.md) | Rspamd 详细部署、验收、故障排查和安全运维 | 自建 Rspamd 服务 |
| [`docs/DOCKER_DEPLOYMENT.md`](./docs/DOCKER_DEPLOYMENT.md) | Docker 镜像、Compose、数据卷与容器运维指南 | Docker 化部署 |
| [`scripts/deploy-rspamd-stack.sh`](./scripts/deploy-rspamd-stack.sh) | 一键部署 Python API、Rspamd、Nginx 和 systemd | Ubuntu 22.04/24.04 |
| [`scripts/docker-deploy.sh`](./scripts/docker-deploy.sh) | 构建、启动、健康检查和停止 Docker Compose 服务 | Docker Engine + Compose V2 |

## 核心能力

系统通过 `POST /api/v1/emails` 接收 `.eml` 文件，立即返回任务标识；随后可通过 `GET /api/v1/tasks/{task_id}` 获取解析与检测结果。模型训练使用 `POST /api/v1/models/train` 接收脱敏 JSONL/NDJSON 数据集，并通过训练任务查询接口取得摘要。邮件分析服务不会执行附件，也不会访问邮件正文中的 URL。

| 检测层 | 输出示例 |
|---|---|
| MIME 解析 | 发件人、收件人、抄送、主题、正文、附件元数据、URL |
| 规则引擎 | 命中规则、证据、权重与风险评分 |
| 机器学习 | 本地 TF-IDF + Logistic Regression 的垃圾邮件概率 |
| Rspamd | 评分、阈值、动作、符号与 URL 摘要 |

## 快速开始

对于自建服务器，优先阅读 [HTTP 服务部署文档](./docs/HTTP_SERVICE_DEPLOYMENT.md)。该方案将 Python API、同源控制台和 Rspamd 置于同一受控服务器，避免浏览器将请求错误地发送到 `127.0.0.1`。如需独立托管的 React 控制台，请阅读 [Web 界面部署文档](./docs/WEB_CONSOLE_DEPLOYMENT.md)。

如需以容器镜像方式交付 API 与 Rspamd，请阅读 [Docker 镜像部署文档](./docs/DOCKER_DEPLOYMENT.md)。在具备 Docker Engine 和 Compose V2 的主机上，可先复制 `docker.env.template` 为 `.env`，随后执行 `scripts/docker-deploy.sh --dry-run` 检查配置，再运行 `scripts/docker-deploy.sh` 构建镜像、启动服务并验证健康检查。

> **安全提示：** 不要将 `.env`、GitHub 令牌、训练语料、原始邮件、SQLite 数据库或导出的模型提交到仓库。生产环境应使用 HTTPS，并将 Rspamd 的扫描端口限制在回环地址或专用内网。
