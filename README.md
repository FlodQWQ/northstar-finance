# Northstar Finance

Northstar Finance 是一个自托管的个人资产与事件跟踪面板。当前版本包含直接资产、预期资产、价格及状态历史、事件计划和执行记录。系统默认可以在没有 AI、行情源或 SMTP 的情况下运行；这些能力通过服务端 provider 边界逐步接入。

## 本地开发（Windows）

要求 Node.js 22 或更高版本，推荐 Node.js 24 LTS。首次运行：

```powershell
Copy-Item .env.example .env
npm ci
npm run dev
```

浏览器访问 <http://127.0.0.1:5888>。`npm run dev` 会同时启动：

- Vite 页面：`127.0.0.1:5888`
- Express API：`127.0.0.1:5889`
- Vite 将 `/api` 请求代理到 Express，浏览器始终使用同一来源

常用校验命令：

```powershell
npm run typecheck
npm test
npm run build
```

本地生产模式先执行构建，再运行统一的跨平台启动脚本：

```powershell
npm run build
npm run start
```

运行前需在 `.env` 中设置 `APP_AUTH_USERNAME` 和强随机 `APP_AUTH_PASSWORD`。生产模式下由单个 Express 进程在 `PORT=5888` 同源提供 API 与 `dist/` 静态文件。

## 环境变量

从 `.env.example` 开始配置；`.env` 包含密钥，不应提交到 Git。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 时由 Express 服务 `dist/` |
| `PORT` | `5888` | 生产 HTTP 端口；Docker 内固定为 `5888` |
| `API_PORT` | `5889` | 仅开发模式的 API 端口 |
| `HOST` | `127.0.0.1` | 本地监听地址；容器内使用 `0.0.0.0` |
| `HOST_PORT` | `5888` | 仅 Compose 使用的宿主机映射端口，不改变容器内端口 |
| `TZ` | `Asia/Shanghai` | 调度与日志展示时区；持久化时间仍应使用 UTC |
| `DATABASE_PATH` | `./data/finance.sqlite` | SQLite 文件路径；容器内为 `/app/data/finance.sqlite` |
| `SEED_DEMO_DATA` | 开发为 `true`，生产为 `false` | 是否在空数据库中写入演示资产与事件 |
| `APP_BASE_URL` | `http://127.0.0.1:5888` | 邮件链接与未来 OAuth 回调使用的公开地址 |
| `APP_AUTH_USERNAME` | 空 | 生产页面与普通业务 API 的单用户 HTTP Basic 用户名；生产环境必填 |
| `APP_AUTH_PASSWORD` | 空 | 强随机密码；生产环境必填且只能通过 HTTPS 使用 |
| `SCHEDULER_ENABLED` | `true` | 是否启动持久化事件调度器 |
| `SCHEDULER_POLL_MS` | `30000` | 扫描到期事件的间隔，单位毫秒 |
| `SCHEDULER_LEASE_MS` | `600000` | 单次调度任务的数据库租约时长，单位毫秒 |
| `SMTP_HOST` | 空 | SMTP 主机；为空时邮件 provider 保持禁用 |
| `SMTP_PORT` | `587` | SMTP 端口，通常为 `587` 或 `465` |
| `SMTP_SECURE` | `false` | 端口 `465` 通常设为 `true`；`587` 使用 STARTTLS |
| `SMTP_USER` / `SMTP_PASS` | 空 | SMTP 凭据，生产环境建议使用应用专用密码 |
| `SMTP_FROM` | 空 | 发件人地址 |
| `NOTIFICATION_EMAIL` | 空 | 默认收件人地址 |
| `AI_PROVIDER` | `none` | 当前仅支持 `none`/`disabled` 和离线 `mock`；其他值尚未接入真实 provider |
| `AI_API_TOKEN` | 空 | AI 原子写接口的 Bearer token；生产环境必须配置 |
| `OPENAI_API_KEY` | 空 | 为未来 OpenAI provider 预留；当前不会发起 OpenAI API 请求 |
| `OPENAI_BASE_URL` | OpenAI API | 为未来 OpenAI 兼容 provider 预留的服务地址 |
| `OPENAI_MODEL` | 空 | 为未来 OpenAI provider 预留的模型标识 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 空 | 服务端行情、新闻和 AI 出站代理 |
| `NO_PROXY` | `localhost,127.0.0.1` | 不经过代理的地址列表 |
| `CONTAINER_HTTP_PROXY` / `CONTAINER_HTTPS_PROXY` | 空 | 仅 Compose 使用，映射为容器内标准代理变量 |
| `FINANCE_ENV_FILE` | `.env` | 仅 Compose 使用，指定传入容器的环境文件 |

