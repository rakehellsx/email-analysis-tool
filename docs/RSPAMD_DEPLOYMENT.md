# Rspamd 详细部署与一键安装

本文面向 Ubuntu 22.04/24.04 自建服务器。仓库中的 [`scripts/deploy-rspamd-stack.sh`](../scripts/deploy-rspamd-stack.sh) 会在同一主机部署 Python 邮件分析服务、Nginx 和 Rspamd，并默认把 Rspamd 绑定到 `127.0.0.1:11333`。该默认值避免把扫描端口直接暴露给公网。

> Rspamd 的 HTTP 扫描端点为 `POST /checkv2`；请求体可直接是原始邮件，返回 JSON 包含 `score`、`required_score`、`action` 和 `symbols`。[1] Rspamd 官方默认将代理 worker 用于 Milter 场景；不需要 Milter 时，直接使用 normal worker 更高效。[2]

## 1. 部署前准备

服务器应具备 Ubuntu 22.04 或 24.04、root/sudo 权限、可访问 Ubuntu 软件源的网络，以及至少一个受控的公网入口。生产环境还应准备一个已解析到服务器公网 IP 的域名，以便启用 HTTPS。

| 项目 | 默认值 | 可通过脚本变量修改 | 说明 |
|---|---:|---|---|
| Rspamd 扫描端口 | `127.0.0.1:11333` | `RSPAMD_PORT` | 仅被本机应用调用，不对公网开放 |
| FastAPI/Uvicorn | `127.0.0.1:3200` | `UVICORN_PORT` | 邮件 API 和同源静态控制台 |
| 临时 Nginx 入口 | `0.0.0.0:8081` | `HTTP_PORT` | 仅用于受控内网或临时验收 |
| 生产 Nginx 入口 | `443` | `DOMAIN` + `ACME_EMAIL` | 使用 Let's Encrypt 自动重定向 HTTPS |
| 运行数据 | `/var/lib/email-analysis-python` | `DATA_DIR` | SQLite 任务记录、原始邮件、训练模型 |

脚本不会自动启用 UFW。这样可以避免在未知 SSH 端口的服务器上误锁远程登录。请在云安全组、网络防火墙或既有 UFW 策略中只放行 HTTPS `443/tcp`；申请证书时还需短暂允许 `80/tcp`。不要开放 `11333/tcp` 或 `3200/tcp`。

## 2. 一键部署

在服务器克隆仓库后，于仓库根目录执行。首次使用建议先完成域名 DNS 解析；该脚本会安装所需系统包，复制 `api-service`、建立低权限服务账户、设置 systemd、写入 Rspamd 回环绑定、配置 Nginx，并执行健康检查和样例邮件扫描。

```bash
git clone https://github.com/rakehellsx/email-analysis-tool.git
cd email-analysis-tool
sudo DOMAIN=mail.example.com \
  ACME_EMAIL=ops@example.com \
  bash scripts/deploy-rspamd-stack.sh
```

正式执行前可使用无副作用的 dry-run 验证脚本输入、端口冲突、应用源码、样例邮件和安全边界。该命令不会安装软件、创建用户、写入 `/etc`、变更防火墙或重启服务。

```bash
sudo DOMAIN=mail.example.com \
  ACME_EMAIL=ops@example.com \
  bash scripts/deploy-rspamd-stack.sh --dry-run
```

如果尚未准备域名，只可进行受控网络中的临时验证：

```bash
sudo HTTP_PORT=8081 bash scripts/deploy-rspamd-stack.sh
```

临时模式仅提供 HTTP。因为原始邮件常含个人信息、组织地址和附件元数据，切勿把该模式作为公网生产入口。

## 3. 脚本执行过程

脚本的执行过程是幂等的：再次执行会更新应用目录和配置，重启 Rspamd 与邮件分析服务，并重新加载 Nginx。它不删除 `/var/lib/email-analysis-python` 中的任务、训练数据或模型工件。

| 阶段 | 主要操作 | 安全控制 |
|---|---|---|
| 依赖安装 | 安装 `rspamd`、`nginx`、FastAPI、Uvicorn、scikit-learn 等系统包 | 不写入应用凭据 |
| 应用安装 | 将 `api-service/` 同步至 `/opt/email-analysis-python` | 运行数据与代码分离 |
| Rspamd | 写入 `worker-normal.inc`，绑定 `127.0.0.1:11333` | 扫描接口不暴露到公网 |
| systemd | 以 `mailanalysis` 系统账户运行 Uvicorn | `NoNewPrivileges`、只读系统目录、仅数据目录可写 |
| Nginx | 限制上传大小为 20 MB，反代到回环 Uvicorn | 对外只有反向代理入口 |
| 验收 | 调用 `/healthz` 和 `/checkv2` | 确认 Rspamd 返回有效动作 |

## 4. 人工安装步骤

如需手动操作，请按 [HTTP 服务部署文档](./HTTP_SERVICE_DEPLOYMENT.md) 依次完成系统依赖安装、Rspamd 回环配置、systemd 服务和 Nginx 配置。关键 Rspamd 文件为 `/etc/rspamd/local.d/worker-normal.inc`：

```nginx
bind_socket = "127.0.0.1:11333";
count = 1;
```

应用对引擎的服务端配置使用：

```ini
Environment=RSPAMD_URL=http://127.0.0.1:11333
Environment=RSPAMD_TIMEOUT_SECONDS=10
```

请求使用 `/checkv2`，并提交原始 EML 作为 HTTP 请求体；Rspamd 结果中的 `action` 可为 `no action`、`greylist`、`add header`、`soft reject` 或 `reject`。[1]

## 5. 验收与故障排查

部署成功后执行以下命令。第一条检查进程；第二条验证本机扫描；第三条查看应用聚合结果。请使用仓库随附的无害样例，不要将未经授权的邮件样本上传至不受控环境。

```bash
sudo systemctl status rspamd email-analysis-python nginx

curl -H 'Content-Type: message/rfc822' \
  --data-binary @/opt/email-analysis-python/samples/phishing_with_attachment.eml \
  http://127.0.0.1:11333/checkv2

curl -F 'file=@/opt/email-analysis-python/samples/phishing_with_attachment.eml;type=message/rfc822' \
  https://mail.example.com/api/v1/emails
```

若 Rspamd 无法调用，先检查监听地址和服务日志：

```bash
sudo ss -ltnp | grep 11333
sudo journalctl -u rspamd -n 100 --no-pager
sudo journalctl -u email-analysis-python -n 100 --no-pager
```

`11333` 应仅显示 `127.0.0.1:11333`，而不是 `0.0.0.0:11333`。如果外部浏览器不能访问 Nginx，但服务器本机 `curl` 正常，请检查云安全组、上游防火墙和 DNS，而不是将 Rspamd 端口暴露到公网。

## 6. 运维建议

定期更新系统和 Rspamd 规则，审阅 `/var/lib/email-analysis-python` 的数据保留周期，并为该目录配置加密备份和最小权限访问。建议把 Nginx 访问日志和 systemd 日志接入监控，关注分析失败率、Rspamd 超时、`reject` 动作比例和磁盘占用。若后续需要高可用或独立扫描集群，可使用 Rspamd proxy worker 将请求转发给多个扫描节点。[2]

## 参考资料

[1] [Rspamd Protocol：HTTP `/checkv2`、请求头与响应字段](https://docs.rspamd.com/developers/protocol/)

[2] [Rspamd Proxy Worker：proxy、normal worker 与扫描层说明](https://docs.rspamd.com/workers/rspamd_proxy/)
