# CloudSkill Hub

> 自己使用的 Cloudflare Skills Hub。**共享技能任何人都能拉取；修改需要你在网页签发的 Token。**

[![CI](https://github.com/lanchenglin/cloudskill-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/lanchenglin/cloudskill-hub/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

当前完整版本 **0.4.3**，开发使用 `main`，发布使用 CI 通过后自动同步的 `worker`；不需要安装中间版本。Workers + D1 + 私有 R2，无需独立 VPS。尚未代替用户完成生产 Cloudflare 部署，本地/CI 结果不代表已经上线。

## 权限只有这三种使用方式

| 使用方式 | 拉取共享技能 | 修改共享技能 | 拉取/修改私有技能 | 管理网站账号和 Token |
|---|---|---|---|---|
| 无 Token 的访客 | 可以 | 不可以 | 不可以 | 不可以 |
| **修改共享技能 Token** (`shared_writer`) | 可以 | 可以 | 不可以 | 不可以 |
| **修改全部技能 Token** (`all_writer`) | 可以 | 可以 | 可以 | 不可以 |
| 网页管理员账号密码 | 可以 | 可以 | 可以 | 可以 |

这里只需签发**两种 Token**，没有“公共只读 Token”的必要，也不再按 A/B/C 设备或项目分配 Token 类型。项目只用于技能分类。备注可以自定义，任何一套 Hermes / Claude / CLI 使用哪个 Token，就获得该 Token 的权限；它不与设备字母绑定。

**Token 由你自己在网页“访问权限 → 新建令牌”里签发。** 选择“修改共享技能”或“修改全部技能”，再选择 30 / 90 / 365 天或永久有效；不主动选择时仍默认 90 天。永久表示不自动到期，仍可随时单独撤销。修改网页密码不会自动撤销这些 Token。

**令牌以后也可以查看。** 登录后台进入“访问权限 → 令牌列表 → 查看 / 复制”，刷新或重新登录不影响再次查看。列表默认不显示明文；展开后可以复制、手动隐藏，60 秒后自动隐藏。

新令牌保留认证哈希和 AES-256-GCM 加密副本，密钥使用独立的长期 Worker Secret `TOKEN_ENCRYPTION_KEY`，不是把明文存进数据库或公开 Git。首次部署按说明生成并保存密钥，日常查看不需要手工输入密钥。旧版本只存哈希的 Token 无法还原，仍保持原权限和有效期；需要可查看的新令牌时由你自己签发。详情见 [令牌查看与密钥维护](docs/TOKEN_VIEW.md)。

初始化和 AI 部署脚本**不会自动签发任何 Token**，也不生成 publisher-a.json / client-b.json。原有旧 Token 只保留原权限，不会因升级自动变成“修改全部”。

## 网页管理入口

| 页面 | 用途 |
|---|---|
| **访问权限** | 令牌列表、备注搜索、权限/状态筛选；点击“新建令牌”签发，列表中查看/复制或撤销 |
| **项目分类** | 查看分类和技能数量、创建分类，不再混在访问权限中 |
| **账号设置** | 修改网页密码、查看当前账号、退出当前浏览器 |

“退出登录”固定在顶部，桌面和手机均可见；仅退出当前浏览器，不撤销客户端 Token。上传中退出会先确认，网络失败会提示重试，不会把仅清空页面当成退出成功。批量撤销位于访问权限底部折叠的高风险操作区，仍需要明确确认。

## 最简单的用法

### 只拉取共享技能：不需要 Token

```bash
cloudskill connect https://skills.example.com
cloudskill list
cloudskill install personal/my-skill --agents hermes
cloudskill update

# 想同时接收共享项目中新增加的技能：订阅一次，之后手动 sync
cloudskill subscribe personal --agents hermes --skills '*'
cloudskill sync
```

`connect` 是明确的匿名只读连接（也支持 `login <URL> --public`），不会询问或发送 Token，不上报匿名设备清单。私有内容不出现在目录、历史、下载或文件接口。错误/失效的已配置 Token 不会悄悄降级为匿名访问。

也可以直接打开网站的 **`/shared.html`** 浏览并下载共享技能，无需登录。

### 修改技能：使用自己签发的 Token

```bash
# 在提示中粘贴网页签发的 Token，不是管理员密码
cloudskill login https://skills.example.com
cloudskill whoami

# 共享修改 Token：在已有分类中发布/更新共享技能
cloudskill publish personal ./my-skill --public

# 全部修改 Token：也可发布/更新私有技能
cloudskill publish personal ./private-skill --private
```

共享 Token 不能读取私有内容，不能把私有技能改成共享，也不能把共享技能隐藏为私有。全部 Token 可管理两种内容，但**不具备修改网站账号、创建项目分类、签发或撤销其他 Token 的管理权**；这些由网页管理员完成。

更新已有技能时，省略可见性会保持现有状态。新建时，共享修改 Token 默认共享，全部修改 Token 默认私有；建议明确写 `--public` / `--private`。修改和回滚均保留版本；目前没有技能删除 API，不把“修改”冒充包含未实现的删除功能。

手动工作流保持不变：任意环境修改 → 手动 `publish` → 其他环境需要时手动 `update` / `sync`。没有后台自动双向同步或自动合并。

## 共享不是“仅我的设备可见”

本项目的共享就是**公开可读**，无需账号或 Token。含密码、API Key、私钥的技能应设为**私有**，只通过“修改全部技能”Token 拉取。不要把真实技能和凭据提交到这个公开的 GitHub 程序源码仓库。

私有访问控制不是凭据保险库。文件中的凭据仍会随文件复制、进入版本历史和本地备份；隐藏 `.env` / `.ssh` 等危险路径仍被拒绝。客户端拿到文件后，撤销 Hub Token 不能收回已经复制的服务密钥。

将最新版本设为共享时，不会自动公开过去的私有版本。共享访问必须同时满足“技能当前是共享”和“该版本在发布时是共享”；变回私有后匿名访问停止。可见性变更会建立新版本，即使文件字节相同。

## 程序发布分支

**main → 全部六项 CI 通过 → 自动同步 worker → Cloudflare 从 worker 构建部署。** worker 是固定发布分支，保存本次测试通过的完整源码；不手工切新分支、不放独立修改、不强推覆盖。main 测试失败时 worker 不变，晚完成的旧任务不会覆盖较新提交。

GitHub 仅负责测试和分支同步，旧的直接部署工作流已移除；不需要在 GitHub 填 Cloudflare 密钥或个人 PAT。Cloudflare 的生产分支需在后续连接时选 `worker`，不能把 GitHub 配置完成当作 Cloudflare 已部署。详见 [GitHub 与 Cloudflare 发布流程](docs/PUBLISH_GITHUB.md)。

## 安装与部署入口

| 任务 | 文档 |
|---|---|
| 交给 AI 部署 | [AI_DEPLOY.md](AI_DEPLOY.md)，AI 入口 [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) |
| 首次手动部署 | [docs/SETUP.md](docs/SETUP.md) |
| 客户端连接、发布、安装、更新 | [docs/USAGE.md](docs/USAGE.md) |
| 管理员密码与 Token 权限 | [docs/AUTH.md](docs/AUTH.md) |
| API / 上传 / 测试 | [API](docs/API.md) · [上传](docs/UPLOAD_V2.md) · [测试范围](docs/TEST_RESULTS.md) |

Node.js >=22.16、npm、Git 和有 Workers/D1/R2 权限的 Cloudflare 账号：

```bash
git clone https://github.com/lanchenglin/cloudskill-hub.git
cd cloudskill-hub
npm ci
npm run check
npx wrangler login
npx wrangler d1 create cloudskill_hub --no-update-config
npx wrangler r2 bucket create cloudskill-hub
```

核对实际账号及资源，填写 D1 ID，私有 R2 保持私有；安全设置首次创建账号用的 BOOTSTRAP_SECRET 和长期保存的 TOKEN_ENCRYPTION_KEY，然后执行 `npm run db:migrate`、`npm run deploy`。**空库需要全部 0001–0006 迁移**，它们共同组成当前程序，不是安装多个版本。

初始网页账号 **admin**，密码 **lanchenglin**。首次登录必须先改成 6–20 字符的新密码，不能跳过，**改密不需要额外 Secret**。初始化脚本退出码 2 表示等待本人改密，不是部署失败。已有账号不会因升级重置；初始密码公开，部署后尽快完成改密。

完成改密后，在网页创建分类和自行签发 Token；只拉取共享技能的环境不用签发。真实部署、真实 Agent 发现和执行应分别验收。当前个人自用，不进行性能扩展，也不自动启用 GitHub 部署。

## 保留的功能与边界

中文网页：上传目录或 ZIP、搜索、编辑、版本历史、回滚、下载、登录/改密和手动 Token 管理。上传仍使用 Worker 流式校验写入私有 R2。CLI 校验完整性，保护本地修改和未知同名目录，更新前备份，失败恢复。

| 上传限制 | 默认 | 可配置最高值 |
|---|---:|---:|
| 单 Skill 所有原文件 | 50 MiB | 64 MiB |
| 单文件 | 20 MiB | 32 MiB |
| 文件数 | 1000 | 2000 |
| ZIP | 55 MiB | 70 MiB |
| SKILL.md | 256 KiB | 固定 |

当前适配 Claude、Codex、Hermes 的目录；实际 Agent 版本的发现规则须验证。旧版已发现但本次未修改的本地状态/批量冲突等问题见 [ROADMAP](docs/ROADMAP.md)，不能将权限修改说成这些问题也已解决。

MIT 独立实现，参考 skillsgist、Agent Skills、skills-handler 和 Hermes 的公开思路与接口，不依赖 skillsgist 服务端或 CLI。