所有金额、价格和数量应作为十进制定点值处理，不应经过 JavaScript 浮点数计算。SQLite 数据目录和备份包含个人财务信息，应限制访问权限并加密异地备份。

总览只汇总与“本位币”相同的资产，其他币种会标记为“未折算”，不会在缺少汇率时被直接相加。行情 provider 后续接入汇率能力后，再扩展统一折算。

## 访问认证

本地开发服务只监听回环地址，不要求登录。生产模式下，页面、静态资源和普通业务 API 统一使用 HTTP Basic 单用户认证；`/api/health` 仅公开最小健康状态。未配置 `APP_AUTH_USERNAME` 或 `APP_AUTH_PASSWORD` 时，业务请求和 readiness 检查都会失败关闭。

AI 路由不接受页面 Basic 凭据，独立使用 `AI_API_TOKEN` Bearer token；反过来，AI token 也不能访问普通资产、设置或 SMTP 测试接口。部署时必须启用 HTTPS，并为应用密码和 AI token 使用不同的强随机值。

## AI 原子命令 API

`GET /api/ai/capabilities` 返回白名单命令、确认要求、版本键格式和完整 JSON Schema。读取能力和写入 `POST /api/ai/commands/execute` 在生产环境都必须携带：

```http
Authorization: Bearer <AI_API_TOKEN>
Content-Type: application/json
```

请求示例：

```json
{
  "idempotencyKey": "agent-run-2026-08-09-001",
  "actor": "portfolio-agent",
  "expectedVersions": { "asset:demo-btc": 1 },
  "commands": [
    {
      "commandId": "quote-1",
      "type": "asset.price.update",
      "payload": {
        "assetId": "demo-btc",
        "price": "70000",
        "currency": "USD",
        "source": "agent-research"
      }
    }
  ]
}
```

接口具有以下边界：

- `idempotencyKey` 全局唯一并绑定规范化后的完整请求；同键同请求会重放结果，同键不同请求返回冲突。
- 所有更新命令必须在 `expectedVersions` 提供带类型前缀的版本，例如 `asset:<id>`；缺失或冲突时整批回滚。
- 所有金额和数量必须是十进制字符串。
- 流水、非零期初持仓、预期资产阶段变更，以及可启动联网任务或邮件的事件变更必须设置 `confirmed: true`。
- 只要批内有一条高风险命令未确认，整批都会变成 `proposal`，任何业务数据都不会写入。
- proposal 和 `dryRun: true` 会在回滚事务内执行完整领域校验，包括批内多条命令的累计影响，但不会保留业务写入。
- 每个批次及命令都有审计记录；接口不接受 SQL、任意网络请求、密钥修改或 shell 命令。

`confirmed` 是调用方声明的防误操作开关，不等同于独立的人类审批或签名。当前 MVP 尚无 proposal 审批工作流；接入自动化 AI 时，应让编排层在明确的用户授权后才设置该字段，不能让模型自行决定。

## Docker

镜像使用固定 Node 24 Debian slim 基础版本和多阶段构建。运行层只保留生产依赖，以非 root 用户启动单个 Node 进程；SQLite 数据保存在命名卷 `finance-data`。生产环境默认不写入演示资产，只有显式设置 `CONTAINER_SEED_DEMO_DATA=true` 才会启用演示数据。

### 本地构建与运行

```powershell
Copy-Item .env.example .env
# 修改 .env；至少设置 APP_AUTH_USERNAME、APP_AUTH_PASSWORD 和 APP_BASE_URL
docker compose up -d --build
docker compose ps
docker compose logs -f finance-dashboard
```

默认端口映射是 `127.0.0.1:5888:5888`，不会直接暴露到公网。本机可访问 <http://127.0.0.1:5888>。Compose 从被 Git 忽略的 `.env` 文件向容器传递应用配置；可通过 `FINANCE_ENV_FILE` 指向另一个环境文件。`.env`、`docker compose config` 输出和 `docker inspect` 输出都可能包含密钥，不应提交或公开分享。

