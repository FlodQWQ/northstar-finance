# Northstar Finance

Northstar Finance 是一个自托管的个人资产与事件跟踪面板。当前版本包含直接资产、预期资产、价格及状态历史、事件计划和执行记录。系统默认可以在没有 AI、行情源或 SMTP 的情况下运行；联网研究支持 Codex SDK，并可回退到 OpenCode + Agent-Reach/Exa。

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

全新数据库首次运行前，应在 `.env` 中暂时设置 `APP_AUTH_USERNAME` 和 `APP_AUTH_PASSWORD` 创建首个 owner；确认登录后即可删除这两个明文值。后续用户从页面提交注册申请，由 owner 在“设置 -> 账号审批”中批准。生产模式下由单个 Express 进程在 `PORT=5888` 同源提供 API 与 `dist/` 静态文件。

## 环境变量

从 `.env.example` 开始配置；`.env` 包含密钥，不应提交到 Git。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 时由 Express 服务 `dist/` |
| `PORT` | `5888` | 生产 HTTP 端口；Docker 内固定为 `5888` |
| `API_PORT` | `5889` | 仅开发模式的 API 端口 |
| `HOST` | `127.0.0.1` | 本地监听地址；容器内使用 `0.0.0.0` |
| `VITE_BASE_PATH` | `/` | 前端构建时的公开路径；子路径部署可设为 `/northstar/` |
| `HOST_PORT` | `5888` | 仅 Compose 使用的宿主机映射端口，不改变容器内端口 |
| `TZ` | `Asia/Shanghai` | 调度与日志展示时区；持久化时间仍应使用 UTC |
| `DATABASE_PATH` | `./data/finance.sqlite` | SQLite 文件路径；容器内为 `/app/data/finance.sqlite` |
| `SEED_DEMO_DATA` | 开发为 `true`，生产为 `false` | 是否在空数据库中写入演示资产与事件 |
| `APP_BASE_URL` | `http://127.0.0.1:5888` | 会话 Cookie Path、同源校验、AI capabilities 与未来邮件链接使用的公开地址 |
| `REGISTRATION_MODE` | 开发为 `open`，生产为 `closed` | `open` 允许提交待 owner 审批的注册申请；`closed` 仅允许已有账户登录 |
| `APP_AUTH_USERNAME` / `APP_AUTH_PASSWORD` | 空 | 全新数据库的一次性 owner 启动账号；迁移 v1 数据库时也用它接管旧数据 |
| `SCHEDULER_ENABLED` | `true` | 是否启动持久化事件调度器 |
| `SCHEDULER_POLL_MS` | `30000` | 扫描到期事件的间隔，单位毫秒 |
| `SCHEDULER_LEASE_MS` | `600000` | 单次调度任务的数据库租约时长，单位毫秒 |
| `SMTP_HOST` | 空 | SMTP 主机；为空时邮件 provider 保持禁用 |
| `SMTP_PORT` | `587` | SMTP 端口，通常为 `587` 或 `465` |
| `SMTP_SECURE` | `false` | 端口 `465` 通常设为 `true`；`587` 使用 STARTTLS |
| `SMTP_USER` / `SMTP_PASS` | 空 | SMTP 凭据，生产环境建议使用应用专用密码 |
| `SMTP_FROM` | 空 | 发件人地址；SMTP 连接参数只能由部署环境配置，不接受账户 API 修改 |
| `AI_PROVIDER` | `disabled` | `auto` 优先 Codex 并回退 OpenCode；也可固定为 `codex-sdk`、`opencode-agent-reach` 或 `disabled` |
| `AI_API_TOKEN` | 空 | 仅用于迁移 v1 全局 AI token；v2 使用账户内创建的 scoped API token |
| `AI_WORKER_URL` / `AI_WORKER_TOKEN` | 本地 worker / 空 | 主应用访问隔离 AI worker 的内部地址与 Bearer token；生产 token 必须随机生成 |
| `AI_REQUEST_TIMEOUT_MS` | `200000` | 主应用等待 worker 的总时限 |
| `AI_PROVIDER_TIMEOUT_MS` / `AI_JOB_TIMEOUT_MS` | `90000` / `190000` | 单个 provider 和包含一次回退的完整任务时限 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | 空 / OpenAI API | Codex 和 OpenCode 的服务端认证与 API 地址，只注入 AI worker |
| `CODEX_MODEL` / `CODEX_MODEL_REASONING_EFFORT` | 空 / `medium` | Codex 模型与推理强度；空模型由 Codex 运行时选择 |
| `OPENCODE_MODEL` | 空 | OpenCode 的 `provider/model`；也可拆分为 `OPENCODE_PROVIDER_ID` 和 `OPENCODE_MODEL_ID` |
| `HTTP_PROXY` / `HTTPS_PROXY` | 空 | 服务端行情、新闻和 AI 出站代理 |
| `NO_PROXY` | `localhost,127.0.0.1` | 不经过代理的地址列表 |
| `CONTAINER_HTTP_PROXY` / `CONTAINER_HTTPS_PROXY` | 空 | 仅 Compose 使用，映射为容器内标准代理变量 |

