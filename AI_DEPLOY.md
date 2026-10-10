# AI 首次部署执行手册

适用于有终端/文件/网络能力的 Hermes、Claude Code、Codex。先读 AGENTS.md。**只部署当前 main 的完整应用，不安装中间版本。** 本文件不是部署成功记录，单独读取本文件也不是云端写入授权。

用户明确要求部署且已有合法账号授权时，实际执行检查、部署、初始化和验收，不只返回建议。本轮若只是改代码/文档/审查，不操作真实 Cloudflare。

## 给部署 AI 的任务

```text
拉取 lanchenglin/cloudskill-hub 的 main，读取 AGENTS.md 和 AI_DEPLOY.md，
使用我已经授权的 Cloudflare 账号首次部署一个私人 Hub。
网页登录用账号密码；共享内容匿名可拉取，修改 Token 由我自己在网页签发。
默认账号 admin、初始密码 lanchenglin；初始化后提示我首次登录必须改密，不替我改成随机密码或跳过门禁。
首次改密只填写当前密码、新密码和确认新密码，不要求初始化 Secret。不要自动签发任何 Token。
完成隔离验收，报告实际地址、账号名、凭据文件位置、资源和测试结果。
不要改现有 Hermes 配置，不上传真实私人技能，不开 GitHub 自动部署。
缺授权、账号目标不明、同名业务资源或需付费开通时说明阻塞，不清库、不换临时账号。
```

## 1. 目标和边界

本项目当前是个人自用。暂不增加性能扩展、并发队列或容量治理功能；保留正常功能检查和已有安全约束，不因此改动哈希强度或购买套餐。Token 可明确选择永久，按下面参数执行即可。

默认一个 Worker `cloudskill-hub`、D1 `cloudskill_hub`、私有 R2 `cloudskill-hub`；binding 保持 `DB` / `BUCKET` / `ASSETS`。没有域名时用本次 Wrangler 返回的 workers.dev HTTPS 地址，不猜子域名。初始项目 personal / 个人技能。

网页账号初次可自定义，AI 脚本默认 admin / lanchenglin。所有新账号第一次登录必须改密，正式新密码为 6–20 字符；固定初始值不能当长期密码。不要再使用旧的 `/api/bootstrap` 或 owner.json 管理员 Token 模式。仅保存 web-admin.json；修改共享/修改全部 Token 由本人在网页选择签发。

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

当前完整结构包含 0001_initial.sql、0002_binary_uploads.sql、0003_web_auth.sql、0004_require_password_change.sql、0005_sharing_permissions.sql，统一命令执行全部尚未应用文件；空库不可只运行最后一个。不要删、重命名、合并 SQL。已有 Token/Skill 数据通过加法迁移保留。

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

## 7. 初始化账号，不自动签发 Token

核实本次真实 HTTPS 地址，设置 CSH_HUB_URL 后执行：

```bash
node scripts/initialize-hub.mjs --url "$CSH_HUB_URL" --credentials-dir "$CSH_DEPLOY_DIR"
```

脚本首次创建 admin / lanchenglin，先保存 web-admin.json，再验证受限登录、退出会话；返回 password_change_required，退出码 2。含义是“程序已部署，等待用户本人首次改密”，不是部署失败。不得重新初始化、清库、替用户改随机密码或绕过门禁。

首次改密只输入当前密码、新密码、确认新密码；不要求额外 Secret 或 bootstrap.json。引导 Secret 仅首次创建账号时使用，确认账号已创建并验证受限登录后可按第 6 节配置清理，不需要为改密保留。

**不创建 Token，不安排 A 发布/B 读取，不生成 publisher-a.json 或 client-b.json。** 共享内容任何人都能拉取；需要写入的人由管理员在网页签发“修改共享技能”或“修改全部技能”，自己选择备注和永久/定期。旧 --token-days 选项已不适用，不得自行改调用去签发。

用户改密后可自行在网页创建 personal 分类，也可在用户明确授权继续时，将新密码从仓库外安全文件提供给脚本：

```bash
node scripts/initialize-hub.mjs --url "$CSH_HUB_URL" --credentials-dir "$CSH_DEPLOY_DIR" --password-file /PRIVATE/new-password.json
```

