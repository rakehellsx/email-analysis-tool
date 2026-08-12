# 邮件安全分析服务设计

## 服务职责

该服务接收 RFC 822/EML 原始邮件，创建可追踪的异步分析任务，并在后台完成 MIME 解析、附件哈希、独立规则扫描、轻量机器学习判别以及可选 Rspamd 复核。任务和结果持久化于本地 SQLite 数据库，原始 EML 以任务目录内的受限文件保存。设计上不执行附件、不访问邮件内 URL、不渲染外部远程资源；邮件内容只作为待分析数据处理。

## HTTP 接口

| 方法 | 路径 | 输入 | 成功响应 | 用途 |
|---|---|---|---|---|
| `POST` | `/api/v1/emails` | `multipart/form-data`，字段 `file` 为 `.eml` | `202`，返回 `task_id` 和 `status=queued` | 上传并提交异步分析任务 |
| `GET` | `/api/v1/tasks/{task_id}` | 路径参数 `task_id` | `200`，返回任务状态；成功后含完整 `result` | 查询任务进度和分析结果 |
| `GET` | `/healthz` | 无 | `200` | 存活检查 |

上传接口会检查空文件、`.eml` 文件名和最大原始邮件大小。结果接口的状态为 `queued`、`running`、`completed` 或 `failed`；后端异常不会伪装为安全结论。

## 结果模型

分析结果将邮件属性、附件清单、规则证据、模型判断、可选引擎判断与最终风险结论分层返回。邮件属性包括发件人、收件人、抄送、回复地址、主题、日期、Message-ID、纯文本正文、HTML 正文和 URL；附件只暴露元数据及 SHA-256，默认不返回或下载附件原始字节。最终性质包括 `SAFE`、`SUSPICIOUS`、`PHISHING`、`MALICIOUS_ATTACHMENT` 与 `ABNORMAL_SENDER`，同时保留全部命中类别，避免将复杂邮件强行压缩为单一标签。

## 检测编排

规则定义全部保存在 `config/detection_rules.yaml`，可在不改动 Python 源码的前提下调整阈值、正则和评分。规则扫描会生成可审计的命中记录，包括规则 ID、严重性、分数、证据和说明。机器学习层使用本地、可训练的 TF-IDF + Logistic Regression 文本分类器；没有模型文件时会明确报告 `unavailable`，不会产生伪造的模型判断。若设置 `RSPAMD_URL`，则会将原始邮件通过 `POST /checkv2` 送入 Rspamd 并归一化其 `score`、`required_score`、`action` 和 `symbols`，作为独立的成熟开源检测层。[1]

## 风险合成规则

附件危险类型、宏文档、双扩展名或 EICAR 测试签名等高危规则可直接形成 `MALICIOUS_ATTACHMENT`。域名仿冒、凭据诱导、短链、发件人/回复地址不一致、可疑 URL 等组合规则形成 `PHISHING` 或 `ABNORMAL_SENDER`。其余规则和机器学习概率按加权分数合成 `SAFE`、`SUSPICIOUS` 或 `PHISHING`。所有结论属于自动化辅助研判，应由安全人员结合邮件上下文与组织策略复核。

## 参考资料

[1]: https://docs.rspamd.com/developers/protocol/ "Rspamd protocol"