所有金额、价格和数量应作为十进制定点值处理，不应经过 JavaScript 浮点数计算。SQLite 数据目录和备份包含个人财务信息，应限制访问权限并加密异地备份。

总览只汇总与“本位币”相同的资产，其他币种会标记为“未折算”，不会在缺少汇率时被直接相加。行情 provider 后续接入汇率能力后，再扩展统一折算。

## 访问认证

页面使用应用内注册和登录，不再触发浏览器 HTTP Basic 权限框。密码以 `scrypt` 加盐散列保存；随机 Session token 仅通过 `HttpOnly; SameSite=Lax` Cookie 传输，数据库只保存 token 哈希。生产 HTTPS 下 Cookie 同时设置 `Secure`。所有会话写请求必须通过精确 Origin 和 CSRF 双重校验。

每个资产、流水、价格、预期资产、事件、运行记录、邮件 outbox、设置和 AI 审计行都绑定不可变的 `owner_id`。仓储查询不会接受客户端提交的 owner，跨账户资源访问统一返回 `404`。调度器、邮件与 AI 命令同样按 owner 执行。

生产环境未配置 `REGISTRATION_MODE` 时默认关闭注册。首次部署应先设置一次性的 `APP_AUTH_USERNAME` 和 `APP_AUTH_PASSWORD` 创建 owner，确认登录后从环境中删除这两个明文值，再按需将 `REGISTRATION_MODE` 改为 `open`。页面注册只会创建 `pending` 普通成员，不会下发 Session；owner 可通过 `GET /api/admin/registrations` 查看申请，并通过对应的 `approve` 或 `reject` 接口处理。批准后账户才能登录，且不会因注册顺序取得全局 owner 权限。管理接口沿用 Session、精确 Origin 和 CSRF 防护。静态登录页面、`/api/health` 和认证接口公开，普通业务 API 必须使用 Session。登录按客户端 IP 和规范化账户双重限流，其中账户失败计数保存在 SQLite，不能通过切换 IP 或重启服务绕过。

AI 路由只接受账户级 Bearer token，不接受页面 Session；Bearer token 也不能访问普通业务 API。

升级 v1 数据库时，首次启动需暂时保留原 `APP_AUTH_USERNAME`、`APP_AUTH_PASSWORD` 和可选 `AI_API_TOKEN`。迁移会把所有旧数据和旧 AI token 归属该 owner；成功登录并确认数据后即可从环境文件删除这些旧变量。新生产库也可用同样两个账号变量创建一次性 owner；两者只在数据库尚无启动 owner 时读取。

## AI 原子命令 API

登录账户后可通过 `POST /api/account/api-tokens` 创建只显示一次的 token，并为其分配 scope。读取 capabilities 需要 `ai:read`；执行命令批次同时需要 `finance:write` 和批内每种命令对应的细粒度 scope，例如 `assets:write`、`prices:write`、`operations:write`、`expected:write` 或 `events:write`。`GET /api/account/api-tokens` 列出当前账户的 token 元数据，`DELETE /api/account/api-tokens/:id` 吊销 token；这些账户接口使用页面 Session、Origin 和 CSRF 保护。

`GET /api/ai/capabilities` 返回白名单命令、确认要求、版本键格式和完整 JSON Schema。读取能力和写入 `POST /api/ai/commands/execute` 必须携带所属账户的 token：