### 发布到 Docker Hub

先在 Docker Hub 创建 `northstar-finance` 仓库，然后在 PowerShell 中构建并推送当前机器架构的镜像：

```powershell
$DockerHubUser = "your-dockerhub-username"
$Version = "0.1.0"
docker login --username $DockerHubUser
docker build --pull --target runtime -t "${DockerHubUser}/northstar-finance:${Version}" -t "${DockerHubUser}/northstar-finance:latest" .
docker push "${DockerHubUser}/northstar-finance:${Version}"
docker push "${DockerHubUser}/northstar-finance:latest"
```

仓库中的 `.github/workflows/docker-publish.yml` 可自动发布 `linux/amd64` 和 `linux/arm64`。在 GitHub 仓库的 Actions secrets 中配置 `DOCKERHUB_USERNAME` 和只具备该仓库读写权限的 `DOCKERHUB_TOKEN`：推送 `main` 会生成 `latest`、`main` 和 `sha-*` 标签，推送 `v0.1.0` 之类的 Git tag 会生成语义化版本标签。

```powershell
git tag v0.1.0
git push origin main --tags
```

部署时优先使用不可变版本标签，不要只依赖 `latest`。

### VPS 部署

VPS 安装 Docker Engine 和 Compose 插件后，将 `compose.vps.yml` 与环境文件放在同一目录：

```bash
cp .env.vps.example .env
chmod 600 .env
# 编辑 .env：填写 DOCKER_IMAGE、固定 IMAGE_TAG、公开 URL、认证和可选 SMTP/AI 配置
docker compose --env-file .env -f compose.vps.yml pull
docker compose --env-file .env -f compose.vps.yml up -d
docker compose --env-file .env -f compose.vps.yml ps
docker compose --env-file .env -f compose.vps.yml logs --tail=100 finance-dashboard
```

VPS Compose 只从 Docker Hub 拉取镜像，不在服务器上构建。端口仍绑定 `127.0.0.1:5888`，建议由 Caddy 或 Nginx 监听 `80/443` 并反向代理，同时启用 HTTPS。例如 Caddy：

```caddyfile
finance.example.com {
    reverse_proxy 127.0.0.1:5888
}
```

VPS 防火墙只需开放 SSH、HTTP 和 HTTPS。若临时需要通过 `http://VPS_IP:5888` 直连，可将 Compose 端口映射改为 `5888:5888` 并限制来源 IP；不建议长期这样部署。

容器设为只读根文件系统，仅 `/app/data` 和 `/tmp` 可写，并丢弃 Linux capabilities。不要扩展为多个副本：SQLite 和内置调度器按单实例部署设计。未来需要水平扩展时，必须先将数据库、任务认领和邮件 outbox 迁移到支持多实例的基础设施。

`docker compose down` 会保留命名卷；`docker compose down -v` 会连同全部资产、历史和事件数据一起删除。除非正在执行已确认的彻底重置，否则不要使用 `-v`。VPS 卷固定命名为 `northstar-finance-data`，因此更换项目目录不会产生一个新的空数据卷。

## 代理端口 7890

直接在 Windows 运行时，可使用：

```dotenv
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
```

容器里的 `127.0.0.1` 指向容器自身，不是宿主机。Docker Desktop 中通常应改成：

```dotenv
CONTAINER_HTTP_PROXY=http://host.docker.internal:7890
CONTAINER_HTTPS_PROXY=http://host.docker.internal:7890
```

Compose 有意不继承宿主机的标准 `HTTP_PROXY` / `HTTPS_PROXY`，以免把宿主机上的密钥或无效的 `127.0.0.1` 配置意外带入容器。Compose 已为 Linux 添加 `host.docker.internal:host-gateway` 映射，但 Linux 宿主机上仅监听 `127.0.0.1:7890` 的代理仍无法接受来自容器网桥的连接。应让代理只在可信的 Docker 网桥地址上监听并设置访问控制，或在明确理解隔离影响后使用 host network。不要把无认证的代理端口暴露到公网。

并非所有 Node HTTP 客户端都会自动读取代理环境变量。行情、新闻与 AI provider 必须在各自适配器中显式使用统一的代理 dispatcher，并对目标域名、重定向、响应大小和超时做限制。

## SQLite 备份与恢复

