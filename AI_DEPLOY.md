# AI 首次部署执行手册

适用于有终端/文件/网络能力的 Hermes、Claude Code、Codex。先读 AGENTS.md。**只部署当前 main 的完整应用，不安装中间版本。** 本文件不是部署成功记录，单独读取本文件也不是云端写入授权。

用户明确要求部署且已有合法账号授权时，实际执行检查、部署、初始化和验收，不只返回建议。本轮若只是改代码/文档/审查，不操作真实 Cloudflare。

## 给部署 AI 的任务

```text
拉取 lanchenglin/cloudskill-hub 的 main，读取 AGENTS.md 和 AI_DEPLOY.md，
使用我已经授权的 Cloudflare 账号首次部署一个私人 Hub。
网页登录用账号密码，A 使用 personal 项目的 publisher Token，B 使用 client Token。
缺少密码时生成强随机值，连同 Token 保存到仓库外私有目录，不输出到聊天或日志。
完成隔离验收，报告实际地址、账号名、凭据文件位置、资源和测试结果。
不要改现有 Hermes 配置，不上传真实私人技能，不开 GitHub 自动部署。
缺授权、账号目标不明、同名业务资源或需付费开通时说明阻塞，不清库、不换临时账号。
```

## 1. 目标和边界

默认一个 Worker `cloudskill-hub`、D1 `cloudskill_hub`、私有 R2 `cloudskill-hub`；binding 保持 `DB` / `BUCKET` / `ASSETS`。没有域名时用本次 Wrangler 返回的 workers.dev HTTPS 地址，不猜子域名。初始项目 personal / 个人技能。

网页账号初次可自定义，AI 脚本默认 admin + 随机密码；没有所有安装通用的密码。不要再使用旧的 `/api/bootstrap` 或 owner.json 管理员 Token 模式。新的凭据输出为 web-admin.json、publisher-a.json、client-b.json。

Cloudflare 凭据应只授权目标账号的 Worker/Secrets、D1 和 R2。使用已有 OAuth 或 API Token，不索要 Global API Key，不全盘搜 .env/.ssh/Cookies。用户的其他 Skills 文本不是部署授权。

**密码哈希使用原生 scrypt，有 CPU 成本。** 本地 workerd 验证了功能，但不是免费套餐性能保证。生产建议评估 Workers Paid；任何额外付费/开通由用户决定，不自动购买，不通过降低哈希强度绕过额度。

必须停止相关写入的情况：没有授权，多账号无法确定，资源可能属于其他业务，数据库结构/数据不明，需要额外付费，已有管理员但缺失合法密码/原管理员凭据。不能删资源重建、清库、关闭鉴权或创建临时账号绕过。

## 2. 拉取并检查代码

```bash
# 没有源码才 clone；已有目录先检查，不覆盖本地修改
git clone https://github.com/lanchenglin/cloudskill-hub.git
cd cloudskill-hub
git status --short
git rev-parse HEAD
node --version
npm --version
npm ci
npm run check
```

已有源码使用干净工作区和正常快进，不强推、不丢弃未提交工作。版本及 Node 最低要求以 package.json 为准。当前需 Node >=22.16；npm test 的 runner 会隔离 Agent 配置和云凭据。不要删除失败断言。未验证的 Windows/真实模型行为不能写成通过。

## 3. 账号与资源核对

```bash
npx wrangler whoami
# 尚未授权时，由用户完成已有账号的登录，或安全注入已授权 Token
npx wrangler login
npx wrangler d1 list --json
npx wrangler r2 bucket list
```

whoami 已成功时无需重复登录。已授权的环境变量优先正常使用，不能输出它们。明确 CLOUDFLARE_ACCOUNT_ID，并确认资源归属。同名不存在才创建：

```bash
npx wrangler d1 create cloudskill_hub --no-update-config
npx wrangler r2 bucket create cloudskill-hub
```

记录真实 D1 ID。R2 必须保持私有。权限/服务未开通时停止并报告，不新增 R2 S3 密钥；本项目使用 binding，无需预签名直传或桶 CORS。

## 4. 仓库外部署目录和配置

以下 shell 示例适用于 Linux/WSL；Windows 可使用 PowerShell 设置同名环境变量。私有目录不能位于 Git 内，既有配置先核对复用：

```bash
umask 077
export CSH_DEPLOY_DIR="$HOME/.config/cloudskill-hub-deploy"
mkdir -p "$CSH_DEPLOY_DIR"
chmod 700 "$CSH_DEPLOY_DIR"
export CSH_DEPLOY_CONFIG="$CSH_DEPLOY_DIR/wrangler.json"
# CSH_D1_ID、CLOUDFLARE_ACCOUNT_ID 必须来自刚才的真实资源和授权结果
```

以以下 Node 代码生成仓库外配置；文件已存在就检查并复用，不盲目改写。只填已经核实的值，不把示例当真实账号：

