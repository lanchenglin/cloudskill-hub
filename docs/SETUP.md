# 当前版本首次部署

只使用当前 main；不需要安装中间版本。让 AI 执行时先读 [AI_DEPLOY.md](../AI_DEPLOY.md)。本指南不是部署成功记录。

## 1. 环境、源码与测试

准备 Node.js >=22.16、npm、Git 和自己的 Cloudflare 账号。

```bash
git clone https://github.com/lanchenglin/cloudskill-hub.git
cd cloudskill-hub
npm ci
npm run check
```

`npm test` 会隔离继承的 Hermes/Claude/Codex 和 CloudSkill 配置变量，使用测试临时目录。失败时先修复，不跳过。

密码验证使用原生 scrypt。生产部署需评估 Worker CPU 额度，建议 Workers Paid；不要把本地兼容测试当作免费套餐可用性保证。开通服务或付费须由账号所有者确认。

## 2. 账号授权与资源

```bash
npx wrangler login
npx wrangler whoami
npx wrangler d1 create cloudskill_hub --no-update-config
npx wrangler r2 bucket create cloudskill-hub
```

资源已存在时先核对归属再复用，不重复创建。填写 `wrangler.jsonc` 的真实 D1 `database_id` 和实际 R2 桶名；保留 `DB`、`BUCKET`、`ASSETS` 三个 binding、`nodejs_compat`、静态文件、上传限制和清理 Cron。不要启用 R2 公共桶域名。

## 3. Secret、完整数据库、部署

设置一次性的 `BOOTSTRAP_SECRET`（随机至少 32 字节），通过 Wrangler Secret 输入，不写入 Git、vars 或普通日志。AI 手册有不回显的生成方式。手工设置：

```bash
npx wrangler secret put BOOTSTRAP_SECRET
npm run db:migrate
npm run deploy
```

统一迁移命令会执行所有尚未应用文件：`0001_initial.sql`、`0002_binary_uploads.sql`、`0003_web_auth.sql`、`0004_require_password_change.sql`、`0005_sharing_permissions.sql`，共同组成当前结构。空库不能只应用最后一个文件；不要删除、重命名或合并迁移。部署命令本身不代替数据库初始化。

保存 Wrangler 实际返回的 HTTPS 地址。没有自定义域名时使用自己的 workers.dev 地址；有域名时绑定 Worker，不是把 R2 变成公共桶。

## 4. 设置网页登录账号密码

打开网站首页，展开“首次部署？初始化管理员账号”。输入初始化 Secret，默认用户名 `admin`、初始密码 `lanchenglin`。创建后进入强制改密页面，设置与初始密码不同的 15–128 字符新密码，再使用新密码重新登录。

首次改密页面只填写当前密码、新密码和确认新密码，不需要初始化 Secret，也不需要查找 `bootstrap.json`。没有完成改密前，服务端仍拒绝访问私人数据和管理接口；初始化只能创建一个管理员，重复运行不能恢复默认密码。`BOOTSTRAP_SECRET` 只用于创建账号，确认账号已创建、初始登录正常且账号记录可靠保存后，就可清理远端 Secret 和本地引导文件，不影响稍后的首次改密。固定初始密码公开，部署后请尽快完成改密。

若使用 AI 初始化：

```bash
node scripts/initialize-hub.mjs --url https://YOUR-HUB --credentials-dir /YOUR/PRIVATE/DEPLOY-DIR
```

该私有目录应有部署时生成的 `bootstrap.json`，且在源码仓库外。脚本默认保存 `admin` / `lanchenglin` 到 `web-admin.json`；验证受限登录后返回 `password_change_required`，退出码 **2**，不创建项目或 Token。它不会替用户改密来跳过这一流程。

你完成网页强制改密后，可在网页直接创建 personal 和自行选择 Token；也可将新密码存入仓库外权限为 0600 的 JSON 文件（包含 `password`，可包含 `username`），继续执行：

```bash
node scripts/initialize-hub.mjs --url https://YOUR-HUB --credentials-dir /YOUR/PRIVATE/DEPLOY-DIR --password-file /YOUR/PRIVATE/new-password.json
```

脚本验证新密码成功才更新本地账号文件，只确保 personal 项目存在，不生成任何 Token。错误的新密码不会覆盖已保存账号，过期的默认密码不会自动重置远端。所有真实密码/Secret/Token 不在终端输出。初始化脚本不负责创建 Cloudflare 资源，不能在未知地址运行。

## 5. Token 由你自己在网页签发

共享内容无需 Token；任意客户端可用 `cloudskill connect <URL>` 或打开 `/shared.html` 拉取。

需要修改时，网页登录“访问权限”，自行选择备注、类型和有效期：

| 类型 | 能力 |
|---|---|
| 修改共享技能 shared_writer | 跨分类拉取、发布、更新共享内容；无法读取私有内容 |
| 修改全部技能 all_writer | 跨分类拉取、推送、更新共享与私有内容；无网站管理权限 |

无需勾选项目或指定 A/B/C。项目分类先在网页创建；Token 默认为90天，可选30/365天或永久。永久也支持手动撤销。API 可选1–365天或显式 null。

初始化脚本不签发任何 Token，也没有 A/B 凭据文件。--token-days 不再适用。已存在的旧 Token 不变更权限、不自动延期。

## 6. 安装客户端与验收

每个需要使用技能的环境拉取源码，执行 npm ci、npm link（或直接 node cli/cloudskill.mjs）。不运行 sudo。

```bash
# 仅共享读取：无需 Token
cloudskill connect https://YOUR-HUB
cloudskill list
cloudskill install personal/example --agents hermes
cloudskill update

# 需要修改或读取私有：使用自己网页签发的 Token
cloudskill login https://YOUR-HUB
cloudskill whoami
cloudskill publish personal ./my-shared-skill --public
# 私有发布须修改全部 Token
cloudskill publish personal ./my-private-skill --private
```

先用不含凭据的测试技能。共享读取不要求创建身份；修改共享 Token 不能读取私有，修改全部 Token 仍不能管理账号和其他 Token。测试实际 AI 能发现和加载哪份文件，不只判断安装命令返回。

同一系统用户的多套 Hermes 须隔离 HERMES_HOME 和 CLOUDSKILL_CONFIG_DIR，详见 [USAGE](USAGE.md)。原有未知同名目录不会覆盖，现有冲突保护不变。

## 7. 改密码与恢复

网页登录后在“访问权限”修改密码，需要输入当前密码。成功后全部网页会话失效，但客户端 Token 不变；怀疑泄露时另外撤销相关 Token。

忘记密码由有 Cloudflare/D1 管理权限的部署终端执行：

```bash
npm run reset-password -- --remote --config /YOUR/PRIVATE/DEPLOY-DIR/wrangler.json
```

新密码隐藏输入；AI 可用仓库外 `--password-file`，不要用命令行明文参数。`--revoke-tokens` 是显式撤销全部 API Token 的可选项；默认不影响已有 Token。没有公网重置接口，详见 [AUTH.md](AUTH.md)。

GitHub 自动部署保持关闭；首次上线与验收成功后，才考虑 [可选工作流](PUBLISH_GITHUB.md)。
