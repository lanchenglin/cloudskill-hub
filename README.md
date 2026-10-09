# CloudSkill Hub

> Cloudflare 原生、默认私有的 Agent Skills 仓库。中文网页管理 + 跨设备 CLI，面向 Claude Code、Codex 和 Hermes Agent。

[![CI](https://github.com/lanchenglin/cloudskill-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/lanchenglin/cloudskill-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**v0.2.0：目录 / ZIP 上传、可配置上限、流式校验写入私有 R2，以及安全的多端更新。** 不再把大包转换成一个 Base64 JSON 请求。原 v0.1.0 数据保留，新客户端同时读取两种版本格式。

CloudSkill Hub is an independent implementation inspired by the idea of a private Skills registry; it does not depend on the skillsgist server or CLI. Public discovery follows documented Agent Skills conventions. See [LICENSE](LICENSE) and [upload design](docs/UPLOAD_V2.md).

## 现在可以做什么

- 中文响应式网页：项目分类、搜索、上传单个 `SKILL.md` / 目录 / ZIP、编辑、历史版本、回滚、ZIP 下载。
- 默认私有：管理员负责发布；只读客户端令牌按项目授权，每台设备可独立签发和撤销。
- Windows / Linux / WSL 客户端：安装到 Claude、Codex、Hermes；按设备订阅、检查和更新，不静默覆盖本地修改或未知来源的同名技能。
- 保留完整 `SKILL.md`、Hermes metadata、references、scripts、assets 和模板。ZIP 中的脚本执行权限可保留；浏览器目录上传无法取得 Unix 执行位。
- 上传会话：预检查、进度、取消、同源鉴权、文件与整包 SHA-256 / CRC32 校验。只有校验完成并提交成功，版本才可被安装。
- 并发保护：上传基于指定旧版本，新版本已经发布时拒绝覆盖；重复提交同一个会话不会创建重复版本。
- 公开互通：well-known 文件发现和 discovery 0.2 archive 索引，只列出显式公开的技能。私有技能通过 `cloudskill` CLI 分发。
- 一套 Workers + D1 + R2，无需 VPS、Docker、Redis 或 PostgreSQL。定时回收过期、取消及无引用的上传对象，不删除已发布版本。

**不是技能执行服务，也不是通用网盘。** 本 Hub 不执行上传脚本、不运行模型，也不保证第三方客户端能用自身更新命令管理由 `cloudskill` 安装的技能。

## 文件上传限制

下面是 **v2 网页 / CLI 默认上传链路** 的上限，单位为二进制 MiB / KiB：

| 项目 | 默认 | 当前代码允许配置的最高值 |
|---|---:|---:|
| 一个 Skill 的原始文件总大小 | 50 MiB | 64 MiB |
| 单个文件 | 20 MiB | 32 MiB |
| 一个 Skill 的文件数（含 `SKILL.md`） | 1000 | 2000 |
| 输入 ZIP / 规范化传输 ZIP 大小 | 55 MiB | 70 MiB |
| `SKILL.md` | 256 KiB | 固定 |
| 文件相对路径 UTF-8 字节数 | 256 | 固定 |
| 目录深度 | 16 | 固定 |
| 单条目 ZIP 解压倍率 | 200 倍 | 固定 |

`wrangler.jsonc` 的 `vars` 配置 `MAX_SKILL_FILES`、`MAX_SKILL_BYTES`、`MAX_FILE_BYTES`、`MAX_ARCHIVE_BYTES`，修改后重新部署。网页和 CLI 从 `/api/capabilities` 读取实际值；并非网页可直接修改。必须满足单文件 ≤ 总文件 ≤ ZIP 大小，超出代码安全上限的配置会报错，不会默默放行。

每个管理员令牌最多 **3 个同时活跃的上传会话、每小时 20 次会话创建**；会话有效期 **1 小时**。这些值暂为服务端常量。上传超时为 5 分钟，部分中断的文件需要重新传完整 ZIP；已完整传好但未确认发布的 ZIP 可复用会话，**不是字节级断点续传**。

v1 JSON 发布接口为了兼容旧脚本仍保留 **200 文件 / 总计 6 MiB / 单文件 4 MiB / JSON 请求 9 MiB**，不会因 v2 的新设置而放宽。迁移与安全边界详见 [UPLOAD_V2.md](docs/UPLOAD_V2.md)。

## 架构

```text
Browser / cloudskill CLI
  ├─ 读取服务器限制、目录或 ZIP 本地预检查
  ├─ 本地解压、生成规范 ZIP + 文件清单
  └─ Authorization: Bearer / HTTPS
           ↓
Cloudflare Worker
  ├─ D1：授权、项目、版本、上传会话、设备、审计
  ├─ 流式核验 ZIP 布局、长度、每文件和整包摘要
  └─ R2 私有桶：不可变 ZIP + 小型 manifest
           ↓  全部校验通过，再提交版本
cloudskill install / update / sync
  ├─ Claude Code
  ├─ Codex
  └─ Hermes Agent
```

默认是 **经 Worker 流式写入 R2 binding**，不是浏览器直连 R2 的预签名 URL。不需要额外配置 S3 Access Key 或桶级浏览器 CORS。Worker 不解压输入 ZIP、不把整个新格式包读成 Base64；浏览器和 CLI 仍会为 ZIP 检查、摘要计算使用有上限的本地内存。

大包、较高并发场景应在实际 Cloudflare 套餐上压测 CPU、内存、请求和存储配额；应用允许 50 MiB 不等于免费套餐已通过生产性能验收。未实现不限大小、分片直传、杀毒扫描或全站总存储配额。

## 首次部署 Cloudflare

要求 **Node.js 22.16 或以上**，已启用 Workers / D1 / R2 的 Cloudflare 账号。

```bash
git clone https://github.com/lanchenglin/cloudskill-hub.git
cd cloudskill-hub
npm install
npm run check
npx wrangler login

npx wrangler d1 create cloudskill_hub --no-update-config
npx wrangler r2 bucket create cloudskill-hub
```

将 D1 返回的 `database_id` 填入 `wrangler.jsonc`，核对数据库、R2 名称及账号。R2 桶必须保持私有，不要启用公开桶域名。

```bash
# 生成首次初始化用的随机值，随后粘贴到 secret put 的交互提示
openssl rand -hex 32
npx wrangler secret put BOOTSTRAP_SECRET

# 必须先执行迁移，再部署代码
npm run db:migrate
npm run deploy
```

打开 Worker 域名，在登录页展开“首次部署？点击初始化管理员”，填写 Secret，立即保存只显示一次的管理员令牌。登录后创建项目，再为不同设备签发有项目范围的只读客户端令牌。发布设备另用管理员令牌，不要在所有机器上共享管理员凭据。

在 Worker 设置中添加自己的域名。为 `/api/bootstrap` 及敏感 API 配置访问和速率限制；初始化完成后可以删除 `BOOTSTRAP_SECRET`。丢失全部管理员凭据需要从可信 D1 管理通道恢复，不要在公网添加免认证重置入口。

`wrangler.jsonc` 包含每 5 分钟执行的上传清理 Cron。GitHub Actions 自动部署保持默认关闭；只有配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` Secrets，并将 `ENABLE_CLOUDFLARE_DEPLOY` 仓库 Variable 设为 `true` 才会启用原有自动部署工作流。

## 从 v0.1.0 升级

先备份 D1 与 R2，并保留自己已填写的 `database_id`、绑定和域名设置；不要把示例配置覆盖到真实账号。

```bash
git pull --ff-only
npm install
npm run check
npm run db:migrate    # 包括新的 0002_binary_uploads.sql
npm run deploy
npm link             # 每台使用 CLI 的机器也要更新源码并执行
```

新增迁移只增加字段和上传会话表，旧版本及旧 R2 文件不会被重写。**旧 CLI 读取 v2 大包时会收到 426 并提示升级**；新 CLI 可以读取旧包。`cloudskill publish ... --legacy` 仅用于显式发布旧格式小目录。部署顺序、灾备和回退限制见 [升级说明](docs/UPLOAD_V2.md#升级与回退)。

## 使用客户端

在源码目录运行 `npm link`，无需先将包发布到 npm：

```bash
cloudskill --help
cloudskill login https://skills.example.com
cloudskill whoami
cloudskill limits
cloudskill projects
cloudskill list

cloudskill install devops/linux-audit --agents claude,codex,hermes
cloudskill subscribe devops --agents claude,codex,hermes --skills '*'
cloudskill sync --dry-run
cloudskill sync
cloudskill check
cloudskill update
cloudskill status
```

发布支持目录与 ZIP，要求管理员令牌：

```bash
cloudskill publish devops ./linux-audit
cloudskill publish devops ./linux-audit.zip
cloudskill publish devops ./linux-audit.zip --public
cloudskill publish devops ./linux-audit.zip --private

# 检查或恢复完整上传会话（示例 id 请换成真实值）
cloudskill uploads
cloudskill uploads up_YOUR_SESSION_ID
cloudskill publish devops ./linux-audit.zip --resume up_YOUR_SESSION_ID
cloudskill cancel-upload up_YOUR_SESSION_ID
```

CLI 首次发布默认私有；未指定 `--public` / `--private` 时，更新已有技能保留原可见性。网页发布区的“公开”复选框是本次发布的明确选择，默认不勾选；编辑已存在技能时保留其可见性。

一个 ZIP 对应一个 Skill，可包含一个最外层文件夹；其中需要根 `SKILL.md`。支持常见 STORE / DEFLATE ZIP，不支持加密 ZIP、ZIP64、多磁盘 ZIP、软链接或特殊文件。复制/打包时应排除 `.env`、`.git` 等隐藏内容。参考样例在 `examples/skills/devops-check/`。

### 安装范围与本地保护

| Agent | 默认全局目录 | 环境变量 |
|---|---|---|
| Claude Code | `~/.claude/skills` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/skills` | `CODEX_HOME` |
| Hermes | `~/.hermes/skills` | `HERMES_HOME` |

当前实现使用上述全局目录，保留 v0.1.0 路径约定。没有项目级安装或 SSH 远程操控。不同 Agent 版本的发现路径及加载行为需在所使用的实际客户端确认，文件安装测试不等于模型已执行技能。

客户端不接管未知来源的同名技能、不自动执行脚本、不把本地改动静默覆盖。通过 `cloudskill` 安装的 Hermes 技能不写入 Hermes 自身的 `.hub/lock.json`；后续使用 `cloudskill update`。系统自带技能请使用原工具管理，避免混用更新器。

配置/令牌默认保存于 Linux/WSL `~/.config/cloudskill-hub/` 或 Windows `%APPDATA%/cloudskill-hub/`。Unix 文件权限设为 `0600`，但同一系统用户运行的程序仍能读取明文令牌；Windows 要依赖账号隔离和文件 ACL，不宣称加密保险库。

v2 更新备份放在各 Agent 配置根下的 `.cloudskill-backups/`，**不放在可被 Agent 扫描的 `skills/` 目录**，并保持与安装目标在同一文件系统，以支持失败恢复。例如 `~/.hermes/.cloudskill-backups/`。备份暂无自动保留数量策略，需定期检查磁盘使用。

## 第三方 Skills / Hermes 互通

```text
/.well-known/skills/index.json
/.well-known/skills/<skill>/SKILL.md
/.well-known/skills/<skill>/references/guide.md
/.well-known/agent-skills/index.json
```

这些公开入口保留，不会列出私有名称或描述。公开技能的历史 ZIP 摘要地址在该技能仍为公开时可以下载；改为私有后，匿名历史 ZIP 地址也会拒绝访问。已被他人下载的内容无法远程收回。

第三方 `skills` / Hermes 原生工具是否支持私有鉴权由其版本决定；本项目不把私有令牌放进 URL 来强行兼容。私有统一使用 `cloudskill install ... --agents hermes` 等命令。原生工具实际端到端发现和加载不是本仓库单元测试的保证。

## 测试、文档与边界

```bash
npm run check                       # 语法 + 安全与集成测试，无 Cloudflare 凭据
node scripts/worker-smoke.mjs        # npm install 后：真实本地 workerd/D1/R2
python scripts/browser-smoke.py      # 另需 Playwright 与 Chromium
```

CI 包含 Ubuntu、Windows、原生本地 Workers 运行时及 Chromium 网页上传/编辑/下载检查。实际执行结果和测试范围见 [TEST_RESULTS.md](docs/TEST_RESULTS.md)，接口见 [API.md](docs/API.md)，工程设计见 [UPLOAD_V2.md](docs/UPLOAD_V2.md)。

历史版本、备份和审计记录会占用存储；默认不会自动删除已发布内容。上传的脚本和提示词仍可能恶意，安装前应审核，不能把 ZIP 结构验证当作内容安全扫描。尚未实现功能列于 [ROADMAP.md](docs/ROADMAP.md)。

实现思路参考 [skillsgist](https://github.com/Qsnh/skillsgist)、[Agent Skills](https://agentskills.io)、[skills-handler](https://github.com/vercel-labs/skills-handler) 和 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的公开约定；项目本身为 MIT 独立实现。
