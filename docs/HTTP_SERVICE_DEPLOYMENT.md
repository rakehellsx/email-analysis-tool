# HTTP 服务接口部署

本文部署 `api-service/` 中的 FastAPI 服务，并在同一台 Ubuntu 24.04 服务器上运行 Rspamd 与 Nginx。建议以域名和 HTTPS 对外提供控制台及 API；Rspamd 本身不应直接暴露到公网。

## 架构与端口

浏览器只访问 Nginx。Nginx 将请求转发给监听在回环地址的 Uvicorn；Uvicorn 再通过 `RSPAMD_URL` 调用同样只监听回环地址的 Rspamd。这样原始邮件不会被浏览器直接发送给 Rspamd，扫描端口也不会暴露到公网。

| 组件 | 推荐监听地址 | 端口 | 作用 |
|---|---:|---:|---|
| Nginx | `0.0.0.0` / `::` | `443` | HTTPS、上传大小限制和反向代理 |
| Uvicorn | `127.0.0.1` | `3200` | 邮件上传、任务查询、模型训练和同源控制台 |
| Rspamd normal worker | `127.0.0.1` | `11333` | `/checkv2` 邮件扫描 |

## 1. 安装系统依赖

在 Ubuntu 24.04 服务器上安装运行时、反向代理和 Rspamd。以下命令仅安装服务依赖，不包含项目代码或任何凭据。

```bash
sudo apt-get update
sudo apt-get install -y \
  nginx rspamd python3-fastapi python3-uvicorn python3-multipart \
  python3-dotenv python3-yaml python3-sklearn python3-joblib
```

将本仓库中的 `api-service/` 放置在 `/opt/email-analysis-python`。运行数据应与代码分离，避免在更新代码时覆盖邮件任务、训练记录和模型工件。

```bash
sudo install -d -m 0750 /opt/email-analysis-python
sudo install -d -m 0750 /var/lib/email-analysis-python/jobs
sudo install -d -m 0750 /var/lib/email-analysis-python/models
sudo rsync -a --delete api-service/ /opt/email-analysis-python/
```

## 2. 配置 Rspamd

创建 `/etc/rspamd/local.d/worker-normal.inc`，将扫描端口绑定到回环地址。不要将该端口绑定到公网地址。

```nginx
bind_socket = "127.0.0.1:11333";
count = 1;
```

随后重启并验证服务：

```bash
sudo systemctl enable --now rspamd
sudo systemctl restart rspamd
curl --fail --max-time 20 \
  -H 'Content-Type: message/rfc822' \
  --data-binary @api-service/samples/phishing_with_attachment.eml \
  http://127.0.0.1:11333/checkv2
```

成功时返回 JSON，其中包含 `score`、`required_score`、`action` 和 `symbols`。示例邮件无害，仅用于规则与引擎流程验证。

## 3. 配置邮件分析服务

创建 `/etc/systemd/system/email-analysis-python.service`。下面的配置将所有可变数据置于 `/var/lib/email-analysis-python`，并把 Rspamd URL 注入服务端环境；该值不会发送到浏览器。

```ini
[Unit]
Description=Email Analysis API with Rspamd
After=network-online.target rspamd.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/email-analysis-python
Environment=RSPAMD_URL=http://127.0.0.1:11333
Environment=RSPAMD_TIMEOUT_SECONDS=10
Environment=MAIL_ANALYZER_DATABASE=/var/lib/email-analysis-python/mail_analyzer.db
Environment=MAIL_ANALYZER_JOB_DIR=/var/lib/email-analysis-python/jobs
Environment=MAIL_ANALYZER_MODEL=/var/lib/email-analysis-python/models/baseline_model.joblib
Environment=MAIL_ANALYZER_CORS_ORIGINS=https://mail.example.com
ExecStart=/usr/bin/python3 -m uvicorn app.main:app --host 127.0.0.1 --port 3200 --workers 1
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/email-analysis-python

[Install]
WantedBy=multi-user.target
```

启用服务并确认健康检查：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now email-analysis-python
curl --fail http://127.0.0.1:3200/healthz
sudo journalctl -u email-analysis-python -f
```

## 4. 配置 HTTPS 反向代理

准备好指向服务器公网 IP 的域名后，使用证书工具签发证书，并创建 `/etc/nginx/sites-available/email-analysis-python`。以下配置使用 `mail.example.com` 作为占位域名，必须替换为实际域名和证书路径。

```nginx
server {
    listen 80;
    server_name mail.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name mail.example.com;

    ssl_certificate     /etc/letsencrypt/live/mail.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mail.example.com/privkey.pem;
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
}
```

启用配置后执行：

```bash
sudo ln -sf /etc/nginx/sites-available/email-analysis-python /etc/nginx/sites-enabled/email-analysis-python
sudo nginx -t && sudo systemctl reload nginx
curl --fail https://mail.example.com/healthz
```

在正式 TLS 域名生效前，可使用仅用于内网验证的临时端口，例如 Nginx `listen 8081;`。不要通过明文 HTTP 上传敏感邮件。

## 5. HTTP 接口和验收

| 操作 | 方法与路径 | 请求内容 | 成功响应 |
|---|---|---|---|
| 健康检查 | `GET /healthz` | 无 | `{"status":"ok"}` |
| 提交 EML | `POST /api/v1/emails` | `multipart/form-data` 字段 `file` | `202`、`task_id`、`status_url` |
| 查询结果 | `GET /api/v1/tasks/{task_id}` | 无 | 任务状态和完成后的完整结果 |
| 训练模型 | `POST /api/v1/models/train` | `multipart/form-data` 字段 `dataset` | `202`、训练 `task_id` |
| 查询训练 | `GET /api/v1/models/train/{task_id}` | 无 | 训练状态、样本数和模型摘要 |

```bash
curl -F 'file=@samples/phishing_with_attachment.eml;type=message/rfc822' \
  https://mail.example.com/api/v1/emails

curl https://mail.example.com/api/v1/tasks/<task_id>
```

完成任务后，检查结果内 `analysis.external_engines` 中的 `rspamd` 条目。正常启用时应包含 `status: completed`、`score` 和 `action`；若引擎不可达，服务会保留规则与模型结论，并在该条目中说明失败原因。

## 6. 运行和安全运维

服务默认将原始邮件、任务数据库和模型工件写入运行数据目录。应配置备份与保留周期，并限制仅授权运维人员读取该目录。上传服务建议额外接入身份认证、反向代理速率限制和恶意文件隔离策略。务必保持 `11333` 与 `3200` 只对本机或专用内网开放；仅 `443` 应对公众开放。