```http
Authorization: Bearer <ACCOUNT_API_TOKEN>
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

- `idempotencyKey` 在账户内唯一并绑定规范化后的完整请求；同键同请求会重放结果，同键不同请求返回冲突。
- 所有更新命令必须在 `expectedVersions` 提供带类型前缀的版本，例如 `asset:<id>`；缺失或冲突时整批回滚。
- 所有金额和数量必须是十进制字符串。
- 流水、非零期初持仓、预期资产阶段变更，以及可启动联网任务或邮件的事件变更必须设置 `confirmed: true`。
- 只要批内有一条高风险命令未确认，整批都会变成 `proposal`，任何业务数据都不会写入。
- proposal 和 `dryRun: true` 会在回滚事务内执行完整领域校验，包括批内多条命令的累计影响，但不会保留业务写入。
- 每个批次及命令都有审计记录；接口不接受 SQL、任意网络请求、密钥修改或 shell 命令。

`confirmed` 是调用方声明的防误操作开关，不等同于独立的人类审批或签名。当前 MVP 尚无 proposal 审批工作流；接入自动化 AI 时，应让编排层在明确的用户授权后才设置该字段，不能让模型自行决定。

## AI 联网研究

AI 研究运行在独立 worker 中，主应用只通过内部 Bearer token 调用它。worker 不挂载 SQLite 数据卷，也不接收 Session、SMTP 或资产 API token；模型凭据则不会注入主应用。事件说明和搜索到的网页都按不可信输入处理。

`auto` 模式固定先使用官方 `@openai/codex-sdk`。每次 Codex 线程使用只读沙箱、禁止审批并设置 `webSearchMode: live`；本地 shell、统一执行、多代理、hooks 和 connector 工具均被禁用，子进程也不继承环境变量。如果没有 SDK 产生的 `web_search` 项，整次结果视为失败并进入备用 provider。备用路径先通过 Agent-Reach/MCPorter 以固定参数调用 Exa，再由官方 OpenCode SDK v2 在无工具权限的临时会话中归纳搜索结果。这样联网动作是编排层强制执行的，不依赖模型是否遵守“请搜索”的提示。Agent-Reach 固定在提交 `1221ecd0c3e0502ee37406f03543bedf7503f2c7`，MCPorter 固定为 `0.13.2`，不会在容器启动时运行未锁版本的安装器。

模型输出按同一份严格 JSON Schema 约束并最终通过 Zod 运行时校验。成功结果至少包含一个绝对 HTTP(S) 来源；OpenCode 来源还必须实际出现在 Agent-Reach/Exa 的原始搜索输出中。摘要、变化、实际 provider 和来源会写入对应账户的运行记录。设置页“测试 AI”会发起一次真实的轻量联网 canary，不是只检查端口。

Docker 中的最小配置如下，`AI_WORKER_TOKEN` 应使用 `openssl rand -hex 32` 等方式生成：

```dotenv
AI_PROVIDER=auto
AI_WORKER_TOKEN=<long-random-token>
OPENAI_API_KEY=<server-side-api-key>
CODEX_MODEL=
OPENCODE_MODEL=opencode/big-pickle
```

没有模型凭据时平台仍可正常管理资产，但 AI 研究会明确失败，不能把 worker 健康检查通过理解为联网 canary 已通过。

## Docker

镜像使用固定 Node 24 Debian slim 基础版本和多阶段构建。同一镜像分别启动主应用和 AI worker 两个非 root 容器；SQLite 只挂载到主应用的 `finance-data`，AI 状态使用独立的 `ai-state`。生产环境默认不写入演示资产，只有显式设置 `CONTAINER_SEED_DEMO_DATA=true` 才会启用演示数据。

### 本地构建与运行

```powershell
Copy-Item .env.example .env
# 修改 .env；至少确认 APP_BASE_URL、REGISTRATION_MODE，并为 AI_WORKER_TOKEN 生成随机值
docker compose up -d --build
docker compose ps
docker compose logs -f finance-dashboard
```

默认端口映射是 `127.0.0.1:5888:5888`，不会直接暴露到公网。本机可访问 <http://127.0.0.1:5888>。Compose 从被 Git 忽略的 `.env` 文件读取插值；使用其他环境文件时传入 `docker compose --env-file <path> ...`。`.env`、`docker compose config` 输出和 `docker inspect` 输出都可能包含密钥，不应提交或公开分享。

### 发布到 Docker Hub

先在 Docker Hub 创建 `northstar-finance` 仓库，然后在 PowerShell 中构建并推送当前机器架构的镜像：

```powershell
$DockerHubUser = "your-dockerhub-username"
$Version = "0.1.0"
$ViteBasePath = "/" # 子路径部署时改成 "/northstar/"
docker login --username $DockerHubUser
docker build --pull --target runtime --build-arg "VITE_BASE_PATH=$ViteBasePath" -t "${DockerHubUser}/northstar-finance:${Version}" -t "${DockerHubUser}/northstar-finance:latest" .
docker push "${DockerHubUser}/northstar-finance:${Version}"
docker push "${DockerHubUser}/northstar-finance:latest"
```

仓库中的 `.github/workflows/docker-publish.yml` 可自动发布 `linux/amd64` 和 `linux/arm64`。在 GitHub 仓库的 Actions secrets 中配置 `DOCKERHUB_USERNAME` 和只具备该仓库读写权限的 `DOCKERHUB_TOKEN`：推送 `main` 会生成 `latest`、`main` 和 `sha-*` 标签，推送 `v0.1.0` 之类的 Git tag 会生成语义化版本标签。

若镜像固定部署在子路径，在 GitHub Actions variables 中设置 `VITE_BASE_PATH`，例如 `/northstar/`。这是前端构建参数，容器启动后再修改不会改变已生成的资源路径。

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
# 编辑 .env：填写 DOCKER_IMAGE、固定 IMAGE_TAG、公开 URL、AI_WORKER_TOKEN、注册模式和可选 SMTP/AI 配置
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

部署在 `/northstar/` 之类的子路径时，镜像必须用相同的 `VITE_BASE_PATH` 构建，反向代理还必须剥离该前缀后再转发。Nginx 的 `proxy_pass` 上游地址末尾斜杠不能省略：

```nginx
location = /northstar {
    return 308 /northstar/;
}