第二阶段只验证账号并确保 personal 存在，不签发/撤销/续期任何 Token。旧保存的客户端凭据文件不擅自删除。错误新密码不覆盖有效本地账号。

交付位置只应包括实际存在的文件：

```text
CSH_DEPLOY_DIR/
  wrangler.json       实际账号的部署绑定，无密码/Token
  web-admin.json      初始账号，或第二阶段验证成功的新账号
  bootstrap.json      仅首次创建使用，核实后可清理
```

目录0700、文件0600；Windows 检查 ACL。只告知位置和用户名，不打印真实新密码、Secret、Token 或 Cookie。默认密码是公开值，交付时提醒立即改密；不要把待改密实例称为已安全投入使用。

## 8. 线上验收：只做已获授权的操作

改密前只检查健康、初始化状态和受限会话；不能拿临时密码绕过用户的首次登录步骤。共享页 /shared.html 与 GET /api/public/catalog 可匿名读取，不应返回任何私人内容。受保护 /api/catalog 仍需身份。

改密后无需创建 Token 即可用隔离目录验证公开拉取：

```text
cloudskill connect <真实 Hub URL>
cloudskill list
cloudskill install <已有共享项目>/<已有测试技能> --agents hermes
cloudskill update
```

没有共享技能时目录为空是正确结果，不自行上传用户真实技能或公开私有技能。读写验收需要用户自行签发并通过安全渠道明确提供 Token 后才能执行；禁止为完成测试自行签发。

获得合法测试 Token 后，隔离 HERMES_HOME、CLOUDSKILL_HOME、CLOUDSKILL_CONFIG_DIR 等目录，使用不含凭据的独立测试技能。共享修改 Token 验证共享发布/修改、拒绝私有读取；全部修改 Token 验证私有发布/读取，但管理 /api/tokens 等接口仍拒绝。实际创建的测试名称要记录，没有删除接口就不要直接删库/桶“清理”。

需验证永久 Token 时，由用户网页选择永久；撤销操作也须明确授权，不撤销日常使用凭据。不得把目录文件测试当成 Hermes/Claude 模型已加载执行，不做本任务未要求的性能扩展。

## 9. 交付

报告实际 Hub URL、共享页面 URL、网页登录用户名、web-admin.json 位置、资源标识、commit、全部迁移执行情况、当前待改密/已改密状态，以及分别完成的接口/隔离CLI/真实设备/模型验证。

**明确说明：没有自动生成 Token，用户在网页自行选择两种修改权限及永久/定期。** 无 Token 时能拉取共享；私有内容需要全部修改 Token。不要再交付不存在的 A/B Token 文件。

现有 Hermes 目录和模型配置不动；GitHub 自动部署仍关闭；不清理或改变任何旧 Token。账户和权限使用见 docs/AUTH.md。

## 10. 忘记密码和故障

合法部署管理员有 D1 管理权限时：

```bash
npm run reset-password -- --remote --config "$CSH_DEPLOY_CONFIG"
# 需要同时撤销 API Token 时才加 --revoke-tokens
# 自动化使用仓库外 --password-file，不在参数里放明文密码
```

必须先核对目标并获得恢复授权。这不是普通发布设备的能力，也没有公网密码重置后门。脚本以密码版本条件更新，触发全部网页会话失效；默认不撤销已有 Token。

HTTP 401：检查会话/密码/Token 是否正确、过期或已撤销；403：先识别 password_change_required（必须改密），再检查 CSRF、同源、共享/全部修改范围或重新验证；409：检查已有账号/并发版本，不重复初始化；429：尊重 Retry-After；500/503：检查迁移、bindings、密码原生 crypto 与 CPU 额度，不能关闭安全校验。

密码修改响应丢失时先尝试验证新凭据，不盲目恢复旧密码；初始化脚本在远端创建之前已保存初始账号；本地默认密码过期时只接受用户合法提供的新密码，不自动回退或重置。已有业务数据先备份，失败时不要删资源或重建账号“回滚”。

参考：[SETUP](docs/SETUP.md) · [AUTH](docs/AUTH.md) · [USAGE](docs/USAGE.md) · [API](docs/API.md) · [测试边界](docs/TEST_RESULTS.md)。