WAL 模式下不要在应用运行时只复制 `finance.sqlite`，这可能遗漏 `-wal` 中的数据。使用 SQLite 在线备份 API 创建一致快照：

```powershell
docker compose exec finance-dashboard node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database('/app/data/finance.sqlite'); await db.backup('/app/data/finance-backup.sqlite'); db.close();"
docker compose cp finance-dashboard:/app/data/finance-backup.sqlite ./finance-backup.sqlite
```

将快照复制到加密的异地存储，并配置保留周期。恢复前应停止应用、保留当前数据库、将快照放回 `/app/data/finance.sqlite`、确认文件属主可由容器中的 `node` 用户读写，然后启动并检查 `/api/health`、资产总数、最近价格和事件执行记录。备份只有经过定期恢复演练才可信。

本地源码部署的升级流程是：创建在线备份、拉取新代码、`docker compose build`、`docker compose up -d`、检查健康状态和日志。VPS 镜像部署则在备份后修改 `.env` 中的固定 `IMAGE_TAG`，执行 `docker compose --env-file .env -f compose.vps.yml pull` 和 `docker compose --env-file .env -f compose.vps.yml up -d`。涉及 schema 迁移时先在备份副本上验证。

## 调度、邮件和 provider 边界

事件计划、下一次运行时间与执行记录必须持久化到 SQLite。进程重启后调度器应恢复到期任务，并通过数据库唯一约束避免同一计划时点被重复认领。SMTP 无法保证严格的 exactly-once；邮件应通过持久化 outbox、有限重试和可见的执行状态降低丢失与重复风险。

### 当前 AI 实现状态

当前版本只实现了禁用 provider 和用于本地演示、测试的离线 mock provider。以下三种方案都只是预留适配边界，尚未接入：

- **OpenAI API**：环境变量和 `AiProvider` 接口已预留，但尚无 OpenAI HTTP 客户端；填写 `OPENAI_API_KEY` 不会触发真实联网查询。
- **Codex CLI**：尚无子进程 adapter，不会调用本机 `codex` 命令。未来若采用，可基于官方文档中的 [`codex exec` 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)实现受限 worker。
- **TradingAgents**：当前不是项目依赖，也没有 Python 服务或桥接层；未来只能通过独立 provider/worker 接入，不能直接读写生产 SQLite。

因此当前事件“立即运行”和预期资产 AI 检查返回的是 mock 研究结果，不是真实新闻、行情或联网分析。`AI_PROVIDER=none` 是默认生产配置；在真实 provider 完成、测试和安全审查前，不应把 `AI_PROVIDER` 改成 `openai`、`codex` 或 `tradingagents`。

未来扩展遵守以下边界：

- `MarketDataProvider` 只负责按标准资产标识获取报价和来源时间，不直接修改持仓。
- `NewsProvider` 只返回带来源链接和抓取时间的候选信息，不直接改变预期资产状态。
- `AiProvider` 接收最小必要上下文并返回经过 schema 约束的建议；服务端验证后才可落库。
- `NotificationProvider` 负责投递和返回 provider message id，调度器负责重试与审计。

所有 provider 都应有超时、重试上限、速率限制、代理设置和结构化错误。外部网页与 AI 输出一律按不可信输入处理，禁止 provider 直接访问 SQLite、执行任意 shell 或获得不必要的密钥。未来若接入 Codex CLI，应放在受限工作目录或独立 worker 中，只允许结构化输入输出，不应把生产数据库目录、Docker socket 或完整进程环境暴露给它。

`AI_PROVIDER=none` 必须保持为完整可用路径：用户仍可手动维护价格、状态和事件。这样联网 AI 是增强能力，而不是资产数据的单点依赖。

## 上线检查

- `npm test`、`npm run typecheck`、`npm run build` 全部通过。
- `docker compose config` 无警告，镜像健康检查通过。
- 重启容器后资产、历史和计划仍存在，且没有重复执行同一到期任务。
- SMTP 使用测试事件验证收件、失败状态和重试；发信域配置 SPF、DKIM、DMARC。
- 从在线快照恢复到空环境，核对资产、价格历史、事件和执行记录。
- 确认生产 Basic 认证和 AI Bearer token 互相隔离，强密码已轮换，并在反向代理启用 HTTPS、登录限速和安全日志策略。
- 接入真实联网 provider 前完成目标域白名单、重定向/响应体限制、超时和 SSRF 测试。
