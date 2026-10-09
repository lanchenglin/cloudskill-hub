# CloudSkill Hub

> 自托管、Cloudflare 原生、默认私有的 Agent Skills 仓库。**独立开源实现**，同时支持 Claude Code、OpenAI Codex、NousResearch Hermes Agent。

[![CI](https://img.shields.io/badge/tests-node--test-blue)](#测试)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

CloudSkill Hub is an original, dependency-light implementation inspired by the **idea** of a private Skills registry. It does not copy the skillsgist source tree. Compatible interfaces are based on the open Agent Skills conventions and documented discovery endpoints.

## 特性

- **独立云端 Hub**：Cloudflare Worker + D1 + R2；无独立服务器或数据库服务。
- **网页管理后台**：中文/响应式页面、项目分类、搜索、上传文件夹与 `SKILL.md`、编辑、历史版本、回滚。
- **私有优先**：默认不公开。管理员令牌、限定项目的客户端令牌、即时撤销、设备状态和审计记录。
- **Agent Skills**：保留完整 `SKILL.md`（包括 Hermes metadata）、reference、script、assets 等文件。
- **Hermes Agent**：直接安装至 `~/.hermes/skills/<slug>`，并提供符合公开发现示例的 `/.well-known/skills/index.json`。
- **Claude Code / Codex**：安装至 `~/.claude/skills/<slug>` 与 `~/.codex/skills/<slug>`，尊重环境变量自定义路径。
- **跨设备更新**：各设备独立订阅项目，`check`、`sync`、`update`；完整性校验，保护本地修改，更新前备份与失败回滚。
- **公开技能互通**：`/.well-known/skills/index.json`、单个 `SKILL.md`/资源文件、`/.well-known/agent-skills/index.json` 和不可变 ZIP 包。
- **无 Node 运行时依赖**：Worker 与客户端由现代 JavaScript + WebCrypto / Node built-ins 编写。仅部署时使用 Wrangler。

**关于私有兼容性**：Hermes/第三方 Skills 工具不一定能携带本仓库的私有 Bearer Token。因此公开 Skill 可使用原生 well-known 发现；**私有 Skill 统一通过 `cloudskill` CLI** 分发。项目不向公开索引透露私有名称或描述。

## 架构

```text
Browser Admin ────────┐
                      │ HTTPS / Bearer authentication
CloudSkill CLI ───────┼── Cloudflare Worker
  (Windows/WSL/Linux) │    ├── D1 (projects, tokens, skill versions, devices, audit)
                      │    └── R2 (immutable JSON artifacts + ZIP archives)
                      │
  ├── ~/.claude/skills/<name>/
  ├── ~/.codex/skills/<name>/
  └── ~/.hermes/skills/<name>/

Public endpoints: /.well-known/skills/index.json
                  /.well-known/agent-skills/index.json
Private endpoints: /api/*  (token required)
```

## Cloudflare 部署（首次）

要求 Node.js >=22、Cloudflare 账号，且已开通 Workers / D1 / R2。请先检查实际计费、绑定和区域限制。

```bash
# 将本代码放进自己的 Git 仓库后：
git clone https://github.com/YOUR_ACCOUNT/cloudskill-hub.git
cd cloudskill-hub
npm install
npx wrangler login

# 初始化 Cloudflare 资源：
npx wrangler d1 create cloudskill_hub --no-update-config
npx wrangler r2 bucket create cloudskill-hub
```

将 D1 命令返回的 `database_id` 写入 `wrangler.jsonc`，确认 D1 名称、R2 桶名与当前 Cloudflare 账号一致。

生成仅用于**首次引导**的高强度 Secret（不要提交 Git）：

```bash
openssl rand -hex 32
npx wrangler secret put BOOTSTRAP_SECRET
```

运行 `secret put` 时粘贴刚才生成的值。完成数据库迁移及部署：

```bash
npm run db:migrate
npm run deploy
```

打开部署后的 Worker URL：

1. 在登录页展开“首次部署？点击初始化管理员”。
2. 粘贴 `BOOTSTRAP_SECRET`，点击创建管理员。
3. **立即保存只出现一次的管理员 token**，重新登录时需要它。
4. 在 Cloudflare Workers 设置中配置自定义域名，例如 `skills.example.com`。
5. 新建 `devops`、`coding` 等项目；在“访问权限”为每台设备签发不同的客户端令牌，限制可访问项目。

**安全提醒**：在 Cloudflare WAF 中给 `/api/bootstrap` 设置 IP 限制和速率限制。首次引导后，该 API 永久停止签发新管理员，即使 Secret 泄露也不能再次引导；如丢失全部管理员令牌，需要通过受信任的 D1 管理通道恢复，不要在公网开启管理员重置入口。可在首次引导后删除 BOOTSTRAP_SECRET，但下次灾备初始化要重新设置。

## 客户端安装（Windows / Linux / WSL）

从仓库源码运行，无需发布 npm：

```bash
# 此目录下
npm link
cloudskill --help

# 在管理页面签发客户端 token，再将它输入 CLI 登录提示
cloudskill login https://skills.example.com
cloudskill whoami
cloudskill projects
cloudskill list
```

非交互 CI 可通过环境变量传入令牌（不要在命令行参数或 Git 中硬编码）：

```bash
export CLOUDSKILL_TOKEN='csh_YOUR_SECRET'
cloudskill login https://skills.example.com
unset CLOUDSKILL_TOKEN
```

安装到三个 AI 工具：

```bash
cloudskill install devops/linux-audit --agents claude,codex,hermes
```

分别为 Windows、WSL、Linux 服务器配置自己的订阅：

```bash
# 例如一台开发机同步两个项目
cloudskill subscribe devops --agents claude,codex,hermes --skills '*'
cloudskill subscribe coding --agents claude,codex --skills code-review,test-helper

cloudskill sync --dry-run  # 预览
cloudskill sync            # 安装/更新
cloudskill check           # 识别云端版本变化和本地修改
cloudskill update          # 更新本设备已经安装过的 Skills
cloudskill status          # 设备清单上报 Hub
```

默认支持全局技能目录：

| Agent | 目录 | 可自定义的环境变量 |
|---|---|---|
| Claude Code | `~/.claude/skills` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/skills` | `CODEX_HOME` |
| Hermes | `~/.hermes/skills` | `HERMES_HOME` |

请勿用 Hub 直接覆盖 Hermes 自带或其他工具管理的同名技能。CLI 检查本地文件是否属于自己管理的安装；**未托管技能永不覆盖**。通过 `cloudskill` 安装的 Hermes 技能不会写入 Hermes 自己的 `.hub/lock.json`，后续请使用 `cloudskill update` 更新。Hermes 可以通过 `~/.hermes/config.yaml` 的 `skills.external_dirs` 读取共享技能，但该目录可能被 Hermes 写入，当前版本直接写入 Hermes 原生路径以减少不确定性。

本地配置路径（Linux / WSL）为 `~/.config/cloudskill-hub/`，Windows 为 `%APPDATA%/cloudskill-hub/`；包含明文访问令牌，文件权限在类 Unix 系统限制为 `0600`。不要在共享系统账户或被不可信 AI 进程使用的 HOME 中保存管理员令牌。

## 发布技能

目录例子：

```text
my-skill/
├── SKILL.md
├── references/README.md
├── scripts/run.sh
└── assets/logo.png
```

`SKILL.md`：

```markdown
---
name: linux-audit
description: Audit Linux systems and propose safe changes.
version: 1.0.0
metadata:
  hermes:
    tags: [linux, devops]
---
# Linux Audit
...
```

创建 `devops` 项目后，可以从网页上传目录，或使用管理员令牌在本地执行：

```bash
cloudskill publish devops ./my-skill            # 默认私有
cloudskill publish devops ./my-skill --public   # 显式公开（谨慎）
```

后续重新上传创建新版本。内容完全相同不会重复创建版本；版本回滚会创建新的版本号，保留原先历史。

## 第三方 Agent Skills / Hermes 发现

只有显式设置为 `public` 的技能才出现在下列无需身份验证的接口：

```text
GET https://skills.example.com/.well-known/skills/index.json
GET https://skills.example.com/.well-known/skills/<skill>/SKILL.md
GET https://skills.example.com/.well-known/skills/<skill>/references/README.md
GET https://skills.example.com/.well-known/agent-skills/index.json
```

`/.well-known/skills/index.json` 格式兼容开放的 `skills-handler` / Hermes well-known 发现模型；`/.well-known/agent-skills/index.json` 使用 Agent Skills discovery 0.2 archive 索引，含 SHA-256 和 ZIP。公开技能需跨项目唯一名称；私有技能可以在不同项目重名。

Hermes 公共发现示例（具体行为取决于所用 Hermes 版本）：

```bash
hermes skills search https://skills.example.com --source well-known
hermes skills install well-known:https://skills.example.com/.well-known/skills/linux-audit
```

**私有技能**：请执行 `cloudskill install devops/linux-audit --agents hermes`，不要尝试把 Bearer 令牌放到 URL 查询参数中。

## 安全模型与限制

- 随机 192-bit 令牌，服务端只保存 SHA-256 摘要；支持单设备签发与撤销。
- 私有项目通过显式授权项目列表隔离；客户端令牌只读，管理员可发布。
- 无认证 Cookie，所有敏感 API 必须发送 Authorization: Bearer；不开放跨源 CORS。
- 文件名拒绝绝对路径、`..`、软链接和任意隐藏路径段（避免意外上传 `.env` / `.ssh` 等）；每个 Skill 200 文件、6 MiB 原文、4 MiB 单文件。
- 客户端对下载内容校验 SHA-256；完整本地目录指纹检测修改，备份至 `~/.config/cloudskill-hub/backups/` 后替换；失败恢复之前版本。
- CLI 按项目与客户端分配安装范围，绝不自动删除其他 Skills；无后台守护进程，自动更新需使用系统 cron/Task Scheduler 调用 `cloudskill sync`。
- 上传脚本和 Prompt 仍可能存在攻击/恶意指令：本项目不自动执行，但**没有实现技能内容安全扫描**，使用前应人工审核。
- 当前首版只实现全局技能安装，暂无 SSH 远程操控或项目级目录安装；不内置 OAuth、团队账号密码登录、GitHub 导入、`.zip` 网页上传或管理员密码恢复。
- Cloudflare Worker 免费层 CPU 限额可能不足以处理大 ZIP；较大的技能包建议使用 Workers Paid，并压测实际配额。
- 前端没有外部 CDN，配置了 Content Security Policy；会话 token 暂存浏览器 `sessionStorage`，关闭会话即失效（服务端 token 本身仍有效直到撤销）。
- `BOOTSTRAP_SECRET` 应足够随机，不少于 24 个字符；部署后建议为敏感路径启用 Cloudflare WAF 限速。

## 更新与灾备

- 数据库：定期导出 D1，操作之前使用 `wrangler d1 export`；先演练恢复。
- 资源：R2 artifact/archives 不可变，用桶备份/复制策略备份到独立位置。
- 同步：每台客户端安装状态在本地 `state.json` 与服务器心跳中分别保存。
- 升级：保持 `migrations/` 只增不删，先备份后发布。
- Wrangler Static Assets 启用 `run_worker_first`，确保 Worker 同时保护静态管理后台的安全响应头。GitHub Actions `deploy.yml` 默认关闭。配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 仓库 Secrets，并将仓库 Variables 的 `ENABLE_CLOUDFLARE_DEPLOY` 设为 `true` 后才会自动部署。

## 测试

```bash
npm run check
```

使用 Node 22 内置的实验性 SQLite API 运行 D1 协议兼容测试，不需要真的访问 Cloudflare。包括服务端鉴权、项目级凭据、发布、版本、回滚、公开发现、Hermes 路径安装、完整性校验、本地编辑保护及多端同步。真实 Cloudflare Workers/D1/R2 的部署与 Hermes 客户端发现还需要在你的账号中单独做端到端验收。

## 独立项目说明

MIT 开源。实现方案参考但没有复制 [Qsnh/skillsgist](https://github.com/Qsnh/skillsgist) 的代码；公开发现接口参考 [Agent Skills](https://agentskills.io)、[Vercel skills-handler](https://github.com/vercel-labs/skills-handler) 和 [NousResearch Hermes Agent](https://github.com/NousResearch/hermes-agent) 的兼容约定。

## 将代码推送到自己的 GitHub

参见 [docs/PUBLISH_GITHUB.md](docs/PUBLISH_GITHUB.md)；测试报告见 [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md)。