location ^~ /northstar/ {
    proxy_pass http://127.0.0.1:5888/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /northstar;
}
```

应用只信任紧邻它的一层反向代理，因此 Nginx 必须发送单一、已规范化的客户端地址，不能继续追加外部传入的 `X-Forwarded-For`。使用 Cloudflare 橙云时，应先按 Cloudflare 官方 IP 段配置 `set_real_ip_from`，再设置 `real_ip_header CF-Connecting-IP` 和 `real_ip_recursive on`；此后 `$remote_addr` 才是经过来源校验的真实客户端地址。不要在未限制来源时直接信任客户端提交的 `CF-Connecting-IP`。

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

将快照复制到加密的异地存储，并配置保留周期。恢复前应停止所有使用该卷的容器，保留当前数据库，然后清理 `/app/data/finance.sqlite`、`/app/data/finance.sqlite-wal` 和 `/app/data/finance.sqlite-shm` 三个文件，再把快照放回 `/app/data/finance.sqlite`，确认文件属主可由容器中的 `node` 用户读写。v1/v2 回滚必须同时切回对应镜像和数据库快照；旧镜像不能直接运行迁移后的 v2 数据库。启动后检查 `/api/health`、schema 版本、外键完整性、资产总数、最近价格和事件执行记录。备份只有经过定期恢复演练才可信。

本地源码部署的升级流程是：创建在线备份、拉取新代码、`docker compose build`、`docker compose up -d`、检查健康状态和日志。VPS 镜像部署则在备份后修改 `.env` 中的固定 `IMAGE_TAG`，执行 `docker compose --env-file .env -f compose.vps.yml pull` 和 `docker compose --env-file .env -f compose.vps.yml up -d`。涉及 schema 迁移时先在备份副本上验证。

## 调度、邮件和 provider 边界

事件计划、下一次运行时间与执行记录必须持久化到 SQLite。进程重启后调度器应恢复到期任务，并通过数据库唯一约束避免同一计划时点被重复认领。SMTP 主机、端口、发件人和凭据只从服务器环境读取，账户仅保存自己的默认收件地址，避免账户输入改变携带全局凭据的连接目标。SMTP 无法保证严格的 exactly-once；邮件应通过持久化 outbox、有限重试和可见的执行状态降低丢失与重复风险。

### 公开行情源

`PriceProvider` 的默认值仍是 `manual`，不会产生外部请求。需要按资产账户自动更新价格时，在服务端环境设置 `PRICE_PROVIDER=multi`（或指定 `binance`、`okx`、`bitget`、`bybit`、`gate`、`coingecko` 作为首选源）。`multi` 会先根据账户名选择交易所，再按 Binance、OKX、Bitget、Bybit、Gate，最后 CoinGecko 的顺序回退；交易所 API 均为公开行情接口，不需要账户密钥。

请求只允许固定的 HTTPS 域名，禁止重定向，单次请求有超时和 512 KiB 响应上限，报价链有总时限并使用短缓存。需要代理时使用 `PRICE_PROXY=http://host:port`；Docker 容器不能填写容器内的 `127.0.0.1`，应填写容器可达的宿主机地址。也可使用 `PRICE_TIMEOUT_MS`、`PRICE_MAX_QUOTE_TIME_MS` 和 `PRICE_CACHE_TTL_MS` 调整网络参数。

