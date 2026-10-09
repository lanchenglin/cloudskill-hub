# 当前版本首次部署与初始化

本指南从“没有部署过 CloudSkill Hub”开始，只使用 `main` 当前代码。**项目尚未在实际使用的 Cloudflare 账号完成首次部署；本文是操作指南，不是已完成的部署记录。**

最终只部署一个私人 Hub，多套 Hermes / Claude Code 在各自环境安装 CLI 并连接它。不要先装另一个版本，也不要重建已经存在的 GitHub 源码仓库。

交给 AI 执行时，优先使用根目录 [AI_DEPLOY.md](../AI_DEPLOY.md)。它补充了账号/资源识别、仓库外凭据保存、接口初始化、隔离验收及失败处理；本文件保留人工操作流程。

## 1. 准备运行环境和源码

准备 Node.js **22.16 或以上**、npm、Git，以及可使用 Workers、D1、R2 的 Cloudflare 账号。平台是否需要开通服务或产生费用，以自己的账号为准。

在部署用的 Linux、WSL 或 Windows PowerShell 终端执行：

```bash
node --version
npm --version
git clone https://github.com/lanchenglin/cloudskill-hub.git
cd cloudskill-hub
npm install
npm run check
```

已有这份源码时直接进入目录，不必重复 clone。所有后续 `npm` 和 `wrangler` 命令都在源码根目录执行。检查失败时先处理报错，不要跳过后直接上线。

## 2. 登录 Cloudflare，创建 D1 与 R2

```bash
npx wrangler login
npx wrangler d1 create cloudskill_hub --no-update-config
npx wrangler r2 bucket create cloudskill-hub
```

保存 D1 返回的 `database_id`。这些命令会操作 Cloudflare 资源；资源已经存在时核对后复用，不要为了重试反复创建。

编辑根目录的 `wrangler.jsonc`：

| 配置 | 首次部署要填写或核对的值 |
|---|---|
| `name` | Worker 名称，默认 `cloudskill-hub` |
| `d1_databases[0].binding` | 保持 `DB`，代码依赖此名称 |
| `d1_databases[0].database_name` | 实际 D1 名称，默认 `cloudskill_hub` |
| `d1_databases[0].database_id` | 用刚才的真实 ID 替换示例占位值 |
| `d1_databases[0].migrations_dir` | 保持 `migrations` |
| `r2_buckets[0].binding` | 保持 `BUCKET`，代码依赖此名称 |
| `r2_buckets[0].bucket_name` | 实际私有 R2 桶名，默认 `cloudskill-hub` |

保留文件里的 `nodejs_compat`、静态资源配置、上传限制和清理 Cron。R2 桶保持私有，不要启用公开桶域名。

## 3. 设置首次初始化 Secret

在终端生成随机值，保存到自己的安全位置：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put BOOTSTRAP_SECRET
```

在 `secret put` 的交互提示里粘贴刚才生成的随机值。它不是管理员令牌，也不是 Cloudflare API Token；它只用于首次建立管理员身份。不要把真实值写进 `wrangler.jsonc`、README、GitHub 或普通日志。

## 4. 初始化数据库，然后部署 Worker

```bash
npm run db:migrate
npm run deploy
```

`db:migrate` 会按顺序执行 `migrations/` 中全部尚未应用的 SQL。当前包含 `0001_initial.sql`、`0002_binary_uploads.sql`，它们共同构成**当前应用的完整数据库结构**，不是让你安装两套程序。

**首次空库不能只运行 `0002`，也不要删除、改名或合并 SQL 文件来简化步骤。** 使用上面统一命令即可。`npm run deploy` 本身不会代替数据库初始化。

部署完成后保存终端返回的 Worker URL。可在 Cloudflare 控制台为该 Worker 添加自定义域名，例如 `skills.example.com`；后续 CLI 统一连接实际使用的 HTTPS 域名。文档中的域名都只是示例，没有现成的共享服务器。

## 5. 在网页初始化管理员和项目

打开 Worker 网站首页，不是 `/setup` 路径。展开“首次部署？点击初始化管理员”，输入 `BOOTSTRAP_SECRET`，创建管理员。

立即保存只显示一次的管理员令牌。登录后创建项目：

```text
项目标识：personal
项目名称：个人技能
```

在访问权限页面准备不同用途的令牌：

| 用途 | 当前需要的角色 | 权限说明 |
|---|---|---|
| A：发布或修改技能 | `admin` | 管理员具备全站管理权限；当前没有限定项目的发布角色 |
| B / C：安装、更新技能 | `client` | 勾选 `personal` 等所需项目，只读 |
| 另一套也要发布的 Hermes | `admin` | 只放在可信发布环境，不应为了方便给所有实例发管理员令牌 |

给各设备使用不同的令牌标签，便于分别撤销。项目先建好，再签发具有项目范围的只读令牌。

初始化成功后可以删除 Cloudflare 中的 `BOOTSTRAP_SECRET`，并配置敏感接口访问/速率规则。只在确认已保存管理员令牌后删除 Secret。丢失全部管理员令牌需要通过可信数据库管理渠道恢复，不要在公网开放免认证重置。

## 6. 给 A、B 分别安装 CLI

每个实际运行 Hermes / Claude Code 的环境都需要 Node.js 和 CLI；它们不需要 Cloudflare 部署权限。部署机兼作 A 时直接使用已有源码。

在还没有源码的客户端环境执行：

```bash
git clone https://github.com/lanchenglin/cloudskill-hub.git
cd cloudskill-hub
npm install
npm link
cloudskill --help
cloudskill login https://skills.example.com
cloudskill whoami
cloudskill limits
```

将域名换成实际 Hub 地址。登录时 A 粘贴发布用管理员令牌，B 粘贴只读客户端令牌。当前交互输入会显示在终端，不要在录屏或共享终端中输入。

`cloudskill` 命令不在 PATH 或 `npm link` 权限不合适时，可以在源码根目录直接调用：

```bash
node cli/cloudskill.mjs login https://skills.example.com
node cli/cloudskill.mjs --help
```

不要因此用 `sudo` 运行日常客户端，否则可能读写另一个用户的 HOME、令牌和技能目录。多套 Hermes 位于同一系统账号时，先按 [实例配置](USAGE.md) 设置各自的目录，再分别登录。

## 7. 首次验收：先用不含凭据的示例

A 在源码根目录发布自带示例：

```bash
cloudskill publish personal ./examples/skills/devops-check --private
```

B 首次安装，再检查状态：

```bash
cloudskill install personal/devops-check --agents hermes
cloudskill check
cloudskill status
```

随后 A 修改自己的示例技能文本并再次 `publish`，B 执行 `cloudskill update`，核对 B 的文件已变化；A 未发布之前、B 未更新之前，都不应出现自动同步。

接着在实际 Hermes 中确认能发现并使用这份技能。测试 Claude Code 时用 `--agents claude`。B 已有不受 CloudSkill 管理的同名目录时，先自行备份和整理，再决定纳入方式；不要使用 `--force` 试图接管未知目录。

这一轮通过后，再逐步发布自己的私人技能。不要一开始就拿真实生产密钥做演示。日常发布、订阅新增技能、权限和故障处理见 [USAGE.md](USAGE.md)。

## 8. 可选：首次部署成功后再开启 GitHub 自动部署

初次使用不需要启用自动部署。`ci.yml` 自动测试不等于已经部署；`deploy.yml` 受开关和资源配置控制。

完成首次配置和验收后，再按 [GitHub 工作流](PUBLISH_GITHUB.md) 设置 Secrets 与部署开关。本说明修改不启用开关、不创建资源、不部署 Worker。