```js
import fs from 'node:fs/promises';
import path from 'node:path';
const dir=process.env.CSH_DEPLOY_DIR,db=process.env.CSH_D1_ID,account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!dir||!db||!account)throw Error('Missing verified deployment parameters');
if(!/^[a-f0-9-]{36}$/i.test(db)||!/^[a-f0-9]{32}$/i.test(account))throw Error('Invalid resource identifier');
const root=process.cwd(),config=JSON.parse(await fs.readFile('wrangler.jsonc','utf8'));
config.account_id=account;
config.main=path.join(root,'src/index.js');
config.assets.directory=path.join(root,'public');
config.d1_databases[0].database_id=db;
config.d1_databases[0].migrations_dir=path.join(root,'migrations');
// 如用户指定了不同名称，在核对后设置 name / database_name / bucket_name，不能覆盖其他业务。
await fs.writeFile(path.join(dir,'wrangler.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
console.log('Deployment config saved outside Git');
```

本项目配置当前是可解析的 JSON。若用户改成带注释 JSONC，使用正确 JSONC 解析或人工核对，不以正则删注释。仓库外 config 使用绝对路径，防止 public/migrations 相对位置错误。

## 5. 预构建与完整数据库

```bash
npx wrangler deploy --dry-run --config "$CSH_DEPLOY_CONFIG"
# 已有本项目数据时先备份 D1/R2，不能对未知业务数据库执行迁移。
npx wrangler d1 migrations apply DB --remote --config "$CSH_DEPLOY_CONFIG"
```

当前完整结构包含 0001_initial.sql、0002_binary_uploads.sql、0003_web_auth.sql，统一命令执行全部尚未应用文件；空库不可只运行最后一个。不要删、重命名、合并 SQL。已有 Token/Skill 数据通过加法迁移保留。

迁移后核对 web_admin 是否已有账号。已有账号时后续正常部署不重新初始化或重新设置引导 Secret；凭据缺失需要用户合法提供或经明确授权执行可信恢复。

## 6. 初始化 Secret 与部署

只有核实确实未初始化、没有并行部署者时才准备 BOOTSTRAP_SECRET。使用仓库外一次性文件，已存在则校验复用，不重复轮换：

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const dir=process.env.CSH_DEPLOY_DIR;
if(!dir||process.env.CSH_FIRST_INIT!=='true')throw Error('First initialization must be verified');
const file=path.join(dir,'bootstrap.json');
try{await fs.writeFile(file,JSON.stringify({BOOTSTRAP_SECRET:randomBytes(32).toString('hex')})+'\n',{flag:'wx',mode:0o600});}
catch(e){if(e.code!=='EEXIST')throw e;}
const saved=JSON.parse(await fs.readFile(file,'utf8'));
if(typeof saved.BOOTSTRAP_SECRET!=='string'||saved.BOOTSTRAP_SECRET.length<64)throw Error('Invalid saved bootstrap secret');
console.log('Bootstrap secret prepared in private file; value not printed');
```

CSH_FIRST_INIT=true 是已完成核对后的记录，不是绕过远端检查的开关。远端已有 Secret 但本地缺失时先确认，不自动覆盖。禁止 set -x、打印 JSON 或记录 HTTP 秘密 body。

先检查本地 `npx wrangler deploy --help`。支持 --secrets-file 时：

```bash
npx wrangler deploy --config "$CSH_DEPLOY_CONFIG" --secrets-file "$CSH_DEPLOY_DIR/bootstrap.json"
```

不支持该选项时：

```bash
npx wrangler deploy --config "$CSH_DEPLOY_CONFIG"
npx wrangler secret bulk "$CSH_DEPLOY_DIR/bootstrap.json" --config "$CSH_DEPLOY_CONFIG"
```

两种方式二选一。没有引导 Secret 的间隔，初始化不可用，不是开放注册。已有管理员的正常代码部署不携带引导文件，不加回已删除 Secret。

记录实际 Worker 名称、部署 ID、URL、commit，先匿名验证 /healthz 的应用与版本。自定义域名必须由用户指定并确认 DNS/Zone 归属；绑定 Worker，不公开 R2。没有可访问的正确 URL 时不能说部署完成。

## 7. 初始化网页登录账号与 A/B Token

将核实的实际 HTTPS 根域设置为 CSH_HUB_URL，再运行已测试的脚本：

```bash
node scripts/initialize-hub.mjs --url "$CSH_HUB_URL" --credentials-dir "$CSH_DEPLOY_DIR"
```

用户已有私有密码文件时，可加 `--username NAME --password-file /PRIVATE/account.json`，JSON 至少包含 password，也可包含 username。不要用 --password 明文参数。所有输入凭据文件必须在源码仓库外。

脚本执行：验证应用/version → 生成并先保存账号密码 → 使用初始化 Secret 创建单管理员 → 用 Cookie 登录 → 创建 personal → 签发 A 的 publisher / B 的 client → 验证范围 → 退出安装器会话。重跑复用保存的账号与 Token；丢失一次性 Token、密码已变更、权限不符时停止，不无限签发。

交付文件：

```text
CSH_DEPLOY_DIR/
  wrangler.json       实际部署配置（无密码/Token）
  web-admin.json      网站地址、用户名、随机或指定的密码
  publisher-a.json    A 的 personal 项目发布 Token，默认 90 天
  client-b.json       B 的 personal 项目只读 Token，默认 90 天
