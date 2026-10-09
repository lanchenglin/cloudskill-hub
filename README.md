# CloudSkill Hub

> 给多套 Hermes 和其他本地 AI 工具共用的私人 Skills 仓库：**A 修改后手动发布，B 需要时手动更新。**

[![CI](https://github.com/lanchenglin/cloudskill-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/lanchenglin/cloudskill-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

当前代码版本：**0.2.1**，使用 `main` 分支。文档只面向当前版本，不需要先安装其他版本。

**部署状态：已进行本地和 GitHub Actions 测试，尚未在实际使用的 Cloudflare 账号完成首次部署，也未完成 A/B 设备的真实 AI 加载验收。下面提供的是首次部署与使用步骤，不代表服务已经上线。**

CloudSkill Hub is a self-hosted, Cloudflare-native private Agent Skills registry. Publish an edited skill from one environment, then manually install or update it in another. The application source is open; skills published to your own Hub are private by default.

## 解决什么问题

```text
A：Hermes 创建或修改一个 Skill
          │ 手动 cloudskill publish
          ▼
你的 CloudSkill Hub（Workers + D1 + 私有 R2）
          │ B 需要时手动 install / update / sync
          ▼
B、C：其他 Hermes 实例 / Claude Code / 已适配的客户端
```

不要求后台监控、自动回传或双方自动合并。A 发布完成后，B 不会立即变化；B 执行更新命令后才获取仓库中的新内容。B 本地也有修改时，默认拒绝覆盖并提示。

**两个“仓库”不要混淆：** GitHub 的 `lanchenglin/cloudskill-hub` 存放本项目程序源码；你部署的 Hub 将技能内容存到自己的 R2、将元数据存到 D1。`cloudskill publish` 不会把技能提交到这个公开 GitHub 仓库。

## 从这里开始

| 你要做什么 | 文档 |
|---|---|
| 还没有部署，准备首次安装 | [首次部署与初始化](docs/SETUP.md) |
| A 发布、B 手动更新，多套 Hermes 共用 | [日常使用与多实例配置](docs/USAGE.md) |
| 查看上传大小、ZIP 校验和会话规则 | [上传与存储设计](docs/UPLOAD_V2.md) |
| 对接程序接口 | [API 说明](docs/API.md) |
| 查看实际测试及尚未验收的范围 | [测试报告](docs/TEST_RESULTS.md) |
| 区分源码提交与技能发布、配置可选自动部署 | [GitHub 与部署工作流](docs/PUBLISH_GITHUB.md) |

首次使用的顺序是：**部署一个 Hub → 网页创建 `personal` 项目并签发令牌 → A/B 安装 CLI → A 发布 → B 首次安装 → B 按需更新。** 无需安装多个应用版本，也无需重复部署多个 Hub。

## 日常操作

以下示例在 Hub 部署完成、`personal` 项目已创建、A/B 均已安装 CLI 并登录后执行。`my-skill` 是示例技能名，目录中的 `SKILL.md` 必须使用对应的 `name`。

### A：技能修改好后，手动发布

```bash
# Linux / WSL，Hermes 使用默认目录时
cloudskill publish personal "$HOME/.hermes/skills/my-skill" --private

# 也可以发布任意准备好的 Skill 目录或 ZIP
cloudskill publish personal ./my-skill --private
cloudskill publish personal ./my-skill.zip --private
```

发布会保存技能版本；相同内容重复发布不会重复增加版本。当前发布需要 **管理员令牌**，请只配置在可信的发布环境。发布目录不要求预先由 CloudSkill 安装。

### B：首次安装，以后手动更新

```bash
# 首次安装到 B 的 Hermes
cloudskill install personal/my-skill --agents hermes

# A 再次发布后，B 需要时执行
cloudskill update
```

`update` 更新的是 B **已经通过 CloudSkill 安装过**的技能，不会把整个仓库的所有技能都安装下来。B 只需要对应项目的 **只读客户端令牌**。

### B：还要接收项目中新增的技能

```bash
# 设置一次订阅；星号加引号，避免被 shell 展开
cloudskill subscribe personal --agents hermes --skills '*'

# 每次需要时手动执行：安装新增技能，并更新已订阅的技能
cloudskill sync
```

`subscribe` 只保存订阅，不启动后台任务。`sync` 只从 Hub 拉取，不会把 B 的本地修改上传。B 要回传自己的修改，也需获得发布权限后显式执行 `publish`。

### Claude Code 及其他客户端

```bash
cloudskill install personal/my-skill --agents claude

# 同一环境需要同时安装到两种工具
cloudskill install personal/my-skill --agents claude,hermes
```

当前 CLI 适配项为 `claude`、`codex`、`hermes`；其他 AI 工具需要增加适配，不宣称自动兼容所有工具。这里的 Claude 指本地 **Claude Code**，不是 claude.ai 网页账号。目录安装成功不等于所有 Agent 版本都已加载并执行技能，尤其要核对所用 Codex 的实际扫描目录，见 [路径与实例配置](docs/USAGE.md)。

## 当前功能

- 中文网页：项目分类、搜索、上传单个 `SKILL.md` / 目录 / ZIP、编辑技能、查看版本、回滚和下载 ZIP。
- 私有访问：按项目签发只读客户端令牌，管理员发布；各设备可使用不同令牌并分别撤销。
- 手动分发：`publish`、`install`、`update`、订阅后 `sync`，以及 `check`、`--dry-run` 和设备状态上报。
- 文件完整性：保留 `SKILL.md`、Hermes metadata、references、scripts、assets；核对文件与整包 SHA-256 / CRC32。
- 本地保护：不接管未知来源同名目录，不默认覆盖本地修改；更新前备份，失败恢复；未变化的同步不重复下载 ZIP。
- 上传会话：进度、取消、已完整上传会话的恢复、发布时版本冲突检查、幂等提交和过期对象清理。

技能版本和历史备份是本项目的功能，不是要求你部署多个软件版本。当前没有自动双向同步、自动冲突合并、远程控制电脑或技能执行服务。

## 文件上传限制

| 项目 | 默认上限 | 当前允许配置的最高值 |
|---|---:|---:|
| 一个 Skill 的原始文件总大小 | 50 MiB | 64 MiB |
| 单个文件 | 20 MiB | 32 MiB |
| 文件数量，包含 `SKILL.md` | 1000 | 2000 |
| 输入 ZIP / 规范化 ZIP | 55 MiB | 70 MiB |
| `SKILL.md` | 256 KiB | 固定 |

一个上传对应一个 Skill；根目录必须有 `SKILL.md`。支持常见 STORE / DEFLATE ZIP，拒绝加密包、ZIP64、软链接、危险路径及 `.env` 等隐藏路径。路径、压缩倍率、会话配额等细节见 [上传说明](docs/UPLOAD_V2.md)。

上传参数在 `wrangler.jsonc` 的 `vars` 中配置；网页和 `cloudskill limits` 读取服务器实际值。**默认通过 Worker 流式校验并写入私有 R2，不是浏览器直连 R2。** 没有字节级断点续传；未传完的 ZIP 需要重新完整上传。应用限额不等于真实 Cloudflare 套餐已通过满额生产压测。

## 私人技能与凭据

普通文件里的内容会随技能一起分发，但**当前不是独立的凭据保险库**。含真实凭据的技能必须保持私有，不要提交到 GitHub、开启公开发布或公开 R2 桶，也不要放入本仓库的 `examples/` 后提交。`.env` 等隐藏文件会被拒绝，不能把整个 `.hermes` 配置目录当成一个 Skill 上传。

Skill 内的凭据可能留在历史包、已下载副本和更新备份中；撤销 Hub 访问令牌不会收回这些副本，也不会撤销对应第三方服务的密钥。本地 Hub 令牌以文件保存，不是系统级加密密钥库。建议技能引用环境变量，真实密钥在受控环境中提供。详见 [凭据与权限边界](docs/USAGE.md)。

## 测试与当前边界

```bash
npm run check
```

现有 CI 检查包括 Ubuntu、Windows、原生本地 workerd/D1/R2 以及 Chromium 网页流程。当前应用代码的验证依据和 40 项测试范围见 [测试报告](docs/TEST_RESULTS.md)。

**尚未完成真实 Cloudflare 首次部署、线上配额/并发验收、手机真机测试，以及真实 Hermes/Claude/Codex 会话的技能加载与执行验收。** 测试通过不是已经替你上线。后续候选功能见 [ROADMAP.md](docs/ROADMAP.md)。

## 开源与参考

[MIT License](LICENSE)。本项目独立实现，不依赖 skillsgist 的服务端或 CLI。思路与接口参考 [skillsgist](https://github.com/Qsnh/skillsgist)、[Agent Skills](https://agentskills.io)、[skills-handler](https://github.com/vercel-labs/skills-handler) 和 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的公开约定。
