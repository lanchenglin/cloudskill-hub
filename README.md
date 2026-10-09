# CloudSkill Hub

> 多套 Hermes / Claude Code 共用的私人 Skills 仓库：**A 修改后手动发布，B 需要时手动更新。**

[![CI](https://github.com/lanchenglin/cloudskill-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/lanchenglin/cloudskill-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

当前版本 **0.3.2**，使用 `main` 的完整代码。只需安装当前版本，不需要依次安装开发阶段的中间版本。

**网页用管理员账号和密码；客户端用独立 Token。** A 使用指定项目的 `publisher` 发布令牌，B 使用 `client` 只读令牌。不再需要把全站管理员权限交给每套 Hermes。

本地、原生本地 Workers 和浏览器测试不代表你的服务已经上线。本仓库没有代替用户执行生产 Cloudflare 部署；实际账号、套餐和真实 A/B 模型加载仍需首次部署时验收。

## 从这里开始

| 任务 | 说明 |
|---|---|
| 交给 AI 部署 | [AI_DEPLOY.md](AI_DEPLOY.md)，入口 [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) |
| 自己首次部署 | [docs/SETUP.md](docs/SETUP.md) |
| A 发布、B 更新、多套 Hermes | [docs/USAGE.md](docs/USAGE.md) |
| 登录、改密码、令牌权限、密码恢复 | [docs/AUTH.md](docs/AUTH.md) |
| 上传限制和存储 | [docs/UPLOAD_V2.md](docs/UPLOAD_V2.md) |
| 对接 API / 测试范围 | [API](docs/API.md) / [TEST_RESULTS](docs/TEST_RESULTS.md) |

交给部署 AI：

```text
请拉取 lanchenglin/cloudskill-hub 的 main，完整读取 AGENTS.md 和 AI_DEPLOY.md，
使用我已授权的 Cloudflare 账号执行首次部署及验收，不要只给建议。
初始化网页账号 admin，初始密码 lanchenglin，交付地址并提示我首次登录必须改密。
不要替我改成随机密码或跳过强制改密。改密完成后，再创建 personal 和 A/B 的 publisher/client Token。
所有实际新密码、初始化 Secret 和 Token 保存在仓库外私有目录，不在聊天中回显。
没有凭据、目标不明确或需额外付费时说明阻塞，不更换账号、不清库、不关闭鉴权。
```

## 使用方式

```text
A 的 Hermes 创建 / 修改 Skill
        │ 手动 cloudskill publish --private
        ▼
一个私人 CloudSkill Hub（Workers + D1 + 私有 R2）
        │ B 按需手动 install / update / sync
        ▼
B、C 的 Hermes / Claude Code / 已适配客户端
```

GitHub 保存本项目的**程序源码**；`cloudskill publish` 把**技能内容**送到自己的 Hub，不会提交到公开 GitHub。

完成 Hub 部署、创建 `personal` 项目并在各设备安装 CLI 后：

```bash
# A 登录时填写限定 personal 的发布 Token（不是网页密码）
cloudskill login https://skills.example.com
cloudskill publish personal "$HOME/.hermes/skills/my-skill" --private

# B 登录时填写只读 Token；首次安装，以后更新
cloudskill install personal/my-skill --agents hermes
cloudskill update

# 还要接收 personal 项目新增技能：订阅一次，再按需 sync
cloudskill subscribe personal --agents hermes --skills '*'
cloudskill sync

# 安装到 Claude Code
cloudskill install personal/my-skill --agents claude
```

`sync` 只从 Hub 拉取，`publish` 才上传；没有后台监控或自动双向合并。B 本地也修改过时会提示冲突，不静默覆盖。同名但未被本 Hub 管理的目录不会被接管。

## 登录与授权

| 用途 | 身份 | 权限 |
|---|---|---|
| 你使用网页 | 自己设置的管理员账号密码 | 管理项目、技能、客户端 Token，修改密码 |
| A / 可信发布设备 | `publisher` Token | 读取和发布指定项目的私有技能，不能改账号、签发令牌或公开技能 |
| B / C / 只需使用技能的工具 | `client` Token | 只读取指定项目 |

**首次初始化默认账号 `admin`，初始密码 `lanchenglin`。第一次登录必须先修改密码，不能跳过。** 修改前只能读取登录状态、修改密码或退出，不能读取私人技能、管理项目、上传、下载或签发 Token；服务端检查 `must_change_password`，不是只在页面弹窗。刷新、重新登录或直接调用 API 都不能解除限制。

**首次改密不再需要 `BOOTSTRAP_SECRET` 或其他所有权证明。** 登录后只需填写当前密码、新密码和确认新密码；刷新、换浏览器或重新登录也不需要查找 `bootstrap.json`。`BOOTSTRAP_SECRET` 仅用于部署时首次创建管理员，已有 Token-only 实例仍需原管理员授权转换，这些部署鉴权与改密无关。

固定初始密码是公开值，任何知道地址和默认凭据的人都可能抢先改密；部署后应尽快由本人完成首次改密，不要把默认账号长期留在公网。

AI 初始化把初始账号保存到 `web-admin.json`，返回 `password_change_required` 并以退出码 **2** 暂停；这不是部署失败，也不会提前创建项目或 A/B Token。你在网页改密后，用新密码重新登录；可以直接在网页创建项目和令牌，或给初始化脚本提供仓库外的新 `--password-file` 继续，届时才生成 `publisher-a.json`、`client-b.json`。**升级已有账号不会重置成默认密码。**

新密码要求 15–128 字符，必须不同于初始密码，支持空格和 Unicode；`lanchenglin` 只在初始化哈希时例外，普通改密和可信恢复不接受短密码。使用原生 scrypt 与独立随机盐保存哈希。网页用 HttpOnly / Secure / SameSite Cookie，不把长期管理员 API Token 放进浏览器存储。会话有 12 小时绝对期限、30 分钟空闲期限；退出立即撤销当前会话。改密码撤销全部网页会话，**不会自动撤销客户端 Token**；疑似泄露时另外执行撤销。

新 Token 默认 90 天有效，可选择 1–365 天、逐个撤销；到期后在网页重新签发并更新客户端。已有 API Token 的兼容、重新验证、可信恢复和安全限制见 [AUTH.md](docs/AUTH.md)。

**密码哈希会消耗 CPU。** 本地 workerd 验证了兼容性，但不代表免费套餐已通过线上 CPU 验收；建议在 Workers Paid 评估生产部署。AI 不得擅自升级套餐，也不得降低密码哈希参数来掩盖配额问题。

## 当前功能

中文响应式网页支持目录 / ZIP 上传、搜索、编辑、历史版本、回滚和下载。上传使用规范 ZIP 二进制流写入私有 R2，包含路径安全、长度、CRC32 和 SHA-256 校验，支持进度、取消、完整包上传后的会话恢复及过期清理。

客户端保留完整 SKILL.md、Hermes 元数据、references、scripts、assets。只更新托管技能，校验后替换、更新前备份、失败恢复；未变化的 sync/update 不重复下载 ZIP。`--dry-run` 只预检，不落盘、不验证尚未下载的远端字节。

| 限制 | 默认 | 代码允许配置上限 |
|---|---:|---:|
| 单 Skill 原始文件合计 | 50 MiB | 64 MiB |
| 单文件 | 20 MiB | 32 MiB |
| 文件数（含 SKILL.md） | 1000 | 2000 |
| 输入 / 规范 ZIP | 55 MiB | 70 MiB |
| SKILL.md | 256 KiB | 固定 |

修改 `wrangler.jsonc` 的上传 vars 后重新部署。网页和 `cloudskill limits` 读取实际设置；这不是不限大小的网盘或字节级断点续传。上传配额是每个发布身份 3 个活跃会话、每小时 20 次创建，不是全站存储/账单上限。

## 首次部署概要

Node.js >=22.16，Git，拥有 Workers / D1 / R2 权限的 Cloudflare 账号：

```bash
git clone https://github.com/lanchenglin/cloudskill-hub.git
cd cloudskill-hub
npm ci
npm run check
npx wrangler login
npx wrangler d1 create cloudskill_hub --no-update-config
npx wrangler r2 bucket create cloudskill-hub
```

将真实 D1 ID 写入配置、核对资源归属和私有桶，再安全设置 `BOOTSTRAP_SECRET`。执行 `npm run db:migrate` 初始化 **全部 SQL**，随后 `npm run deploy`。打开网站首页完成管理员初始化，用初始密码登录并完成强制改密；不是去 `/setup` 路径。

**首次空库需要 0001、0002、0003、0004 全部迁移**，不要只运行最后一个文件。GitHub 自动部署仍默认关闭；上述是说明，不代表已操作用户账号。

## 凭据与互通边界

私有访问控制不是凭据保险库。普通 Skill 文件里的密码会随文件复制，并留在历史和备份；隐藏 `.env` / `.ssh` 等路径仍被拒绝。网页登录改为密码不代表技能内容获得了额外端到端加密。真实私密技能不要提交到源码仓库、公开索引或示例目录。

本项目是技能分发服务，不运行模型。当前支持 Claude、Codex、Hermes 的目录适配；不同 Agent 版本的实际发现和执行仍须验证，后续新工具需要适配，不能把文件安装成功当作通用模型执行保证。只显式公开的技能出现在 well-known 索引，私有技能使用本项目 CLI；发布 Token 不允许公开技能。

详情：[使用与多实例](docs/USAGE.md) · [安全设计](docs/AUTH.md) · [测试](docs/TEST_RESULTS.md) · [后续候选](docs/ROADMAP.md)。

MIT 独立实现，参考 skillsgist、Agent Skills、skills-handler 和 Hermes 的公开思路与接口约定，不依赖 skillsgist 服务端或 CLI。
