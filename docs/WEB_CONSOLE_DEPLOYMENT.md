# Web 界面部署

仓库提供两种 Web 界面实现。二者服务于相同的邮件分析目标，但接口契约不同，应根据部署位置选择其一，而不要混合调用。

| 方案 | 源码位置 | 后端契约 | 推荐用途 |
|---|---|---|---|
| 同源轻量控制台 | `api-service/static/index.html` | FastAPI REST：`/api/v1/*` | 单服务器部署；与自建 Rspamd 配合；无 Node.js 构建依赖 |
| 全栈控制台 | `web-console/` | Express + tRPC：`/api/trpc/*` | 独立托管、数据库任务持久化、React 前端迭代 |

## A. 部署同源轻量控制台

该控制台已随 FastAPI 服务打包。访问 Python 服务根路径 `/` 即可加载页面；EML 上传、结果轮询和 JSONL 训练请求均发送到相同域名下的 REST API，因此不需要在浏览器中填写 API 地址，也无需跨域配置。

完成 [HTTP 服务部署](./HTTP_SERVICE_DEPLOYMENT.md)后，访问：

```text
https://mail.example.com/
```

页面会先调用 `/healthz` 检查服务，再允许选择 `.eml` 或 `.jsonl`/`.ndjson` 文件。分析完成后可直接查看性质、评分、建议动作、规则命中以及 Rspamd 评分和动作。此方案是自建服务器的推荐选择。

## B. 部署全栈 React 控制台

`web-console/` 是 React、Express、tRPC 和 Drizzle/MySQL 项目。它在托管环境中以同源 tRPC 调用提供邮件分析、模型训练、任务查询和数据库持久化。启动前需要准备 Node.js 22+、pnpm 10+、MySQL/TiDB 数据库，以及项目运行所需的 OAuth/数据库环境变量。

```bash
cd web-console
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm drizzle-kit generate
# 审阅生成 SQL 后，在目标数据库执行迁移
pnpm build
NODE_ENV=production node dist/index.js
```

全栈控制台使用 `server/routers.ts` 作为接口入口。生产环境中的 Rspamd 地址必须保留在服务器环境变量，例如 `RSPAMD_URL=https://rspamd.internal.example`；不要将该地址写进 `client/`、Vite 变量或浏览器配置。若 Rspamd 位于同一台主机，应优先使用 `http://127.0.0.1:11333` 并仅由服务端访问。

## C. 发布前检查

发布前应确认以下事项。第一，前端不包含 `127.0.0.1`、生产 API 密钥、SSH 密码或 GitHub 令牌。第二，生产域名通过 HTTPS 提供服务。第三，任务、模型和原始 EML 使用受控存储并有访问策略。第四，Rspamd 运行状态会在分析结果中显示；引擎不可用时应给出明确提示而不是只显示泛化的“无法完成邮件分析”。

```bash
pnpm check
pnpm test
```

> 若目标服务器无法访问 npm 软件源，请在具有依赖缓存的构建机执行 `pnpm install --frozen-lockfile && pnpm build`，再将经过校验的生产产物与生产依赖部署到服务器。不要在服务器上绕过锁文件安装未审计的依赖版本。