账户名仅用于选源，不会被当作 URL。`NVDAon`、`QQQon`、`IBMon` 等 Ondo 代币会按 OKX 的 `X...`、Bitget 的 `R...` 市场别名查询；`spSEI`、`sUSDat`、`preOPAI` 等无交易所现货对的资产会回退 CoinGecko。新增或纠正映射可通过受控的 `PRICE_SYMBOL_ALIASES_JSON`、`PRICE_COINGECKO_IDS_JSON` 配置，不要把用户输入直接拼接为 endpoint。

### 当前 AI 实现状态

当前支持 `disabled`、开发专用 `mock`、`codex-sdk`、`opencode-agent-reach` 和 Codex 优先的 `auto`。生产部署默认仍为 `disabled`；启用后，事件“立即运行”和预期资产 AI 检查会执行真实联网搜索，并将实际 provider、来源和搜索证据写入对应账户的运行记录。完整配置和隔离边界见上文“AI 联网研究”。

Codex SDK 的 `web_search` 完成项可以证明本次运行执行了实时搜索，但当前 SDK 不返回原始搜索结果 URL，因此 Codex 引用仍属于模型输出，不能当作来源内容的密码学证明。OpenCode 备用路径则会把模型引用限制为 Agent-Reach/Exa 原始结果中实际出现的 URL。两条路径的外部内容仍需按不可信输入处理。

未来扩展遵守以下边界：

- `MarketDataProvider` 只负责按标准资产标识获取报价和来源时间，不直接修改持仓。
- `NewsProvider` 只返回带来源链接和抓取时间的候选信息，不直接改变预期资产状态。
- `AiProvider` 接收最小必要上下文并返回经过 schema 约束的建议；服务端验证后才可落库。
- `NotificationProvider` 负责投递和返回 provider message id，调度器负责重试与审计。

所有 provider 都有超时、并发上限、代理设置和结构化错误。外部网页与 AI 输出一律按不可信输入处理；provider 运行在独立 worker 中，不挂载生产 SQLite 或 Docker socket，Codex 命令工具关闭，OpenCode 模型工具权限全部拒绝。

`AI_PROVIDER=disabled` 保持为完整可用路径：用户仍可手动维护价格、状态和事件。主应用启动也不依赖 AI worker 健康，因此联网 AI 是增强能力，而不是资产数据的单点依赖。

## 上线检查

- `npm test`、`npm run typecheck`、`npm run build` 全部通过。
- `docker compose config` 无警告，镜像健康检查通过。
- 重启容器后资产、历史和计划仍存在，且没有重复执行同一到期任务。
- SMTP 使用测试事件验证收件、失败状态和重试；发信域配置 SPF、DKIM、DMARC。
- 从在线快照恢复到空环境，核对资产、价格历史、事件和执行记录。
- 确认页面 Session 和 AI Bearer token 互相隔离，细粒度 scope 生效，并在反向代理启用 HTTPS、登录限速和安全日志策略。
- 接入真实联网 provider 前完成目标域白名单、重定向/响应体限制、超时和 SSRF 测试。
