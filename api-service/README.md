# 邮件安全分析服务

这是一个以 Python/FastAPI 实现的 EML 邮件分析服务。服务提供异步 HTTP 接口：客户端上传 `.eml` 后立即获得任务标识，再通过该标识查询邮件元数据、正文、附件摘要、规则证据、机器学习结论、可选 Rspamd 结论以及最终风险性质。服务只读取和分析邮件内容；不会执行附件、运行脚本、访问邮件内 URL 或加载 HTML 中的远程资源。

> 自动检测结果用于安全辅助研判，而不是替代安全运营人员的处置决定。上线前应接入身份认证、访问控制、日志审计、数据保留策略和组织自己的已标注邮件样本。

## 已实现能力

| 能力 | 实现方式 | 结果表现 |
|---|---|---|
| EML/MIME 解析 | Python 标准库 `email` | 提取发件人、收件人、抄送、回复地址、主题、日期、正文、HTML、URL、附件元数据与 SHA-256 |
| 异步任务 API | FastAPI `BackgroundTasks` + SQLite | 上传接口返回 `202` 和 `task_id`，查询接口返回 `queued`、`running`、`completed` 或 `failed` |
| 独立规则检测 | `config/detection_rules.yaml` | 返回规则 ID、严重性、评分、说明和截断后的证据 |
| 附件风险检测 | 扩展名、双扩展名、宏文档、压缩包、EICAR 签名 | 可判定 `MALICIOUS_ATTACHMENT` 或附加相应风险标签 |
| 本地机器学习检测 | TF-IDF + Logistic Regression | 返回 `ham/spam`、垃圾邮件概率及置信度；不向第三方传输邮件文本 |
| 成熟开源引擎适配 | 可选 Rspamd `/checkv2` HTTP 适配器 | 归一化返回 `score`、`required_score`、`action` 和规则符号 |

## 快速启动

请在 Python 3.11 或以上环境中安装依赖、训练演示基线模型并启动服务。演示模型仅用于验证接口与集成路径；生产环境应以经脱敏、标注、评估的内部样本重新训练。

```bash
cd email-analysis-tool
sudo pip3 install -r requirements.txt
python3 scripts/train_model.py --output models/baseline_model.joblib
cp .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

启动后，可访问 `http://127.0.0.1:8000/docs` 浏览自动生成的 OpenAPI 文档。服务使用 SQLite 存储任务状态，原始 EML 存放在 `data/jobs/<task_id>/message.eml`，且默认以仅当前用户可读写的文件权限写入。

## API 调用

### 1. 提交邮件

```bash
curl -X POST http://127.0.0.1:8000/api/v1/emails \
  -F "file=@samples/phishing_with_attachment.eml;type=message/rfc822"
```

接口返回 `202 Accepted`。其中 `task_id` 是唯一任务标识；`status_url` 可直接用于轮询。

```json
{
  "task_id": "b1bdb085-b2d2-4df3-ad1f-7d1f8a76a697",
  "status": "queued",
  "status_url": "/api/v1/tasks/b1bdb085-b2d2-4df3-ad1f-7d1f8a76a697"
}
```

### 2. 查询分析结果

```bash
curl http://127.0.0.1:8000/api/v1/tasks/<task_id>
```

完成后，响应中的 `result.email` 提供邮件详细信息；`result.analysis.rules` 提供独立规则命中；`result.analysis.machine_learning` 提供本地模型判断；`result.analysis.external_engines` 提供 Rspamd 结果；`result.analysis.verdict` 提供归一化的总体结论。总体性质可能为 `SAFE`、`SUSPICIOUS`、`PHISHING`、`MALICIOUS_ATTACHMENT` 或 `ABNORMAL_SENDER`。

## 规则维护

所有规则均位于 `config/detection_rules.yaml`，而非硬编码在 Python 源码中。规则可针对附件扩展名、附件文件名、有限大小附件的可读文本、正文、HTML、URL 主机名、URL 原文以及发件人上下文匹配。

| 字段 | 说明 | 示例 |
|---|---|---|
| `id` | 稳定、唯一的规则标识 | `PHISHING_IP_URL` |
| `category` | 供性质归类与评分聚合使用 | `phishing`、`malicious_attachment` |
| `severity` | 规则严重性 | `medium`、`high`、`critical` |
| `score` | 单次规则命中的风险分 | `4.0` |
| `target` | 可匹配的数据位置 | `urls.hosts`、`attachment.filename` |
| `operator` | `equals`、`contains`、`in` 或 `regex` | `regex` |
| `value` / `values` / `pattern` | 与操作符对应的匹配条件 | IPv4 主机名正则 |

