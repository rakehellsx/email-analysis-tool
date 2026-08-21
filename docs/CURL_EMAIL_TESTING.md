# 使用 curl 测试邮件安全分析 API

本文说明如何通过 `curl` 上传 EML 邮件、获取异步任务标识并查询分析结果。示例适用于 Docker Compose 默认部署：API 映射到部署服务器本机的 `127.0.0.1:3200`，Rspamd 只在 Docker 内部网络中被 API 调用。

## 1. 前置检查

确认 Docker 服务已启动且邮件分析容器正常运行：

```bash
sudo systemctl status email-analysis-docker.service --no-pager
sudo docker compose \
  --project-directory /opt/email-analysis-docker \
  --file /opt/email-analysis-docker/docker-compose.yml ps
```

服务健康检查应返回 `{"status":"ok"}`：

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:3200/healthz
```

> 默认配置将 API 绑定到 `127.0.0.1:3200`，因此以下命令应在部署服务器本机执行。若配置了 Nginx 或 Caddy 的 HTTPS 反向代理，请将 API 地址替换为实际 HTTPS 域名。

## 2. 上传 EML 邮件

将 `/path/to/test.eml` 替换为待检测的 RFC 822 / EML 文件路径：

```bash
curl --fail --silent --show-error \
  -F 'file=@/path/to/test.eml;type=message/rfc822' \
  http://127.0.0.1:3200/api/v1/emails
```

成功时，服务会返回异步分析任务标识：

```json
{
  "task_id": "2bb6c002-2ec8-48e8-b864-cb3ae1f1d3e4",
  "status": "queued",
  "message": "邮件已接收，正在后台分析。请使用 task_id 查询结果。",
  "status_url": "/api/v1/tasks/2bb6c002-2ec8-48e8-b864-cb3ae1f1d3e4"
}
```

保存响应中的 `task_id`，后续查询将使用该值。

## 3. 查询任务结果

将 `<TASK_ID>` 替换为上传接口返回的任务标识：

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:3200/api/v1/tasks/<TASK_ID>
```

任务状态可能为 `queued`、`running`、`completed` 或 `failed`。当状态为 `completed` 时，响应中的 `result` 字段包含：

| 字段路径 | 含义 |
|---|---|
| `result.email` | 发件人、收件人、抄送、主题、正文、URL 与附件元数据。 |
| `result.analysis.rules` | YAML 检测规则命中情况和评分。 |
| `result.analysis.machine_learning` | 本地 TF-IDF / Logistic Regression 模型的结果；未训练时会返回不可用原因。 |
| `result.analysis.external_engines` | Rspamd `/checkv2` 的评分、动作和符号结果。 |
| `result.analysis.verdict` | 邮件性质、风险级别、风险评分与建议处置动作。 |

## 4. 自动轮询直至完成

下列命令每两秒查询一次，直到任务状态为 `completed` 或 `failed`。该版本不依赖 `jq`：

```bash
TASK_ID='<TASK_ID>'

while true; do
  RESULT="$(curl --fail --silent --show-error \
    "http://127.0.0.1:3200/api/v1/tasks/${TASK_ID}")"
  printf '%s\n' "${RESULT}"

  case "${RESULT}" in
    *'"status":"completed"'*|*'"status":"failed"'*)
      break
      ;;
  esac

  sleep 2
done
```

如果服务器已安装 `jq`，可将响应格式化为易读 JSON：

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:3200/api/v1/tasks/<TASK_ID> | jq .
```

## 5. HTTPS 反向代理场景

如果 Nginx 已将 HTTPS 域名转发到本机 API，将下例中的域名替换为实际地址：

```bash
curl --fail --silent --show-error \
  -F 'file=@/path/to/test.eml;type=message/rfc822' \
  https://mail.example.com/api/v1/emails
```

对公网暴露时，应仅公开 HTTPS 反向代理入口。**不要**对外映射或暴露 Rspamd 的 `11333`、`11334`、`11332` 端口，也不要直接将 Uvicorn 端口暴露到公网。

## 6. 常见问题

| 现象 | 检查与处理方式 |
|---|---|
| `Connection refused` | 检查 `email-analysis-docker.service`、Docker daemon 和 Compose 容器状态；再请求 `/healthz`。 |
| HTTP `422` 或上传失败 | 确认表单字段名为 `file`，且文件为 EML/RFC 822 格式。 |
| 任务长期处于 `queued` 或 `running` | 查看 API 日志：`sudo docker compose --project-directory /opt/email-analysis-docker --file /opt/email-analysis-docker/docker-compose.yml logs --tail=100 email-analysis`。 |
| Rspamd 状态为 `timeout` 或 `unavailable` | 查看 Rspamd 日志：`sudo docker compose --project-directory /opt/email-analysis-docker --file /opt/email-analysis-docker/docker-compose.yml logs --tail=100 rspamd`。规则引擎和本地模型仍会继续给出可用结果。 |
| 浏览器跨域报错 | 检查 `/opt/email-analysis-docker/.env` 中 `MAIL_ANALYZER_CORS_ORIGINS` 是否包含实际 HTTPS 前端域名，然后执行 `sudo systemctl restart email-analysis-docker.service`。 |

## 7. 安全提醒

待检测邮件和附件可能包含恶意内容。请不要打开未知附件、不要访问邮件中的可疑 URL，并在受控环境中保存上传样本。分析结论用于安全辅助研判，关键处置仍应结合组织策略、邮件链路和人工复核完成。