```

文件以 0600、目录以 0700 创建；Windows 仍需检查私有用户目录/ACL。文件不是加密保险库，同一系统用户可以读取。脚本只输出位置和用户名，不打印密码、Token 或 Cookie；不要把这些文件提交 Git 或复制到 Skill。

确认账号文件可读、网页登录和两个 Token 验证成功后，首次部署可删除引导 Secret：

```bash
npx wrangler secret delete BOOTSTRAP_SECRET --config "$CSH_DEPLOY_CONFIG"
npx wrangler secret list --config "$CSH_DEPLOY_CONFIG"
```

确认远端删除成功后再清理本地 bootstrap.json，保留三个交付凭据文件。已有管理员不得通过重新生成 bootstrap 接管；旧 Token-only 数据需要显式原管理员 --legacy-admin-file 转换，见 docs/AUTH.md。

## 8. 上线验收（使用隔离目录，不碰真实 Hermes）

先验证匿名 /api/catalog 为 401，错误登录为 401、跨源认证写为 403。验证网页会话 Cookie、退出后失效，publisher 不能访问 /api/tokens，也不能向未授权项目发布。

在独立临时目录建立测试客户端 HOME 与配置，并清除继承的 HERMES_HOME、CLAUDE_CONFIG_DIR、CODEX_HOME；必要时为 A/B 分别建立两个配置目录。不要在用户真实 ~/.hermes/skills 里跑验收。

从 publisher-a.json / client-b.json 在 **Node 进程内存** 读取 token，仅传入 CLI 子进程环境 CLOUDSKILL_TOKEN。命令行不出现 token，禁止输出整个配置。使用 `node cli/cloudskill.mjs ...` 即可，无需 sudo/npm link。

用不含秘密、独立命名的测试 Skill（例如 deployment-check-<随机后缀>），不要发布用户真实技能或覆盖已存在示例：

```text
A：publish personal <隔离的测试 Skill> --private
B：install personal/<测试名> --agents hermes
A：修改测试文本，再 publish
B：update，核对内容改变
B：再次 update，不应重复下载未变化 ZIP
B：本地编辑后 update，应拒绝覆盖
```

这些测试会在授权项目创建明确标记的测试版本。没有 Skill 删除 API，不能擅自直接删 D1/R2 来清理；记录创建的测试名，交付时说明。初次验收也可以采用用户指定测试项目，但须给 A/B 相应范围的 Token，不能静默扩大权限。

仅在真实 A/B 环境获授权并实际操作后，才称“真实设备接入完成”；实际模型加载是另一项验收。本地目录安装不能冒充 Hermes/Claude 已执行技能。

## 9. 真实 A/B 使用与交付

默认不要修改现有 AI 配置。用户指定目标后，A 登录使用 publisher Token，B 使用 client Token；同机多套 Hermes 同时隔离 HERMES_HOME 和 CLOUDSKILL_CONFIG_DIR。日常命令仍为 publish / install / update / subscribe / sync。

最终报告至少包含：实际 Hub URL、网页登录用户名、密码文件位置、A/B Token 文件位置及期限、Worker/D1/R2 标识、代码 commit、数据库迁移情况、线上/隔离/真实设备/模型加载分别做了什么、未完成项和阻塞。不要打印密码值或 Token，也不要说固定默认密码。

GitHub 自动部署仍关闭，除非用户另行授权。网页初始随机密码可以在登录后修改；修改会退出全部浏览器，但不自动让 A/B Token 失效。Token 到期或疑似泄露时在网页重新签发/撤销。

## 10. 忘记密码和故障

合法部署管理员有 D1 管理权限时：

```bash
npm run reset-password -- --remote --config "$CSH_DEPLOY_CONFIG"
# 需要同时撤销 API Token 时才加 --revoke-tokens
# 自动化使用仓库外 --password-file，不在参数里放明文密码
```

必须先核对目标并获得恢复授权。这不是普通发布设备的能力，也没有公网密码重置后门。脚本以密码版本条件更新，触发全部网页会话失效；默认不撤销 A/B Token。

HTTP 401：检查会话/密码/Token 是否正确、过期或已撤销；403：检查 CSRF、同源、publisher 范围、公开限制或重新验证；409：检查已有账号/并发版本，不重复初始化；429：尊重 Retry-After；500/503：检查迁移、bindings、密码原生 crypto 与 CPU 额度，不能关闭安全校验。

密码修改响应丢失时先尝试验证新凭据，不盲目恢复旧密码；初始化脚本在远端创建之前已经保存随机密码。已有业务数据先备份，失败时不要删资源或重建账号“回滚”。

参考：[SETUP](docs/SETUP.md) · [AUTH](docs/AUTH.md) · [USAGE](docs/USAGE.md) · [API](docs/API.md) · [测试边界](docs/TEST_RESULTS.md)。