修改规则后重启服务即可生效。部署前应将规则纳入代码审查和回归测试；对于白名单、品牌域名、地理策略或行业特定情报，建议通过新的规则项或受控外部情报服务扩展，而不是直接修改解析逻辑。

## 机器学习模型

`LocalMlEngine` 加载 `models/baseline_model.joblib` 并以主题、正文、URL 主机名和附件名构造特征。`scripts/train_model.py` 支持从 JSON Lines 文件重训，每行包含 `label`（仅 `ham` 或 `spam`）和经脱敏的 `text`。例如：

```bash
python3 scripts/train_model.py \
  --data /secure/datasets/mail_labels.jsonl \
  --output models/organization_mail_model.joblib
MAIL_ANALYZER_MODEL=models/organization_mail_model.joblib \
  uvicorn app.main:app --host 127.0.0.1 --port 8000
```

模型工件由 `joblib` 加载，因此**只能使用本组织离线训练并受信任的模型文件**。如模型文件不存在或加载失败，接口会将机器学习层标记为 `unavailable` 或 `error`，不会将其错误地报告为安全邮件。

## Rspamd 集成

[Rspamd](https://github.com/rspamd/rspamd) 是 Apache-2.0 许可的邮件处理与垃圾邮件过滤框架，支持规则、统计分析、URL 情报和 Lua 扩展。[1] 本项目不复制或改写 Rspamd，而是提供一个可选的 HTTP 适配器。配置 `RSPAMD_URL` 后，服务会将原始 RFC 822 内容以 `POST /checkv2` 提交；该协议返回邮件评分、阈值、建议动作和命中符号。[2]

```bash
# .env
RSPAMD_URL=http://127.0.0.1:11333
RSPAMD_TIMEOUT_SECONDS=10
```

如果 Rspamd 未部署或未配置，`external_engines` 中会显示 `status: disabled`，本地规则与模型分析仍会完成。生产场景应将 Rspamd 部署在受控内部网络，以 TLS、网络策略及资源配额保护扫描接口；不要把未认证的扫描端点暴露到公网。

## 验证

项目包含一封安全的规则验证样例邮件，其中含有双扩展名附件和钓鱼特征；样例并不包含可执行恶意程序。执行以下命令可验证 EML 解析、规则引擎、机器学习推理、任务提交和结果查询链路：

```bash
cd email-analysis-tool
pytest -q
```

## 目录结构

```text
app/                         FastAPI 服务、解析、规则、模型与 Rspamd 适配代码
config/detection_rules.yaml  独立维护的检测规则
scripts/train_model.py       本地模型训练脚本
models/                      受信任的模型工件存储位置
samples/                     无害的 EML 验证样例
tests/                       自动化测试
docs/design.md               接口、数据和判定设计说明
```

## 参考资料

[1]: https://github.com/rspamd/rspamd "Rspamd GitHub 项目"
[2]: https://docs.rspamd.com/developers/protocol/ "Rspamd HTTP protocol"

## Web 控制台与模型训练 API

配套 Web 控制台位于 `../mail-analysis-console`。先启动本服务，再在控制台的“分析服务地址”中填写本服务可访问的根地址；本地开发默认使用 `http://127.0.0.1:8000`。服务已经提供 `GET /healthz`、`POST /api/v1/emails`、`GET /api/v1/tasks/{task_id}` 以及以下模型训练接口：

| 方法 | 路径 | 输入 | 成功响应 |
|---|---|---|---|
| `POST` | `/api/v1/models/train` | `multipart/form-data`，字段 `dataset` 为 `.jsonl` 或 `.ndjson` | `202`，返回训练 `task_id` |
| `GET` | `/api/v1/models/train/{task_id}` | 路径参数 `task_id` | 训练状态及完成后的样本计数、类别分布和模型摘要 |

训练文件必须采用 UTF-8 JSON Lines 格式；每个非空行都必须同时含有 `label` 和 `text`，其中 `label` 仅可为 `ham` 或 `spam`。例如：

```json
{"label":"ham","text":"已脱敏的正常业务邮件文本"}
{"label":"spam","text":"已脱敏的钓鱼或垃圾邮件文本"}
```

训练 API 默认限制训练文件为 10 MB，要求至少 10 条有效样本、每个类别至少 2 条样本，并以原子替换方式更新本地模型工件。请仅提交经过授权和脱敏的训练语料；训练完成后仍应以独立评估集验证模型，再将结果用于生产处置。
