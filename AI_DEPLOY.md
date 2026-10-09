# AI 首次部署执行手册

适用于 Hermes、Claude Code、Codex 及具备终端/文件操作能力的 AI。**只部署当前 main 的完整应用，不需要安装中间版本。** 人工步骤见 [docs/SETUP.md](docs/SETUP.md)，日常 A 发布、B 手动更新见 [docs/USAGE.md](docs/USAGE.md)。

本文是执行手册，不是部署成功记录。只阅读本文件不会自动运行命令。用户明确说“部署这个项目”后，AI 应在有权限的环境中实际执行并验收；不能仅返回本文的摘要。当前任务仅是改文档/审查时，不执行任何云端写操作。

## 给部署 AI 的一段话

```text
请拉取 https://github.com/lanchenglin/cloudskill-hub.git 的 main，进入仓库，
先读取 AGENTS.md 和 AI_DEPLOY.md，然后执行当前版本的首次 Cloudflare 部署。
使用我已授权的 Cloudflare 登录或环境凭据；账号明确且权限齐备时直接完成正常步骤。
默认部署一个 Hub，使用 workers.dev 地址，创建 personal 私有使用项目，
初始化管理员并准备 B 的只读客户端令牌，全部凭据保存在仓库外私有目录。
按文档完成隔离的发布/安装/更新验收，最后报告地址、资源、凭据保存位置及实际测试结果。
不要启用 GitHub 自动部署，不要导入真实私密技能，不要改现有 Hermes 配置。
只有缺少凭据、目标不明确、需要额外付费开通或可能破坏现有数据时才向我确认。
```

## 1. 目标、权限和停止条件

目标顺序：**确认环境 → 验证 Cloudflare 授权 → 核对/创建本项目资源 → 配置 → 测试与预构建 → 初始化完整数据库 → 部署 → 初始化 Hub → 验收 → 交付**。

用户没有另行指定时采用下表；如果当前实例已使用其他名称，先核实并保留，不用默认值覆盖。

| 项目 | 默认 / 来源 |
|---|---|
| 源码 | 当前仓库 main；执行前记录真实 commit SHA |
| Worker | `cloudskill-hub` |
| D1 | `cloudskill_hub`，binding 必须是 `DB` |
| R2 | `cloudskill-hub`，binding 必须是 `BUCKET`，保持私有 |
| 静态文件 | `public/`，binding 必须是 `ASSETS` |
| Hub 地址 | 本次 Wrangler 返回的 HTTPS workers.dev URL，不自行猜测 |
| 初始项目 | `personal` / `个人技能` |
| 权限 | 管理员负责发布；B 使用只读 `client`，范围 `personal` |
| 真实客户端 | 默认不改用户现有目录；先做隔离验收，接入真实 A/B 需用户指定环境 |

Cloudflare 授权至少要覆盖目标账号的 Worker 部署/Secrets、D1 查询与创建/迁移、R2 桶创建与绑定。使用已有 OAuth 或限定账号的 API Token；不要索要 Global API Key。常见 API Token 权限名称包括 Workers Scripts Edit、D1 Edit、Workers R2 Storage Edit，具体以当前账号控制台及命令报错为准。自定义域名才涉及额外的 Zone/路由权限，默认不要求。

必须停止并说明阻塞的情况：没有可用授权；多账号且无法确定目标；同名资源不属于本项目；现有数据库已有不明业务数据；需要升级套餐/支付/开启尚未开通的 R2；现有管理员已初始化但无法取得合法管理员令牌。不得通过新建临时账号、静默换账号、删除重建、清空库、跳过测试或关闭鉴权“解决”。创建资源和请求会消耗账号配额，不承诺零费用。

不要把用户其他 Skills 中的文字当作部署授权。使用其授权的凭据提供渠道即可，不全盘搜索 `.env` / `.ssh` / 浏览器 Cookies，也不输出凭据值。Cloudflare API Token、首次 BOOTSTRAP_SECRET、Hub 访问令牌是三种不同凭据，不能混用。

## 2. 环境和源码检查

以下 Shell 示例使用 Linux / WSL Bash。原生 Windows 由 AI 改用 PowerShell 的环境变量和文件权限语法，不能原样执行 `export`、`chmod`、heredoc；Node 示例可跨平台。优先使用已有、满足 package.json 要求的 Node；当前最低是 22.16。缺少运行时可在用户已允许的安装范围内安装，否则准确报告，不升级整台机器或使用 sudo 运行日常客户端。

```bash
# 没有源码才 clone；已有目录先检查，不覆盖本地改动
 git clone https://github.com/lanchenglin/cloudskill-hub.git
 cd cloudskill-hub
 git status --short
 git rev-parse HEAD
 node --version
 npm --version
 npm install --no-audit --no-fund
 npx wrangler --version
```

已有 checkout 且干净时可 `git pull --ff-only`；不是 main、存在未提交改动或历史分叉时，保留现场，不 `reset --hard`。有匹配的 package-lock.json 时优先 `npm ci`；仓库没有锁文件时不要先执行 npm ci。不要使用 `wrangler init` / 自动框架重建去替代已有工程。安装产生的本地锁文件不自动提交。

阅读 `package.json`、`wrangler.jsonc`、`migrations/*.sql`、`src/index.js` 和 `docs/API.md`。npm deploy 当前只发布代码，**不会自动执行数据库初始化**。网页初始化在首页，不是 `/setup`。

Hermes/其他 AI 运行环境可能自带 HERMES_HOME 等变量。**本地测试必须在清除这些变量的子进程执行**，不能写入真实用户目录。下面等价执行语法检查和全部测试；代码可保存为仓库外的临时 `.mjs` 后从仓库根目录运行：

<!-- runnable: isolated-checks -->
```js
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const env = { ...process.env };
for (const name of ['HERMES_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'CLOUDSKILL_HOME', 'CLOUDSKILL_CONFIG_DIR', 'CLOUDSKILL_TOKEN',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ACCOUNT_ID']) delete env[name];
for (const args of [ ['scripts/check.mjs'], ['--test', ...readdirSync('test')
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`)] ]) {
  const r = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error('Local checks failed; stop deployment');
}
```

已有依赖且运行环境支持时，在同样隔离的子进程运行 `node scripts/worker-smoke.mjs`，它只使用本地 workerd/D1/R2。此结果不代表线上部署。不要为了测试启动已有真实 Hermes、调用模型或消耗用户的模型 API。

## 3. 识别已授权账号，只问真正缺失的参数

优先顺序：用户指定的本项目账号/部署记录 → 已授权环境变量 → `npx wrangler whoami` 的现有登录。不打印整个环境；检查 Token 时只输出“已设置/未设置”。

- 非交互部署通常使用进程环境 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。由宿主或秘密管理工具注入，不把真实值写在 AI 发出的命令参数里。
- 已有 OAuth 登录则使用该登录。只有一个明确可用账号时可读取其 ID；多个账号不能直接选第一个。
- 没有登录又没有 Token 时，`npx wrangler login` 可能需要用户在浏览器完成授权。报告授权这一个阻塞，不重复要求用户填写已经能读到的资源信息；不能伪造无头登录成功。
- 无浏览器可用时要求用户通过安全环境注入 Token，而不是公开聊天粘贴。

记录非敏感的账号 ID、Worker/D1/R2 目标名称和 Git SHA。**真正写云资源前先输出这些目标摘要**。目标已明确、用户已授权正常部署时不需要再逐条询问。

以下 `CSH_*` 都是本手册供部署进程使用的变量，**不是应用原生配置项**：

```bash
export CSH_WORKER_NAME=cloudskill-hub
export CSH_DB_NAME=cloudskill_hub
export CSH_BUCKET_NAME=cloudskill-hub
# CLOUDFLARE_ACCOUNT_ID 必须先由已核实的授权结果设置，不使用占位值
export CSH_DEPLOY_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/cloudskill-hub/deploy/$CLOUDFLARE_ACCOUNT_ID-$CSH_WORKER_NAME"
export CSH_DEPLOY_CONFIG="$CSH_DEPLOY_DIR/wrangler.json"
```

在仓库外创建这个本地目录，Unix 权限 `0700`、秘密文件 `0600`；Windows 使用仅本用户和必要系统主体可访问的 ACL。路径若是符号链接、位于 public/ 或公开同步目录、权限不可靠，则先停止修正。不要把秘密放进 `/tmp` 公共目录或源码树，普通 `.gitignore` 不是加密措施。

## 4. 核对资源，缺失才创建

先用本地 Wrangler 的 `--help` 确认参数。只读检查示例：

```bash
npx wrangler whoami
npx wrangler d1 list --json
npx wrangler r2 bucket list
npx wrangler deployments list --name "$CSH_WORKER_NAME"
```

读取失败不等于资源不存在。区别鉴权错误、权限不足、网络错误与确实不存在。**同名资源不能仅凭名称就认定是可复用的私人 Hub**：需要核对已有部署记录、绑定、创建记录、数据库表或用户的明确指定。

只有目标资源确实不存在时执行：

```bash
npx wrangler d1 create "$CSH_DB_NAME" --no-update-config
npx wrangler r2 bucket create "$CSH_BUCKET_NAME"
```

从成功返回值取真实 D1 UUID，保存在进程 `CSH_D1_ID` 和部署记录中。不要猜测、截错字段或把 Cloudflare account ID 当成 D1 ID。重试前重新查询，避免重复创建。若目标名被无关资源占用，只请求用户指定新名称，不改动原资源。

R2 必须是本项目专用私有桶。核对 `r2 bucket dev-url get` 与 `r2 bucket domain list` 的状态（参数以本地 --help 为准），不得启用 r2.dev 或桶的公开自定义域名。发现复用桶已公开时停止报告，不能悄悄影响其他服务，也不能当作私人桶交付。

### 生成不污染源码的本地部署配置

默认复制配置到仓库外，并使用显式 `--config`。**外部配置的路径要全部改为绝对路径**，否则 public、入口、migrations 会相对错误目录解析。下面代码用于当前没有注释的 JSONC；未来文件包含 JSONC 注释时改用可靠 JSONC 解析器，不使用正则删除注释。

<!-- runnable: deployment-config -->
```js
import fs from 'node:fs/promises';
import path from 'node:path';
const e = process.env, root = process.cwd();
if (!/^[a-f0-9]{32}$/i.test(e.CLOUDFLARE_ACCOUNT_ID || '') ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(e.CSH_D1_ID || ''))
  throw new Error('Use verified account ID and D1 UUID');
for (const k of ['CSH_DEPLOY_DIR','CSH_DEPLOY_CONFIG','CSH_WORKER_NAME','CSH_DB_NAME','CSH_BUCKET_NAME'])
  if (!e[k]) throw new Error(`Missing ${k}`);
const out = path.resolve(e.CSH_DEPLOY_CONFIG), dir = path.resolve(e.CSH_DEPLOY_DIR);
const rel = path.relative(root, dir);
if (!rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)))
  throw new Error('Deployment directory must be outside the source tree');
if (path.dirname(out) !== dir) throw new Error('Unexpected config destination');
const c = JSON.parse(await fs.readFile('wrangler.jsonc', 'utf8'));
c.account_id = e.CLOUDFLARE_ACCOUNT_ID;
c.name = e.CSH_WORKER_NAME;
c.main = path.resolve(root, c.main);
c.assets.directory = path.resolve(root, c.assets.directory);
Object.assign(c.d1_databases.find(x => x.binding === 'DB'), {
  database_name: e.CSH_DB_NAME, database_id: e.CSH_D1_ID,
  migrations_dir: path.resolve(root, 'migrations')
});
c.r2_buckets.find(x => x.binding === 'BUCKET').bucket_name = e.CSH_BUCKET_NAME;
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
await fs.writeFile(out, JSON.stringify(c, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created deployment config:', out);
```

已存在的部署配置不能直接覆盖：打开核对非敏感绑定并复用。此代码仅首次生成，文件已存在报错是保护措施。不要另设 `--env production` 而遗漏其独立绑定。保留当前上传 limits、nodejs_compat、ASSETS 的 run_worker_first 和清理 Cron。

后续所有 Wrangler 资源操作、迁移、部署和 Secrets 命令都必须指向同一个 `CSH_DEPLOY_CONFIG`；不要混用根目录占位配置。需要改现有配置时，先保留本地副本，只改已确认的字段，不把用户资源配置自动提交公开 Git。

## 5. 预构建和数据库完整初始化

```bash
npx wrangler deploy --config "$CSH_DEPLOY_CONFIG" --dry-run
npx wrangler d1 migrations list DB --remote --config "$CSH_DEPLOY_CONFIG"
```

首次新建空库可以执行以下命令；复用的已有本项目库先导出到私有目录，并核对迁移列表。发现不明业务表、异常部分迁移或多部署者同时操作时停止，不能 DROP、清空或重跑 ALTER 来强行修复。

```bash
# 已有本项目数据时先备份（生成文件也按私密数据保护）
npx wrangler d1 export DB --remote --config "$CSH_DEPLOY_CONFIG" --output "$CSH_DEPLOY_DIR/predeploy-$(date -u +%Y%m%dT%H%M%SZ).sql"
# 初始化：执行全部尚未应用 SQL，不是只挑 0002
npx wrangler d1 migrations apply DB --remote --config "$CSH_DEPLOY_CONFIG"
npx wrangler d1 migrations list DB --remote --config "$CSH_DEPLOY_CONFIG"
```

仅首次空库可省略导出。备份文件使用新的唯一名称，不覆盖之前的备份。保留 `0001_initial.sql` 与 `0002_binary_uploads.sql`，它们组成当前数据库结构，不是两个待安装版本。审核迁移内容后可在已授权的非交互环境接受正常迁移确认；不使用无差别 `yes | ...`。

核验实际表包含 projects、access_tokens、skills、skill_versions、devices、audit_log、upload_sessions；检查 skill_versions 的 artifact_format 等字段。随后只读查询管理员是否已初始化：

```bash
npx wrangler d1 execute DB --remote --config "$CSH_DEPLOY_CONFIG" --command "SELECT COUNT(*) AS admin_count FROM access_tokens WHERE role='admin';" --json
```

查询成功且 admin_count=0，才允许后续首次初始化。计数包含已撤销管理员，与当前代码的判断一致。已存在管理员时使用原令牌验证，不重置 Token、不再生成 bootstrap，不能删除管理员行让引导重新开放。一个实例只运行一个初始化流程。

## 6. 设置 Secret 并部署

仅在确定未初始化、没有并行部署者时，为本项目生成至少 32 字节的随机 BOOTSTRAP_SECRET。复跑使用已有本地值，不重复轮换；远端已有 Secret 但本地值缺失时先核实，不自动覆盖。

<!-- runnable: bootstrap-secret -->
```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const dir = process.env.CSH_DEPLOY_DIR;
if (!dir || process.env.CSH_FIRST_INIT !== 'true') throw new Error('First initialization has not been verified');
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, 'bootstrap.json');
try {
  await fs.writeFile(file, JSON.stringify({ BOOTSTRAP_SECRET: randomBytes(32).toString('hex') }),
    { flag: 'wx', mode: 0o600 });
} catch (error) { if (error.code !== 'EEXIST') throw error; }
const saved = JSON.parse(await fs.readFile(file, 'utf8'));
if (typeof saved.BOOTSTRAP_SECRET !== 'string' || saved.BOOTSTRAP_SECRET.length < 64)
  throw new Error('Invalid saved bootstrap secret; do not overwrite blindly');
console.log('Bootstrap secret available in protected file; value not printed');
```

`CSH_FIRST_INIT=true` 只由 AI 在第 5 节核验后设置，它不是绕过远端检查的开关。不要打印 bootstrap.json，也不要开启 shell tracing / debug HTTP body 日志。

**路径 A：本地 `wrangler deploy --help` 包含 `--secrets-file` 时，优先把 Secret 随代码一起部署：**

```bash
npx wrangler deploy --config "$CSH_DEPLOY_CONFIG" --secrets-file "$CSH_DEPLOY_DIR/bootstrap.json"
```

**路径 B：安装的 Wrangler 没有该选项时：**先正常部署不含 bootstrap 的应用，再通过 secret bulk 设置。这个间隔内初始化接口会返回 503，不是无保护的管理员注册。

```bash
npx wrangler deploy --config "$CSH_DEPLOY_CONFIG"
npx wrangler secret bulk "$CSH_DEPLOY_DIR/bootstrap.json" --config "$CSH_DEPLOY_CONFIG"
```

A/B 二选一，不重复执行。已有初始化完成实例的正常部署不携带 bootstrap 文件，保留其 Secrets；不要重新加回已清理的引导 Secret。不要将秘密改为普通 vars、提交 .dev.vars 或把秘密直接写进命令行。

记录实际发布的 Worker 名称、版本 ID、URL 和部署 commit。以命令成功返回为准；在 URL 可访问前不能写“部署完成”。403/认证失败优先修复授权；不要盲目新增 S3 密钥。本项目使用 R2 binding，不需要 R2 S3 Access Key。

没有提供域名时使用本次账号的实际 workers.dev 地址；若账号尚未配置该子域，需要用户完成该账号配置。用户明确指定自定义域名后，核对 Zone 和现有 DNS 冲突，再以该 Worker 的 Custom Domain 绑定，**不是给 R2 桶绑定域名**；不能删除或覆盖已有业务 DNS。不要用临时/claim 账号替代用户账号部署。

## 7. 不依赖浏览器的 Hub 初始化

将从本次部署读取并核对的 HTTPS 根地址设置为 `CSH_HUB_URL`；不要含路径、用户名、密码、查询参数。先匿名 GET `/healthz` 验证 app 为 cloudskill-hub，version 对应 checkout 的 package.json，再发送任何秘密。所有 fetch 设置超时、`redirect: 'error'`，不把凭据发送给跳转目标。

下面可作为仓库外临时 `.mjs` 在部署环境执行。**仅使用本项目已经授权的接口，不修改数据库来签发令牌。** 首次创建 Owner、personal 项目和 B 的只读令牌；重跑尽量复用已保存记录，无法恢复的一次性响应必须报告，不能刷出一串新令牌。

<!-- runnable: initialize-hub -->
```js
import fs from 'node:fs/promises';
import path from 'node:path';
const dir = process.env.CSH_DEPLOY_DIR, rawUrl = process.env.CSH_HUB_URL;
if (!dir || !rawUrl) throw new Error('Missing deployment directory or actual Hub URL');
const u = new URL(rawUrl);
if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
  throw new Error('Hub must be a verified HTTPS origin');
const url = u.origin, ownerPath = path.join(dir, 'owner.json'), clientPath = path.join(dir, 'client-b.json');
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const lockPath = path.join(dir, 'initialize.lock');
const lock = await fs.open(lockPath, 'wx', 0o600); // Existing/stale lock requires inspection, not automatic deletion.
async function api(route, method = 'GET', body, token) {
  const res = await fetch(url + route, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Hub ${route}: HTTP ${res.status}; inspect state before retry`); }
  return res.json();
}
async function read(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function save(file, obj) {
  const h = await fs.open(file, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(obj) + '\n'); await h.sync(); } finally { await h.close(); }
}
function valid(c, role) {
  if (!c || c.url !== url || c.role !== role || !/^csh_[a-f0-9]{48}$/.test(c.token || ''))
    throw new Error('Invalid saved identity; never overwrite or print it');
}
try {
  const expected = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
  const health = await api('/healthz');
  if (health.app !== 'cloudskill-hub' || health.version !== expected) throw new Error('Unexpected deployed application/version');
  let owner = await read(ownerPath);
  if (!owner) {
    if (process.env.CSH_FIRST_INIT !== 'true') throw new Error('Need original admin credential for an initialized Hub');
    const bootstrap = await read(path.join(dir, 'bootstrap.json'));
    if (typeof bootstrap?.BOOTSTRAP_SECRET !== 'string') throw new Error('Missing local bootstrap secret');
    const created = await api('/api/bootstrap', 'POST', { secret: bootstrap.BOOTSTRAP_SECRET, label: 'Owner' });
    owner = { url, token: created.token, role: created.role };
    valid(owner, 'admin');
    await save(ownerPath, owner); // Persist the one-time token immediately, before any next request.
  }
  valid(owner, 'admin');
  if ((await api('/api/me', 'GET', undefined, owner.token)).role !== 'admin') throw new Error('Admin validation failed');
  const projects = await api('/api/projects', 'GET', undefined, owner.token);
  if (!projects.projects.some(p => p.slug === 'personal'))
    await api('/api/projects', 'POST', { slug: 'personal', title: '个人技能' }, owner.token);
  let client = await read(clientPath);
  if (!client) {
    const label = 'client-b-initial';
    const known = await api('/api/tokens', 'GET', undefined, owner.token);
    if (known.tokens.some(t => t.label === label && !t.revoked_at))
      throw new Error('A matching client token already exists but its local value is missing; recover or explicitly replace it');
    const created = await api('/api/tokens', 'POST', { label, role: 'client', projects: ['personal'] }, owner.token);
    client = { url, ...created };
    valid(client, 'client');
    await save(clientPath, client);
  }
  valid(client, 'client');
  const me = await api('/api/me', 'GET', undefined, client.token);
  if (me.role !== 'client' || me.projects.length !== 1 || me.projects[0] !== 'personal')
    throw new Error('Client must be read-only and limited to personal');
  console.log('Hub initialization verified:', url);
  console.log('Admin credential file:', ownerPath);
  console.log('B read-only credential file:', clientPath);
} finally {
  await lock.close();
  await fs.unlink(lockPath);
}
```

秘密只进入进程内存和上述受保护文件，不输出完整 HTTP 响应或 Token。如果 bootstrap 请求已提交但响应丢失/写文件失败，先查询管理员计数；已初始化却丢失 Token 时停止并报告恢复需求，不能重复引导、清库或继续把配置标成成功。文件写入失败时不要删除云端资源“回滚”。

已初始化且凭据缺失时由用户通过受信任渠道提供原令牌并保存为绑定 URL 的 owner.json；不要自行在 D1 插入新管理员。应用保存的是令牌哈希，不能从 D1 读回明文。

重新从 owner.json 读取并调用 `/api/me` 验证成功、确认凭据已可靠保存后，首次部署可以执行：

```bash
npx wrangler secret delete BOOTSTRAP_SECRET --config "$CSH_DEPLOY_CONFIG"
npx wrangler secret list --config "$CSH_DEPLOY_CONFIG"
```

列表只确认 Secret 名称已移除，不显示值。确保删除操作成功，再删除本地 bootstrap.json；**保留 owner.json 和 client-b.json**。不要在成功保存管理员令牌之前清理引导材料。

## 8. 必须做的线上与隔离客户端验收

不能只看 `/healthz`：该接口成功不证明 D1/R2、权限或上传可用。依次完成下表；失败记录准确 HTTP 状态/脱敏错误，先定位，不禁用安全机制。

| 验收 | 成功条件 |
|---|---|
| 网页 | GET `/` 返回管理页，JS/CSS 可访问，无必需资源 404 |
| 身份 | 无令牌 GET `/api/catalog` 返回 401；管理员 `/api/me` 成功 |
| 配置 | 已认证 `/api/capabilities` 与预期 limits 一致，uploadProtocol=2 |
| 权限 | B 可读 personal；B 创建发布会话、管理令牌或读取管理员页面 API 被 403 拒绝 |
| R2/发布 | 不含秘密的测试 Skill 经过 ZIP 会话上传并 finalize 成功 |
| 默认私有 | 测试 Skill 不在两个 well-known 公开索引中；其匿名文件地址不可访问 |
| 安装 | 只读测试身份下载并校验、写入隔离 Hermes 目录；可在隔离 Claude/Codex 目录检查文件 |
| 手动更新 | A 发布变更后 B 文件暂不变；B 执行 update 后才变化 |
| 内容保护 | B 本地也编辑过时，不带 --force 的更新拒绝覆盖；原内容仍在 |

隔离测试不要用现有 ~/.hermes、~/.claude、~/.codex，也不要沿用 AI 宿主的 HERMES_HOME。AI 在 `CSH_DEPLOY_DIR/acceptance/<run-id>/` 中创建 A/B 两套环境，并为**每个子进程**设置全部路径：

```text
CLOUDSKILL_HOME        = <该测试环境>/home
CLOUDSKILL_CONFIG_DIR  = <该测试环境>/cloudskill
HERMES_HOME           = <该测试环境>/hermes
CLAUDE_CONFIG_DIR     = <该测试环境>/claude
CODEX_HOME            = <该测试环境>/codex
```

A/B 使用不同目录。调用 `node <仓库绝对路径>/cli/cloudskill.mjs ...`，不必 npm link，也不改全局 PATH。用 Node 的 spawn 传 `env`，从受保护文件读取 Token 到子进程 `CLOUDSKILL_TOKEN` 用于 login；命令参数不带 Token，其他操作读取测试配置即可。

测试流程：从示例复制一份到隔离 A 源目录，使用随机后缀名字如 `csh-deploy-check-<hex>`，同步更改 SKILL.md 中的 name。A 用管理员身份 `publish personal <目录> --private`；B 用只读身份 `install personal/<name> --agents hermes`。记录 B 文本和校验值，A 追加标记再 publish，确认 B 未变化，然后 B `update`，验证文本与校验值更新。最后在 B 追加本地标记，再安排 A 发布一个新修改，确认 B 正常 update 被保护，不丢失本地标记。测试代码可以用现有 cli/manager.mjs、cli/transfer.mjs 导出方法，但必须报告是方法测试还是实际 CLI 子进程测试。

测试会在 Hub 中留下一个小型私有测试 Skill 和历史版本，应在交付记录中列出。**当前没有通用删除技能 API，不要为了清理测试发明 DELETE 接口或直接删 D1/R2 内容。** 本地测试目录也先列明再按用户策略处理，不触及真实技能。

没有实际 A/B 主机访问权限时，报告“线上接口 + 本机隔离双环境验收通过，真实 A/B 接入待执行”。没有进入模型会话发现和使用技能，就不能声称 Hermes/Claude 模型执行通过。浏览器工具不可用时仍可做接口与文件验收，但明确网页交互尚未验证。

## 9. 真实 A/B 接入与交付

默认仅部署 Hub，不替用户登录或修改已有 AI 环境。用户同时指定真实 A/B 目录或远程主机并授权时，按 [USAGE.md](docs/USAGE.md) 接入：A 使用有发布权限的管理员身份，B 用自己的只读身份。多套 Hermes 分别设置 HERMES_HOME 与 CLOUDSKILL_CONFIG_DIR，不能共用同一安装清单。

给用户提供实际域名下的命令，不保留 example.com：

```bash
cloudskill login https://YOUR-ACTUAL-HUB
# A：之后每次修改完执行
cloudskill publish personal /actual/path/to/my-skill --private
# B：首次安装，然后按需更新
cloudskill install personal/my-skill --agents hermes
cloudskill update
# 需要接收 personal 新增技能时，设置一次订阅，再按需 sync
cloudskill subscribe personal --agents hermes --skills '*'
cloudskill sync
```

不要把 owner.json/client-b.json 文本复制到公开聊天或 Git；交付其私有绝对路径，让用户在受信任渠道查看/转移。本地保存是受权限保护的明文，不称为加密保险库。远程主机的路径不等于用户电脑上的文件；必须说明文件在哪台机器。更多 B 实例分别签发只读令牌，不默认共享管理员令牌。

当前项目支持的是技能文件传输，不自动导出 Hermes 配置，也没有独立凭据保险库；`.env` 等隐藏文件会被拒绝。安装路径、实际客户端兼容边界照 USAGE.md 说明，不因为部署文档而承诺尚未适配的 AI 工具。

## 10. 重跑、故障处理与真实完成标准

在私有部署目录保存不含 Token 的 `deployment-state.json`，至少记录：账号/资源 ID、哪些资源本次新建、配置路径、commit、迁移结果、实际 URL、初始化进度、凭据文件路径和测试状态。每次远程写成功后更新；重跑时结合远端查询确认，不盲信旧本地状态。不保存 Secrets 内容在此状态文件或报告中。

| 情况 | 处理 |
|---|---|
| 无法登录/10000/403 | 检查账号和对应操作权限；不给 Token 加全账户通配权限作为默认方案 |
| 网络失败/命令超时 | 先查询远端是否已成功；有界重试，不循环创建资源/令牌 |
| 迁移失败 | 保留库与日志；检查实际 schema 和迁移记录，不 DROP 或手动跳过记录 |
| bootstrap 409 | 已初始化；寻找本项目原凭据，不能再次注册管理员 |
| bootstrap 503 | 核对 Secret 是否配置，或是否已在成功初始化后删除；不关闭检查 |
| upload 409/429 | 查看会话与云端版本；按已有 API 规则重试，不提高配额来隐藏错误 |
| 客户端本地修改/未知同名目录 | 停止覆盖，提供具体目录；不自动 --force |
| 域名不可达 | 区分 DNS/TLS/访问控制与 Worker；不把本地 localhost 当上线地址 |
| 只完成 dry-run / CI | 只能报告构建/测试通过，不报告已部署 |

默认不自动配置 GitHub Secrets、不启用 ENABLE_CLOUDFLARE_DEPLOY、不加计划任务、不改私有技能公开性、不修改账号套餐。外部部署配置与根目录示例不同，因此开启 GitHub 自动部署前还必须单独配置 CI 的真实资源绑定；不能以为本次本地部署已替 CI 做好配置。

最终报告用下面结构，填真实值，没有执行的明确写“未执行”：

```text
结果：部署并初始化成功 / 已上线但初始化受阻 / 未部署（原因）
代码：分支、commit、package 版本；Node / Wrangler 实际版本
访问地址：实际 HTTPS URL
资源：账号、Worker、D1、R2；新建还是复用
数据库：已应用全部 SQL / 未完成及原因
私有检查：API 鉴权、B 权限、测试 Skill 匿名不可读
初始化：personal、管理员、B 只读身份的实际状态
凭据保存：主机 + 仓库外文件路径（不写令牌）
验收：本地测试 / 线上接口 / 隔离 A-B / 网页 / 真实机器 / 模型执行分别列出
遗留：私有测试 Skill 名称、未执行项、用户下一步
自动部署开关：保持原状态，本次未主动启用
```

## 技术参考

命令参数可能随工具更新，先看本地 --help。下面是官方依据，不替代实际项目源码：

- [Cloudflare Wrangler Worker 命令与 Secrets](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [D1 Wrangler 命令](https://developers.cloudflare.com/d1/wrangler-commands/)
- [R2 Wrangler 命令](https://developers.cloudflare.com/r2/reference/wrangler-commands/)
- [Cloudflare 外部 CI 的环境授权](https://developers.cloudflare.com/workers/ci-cd/external-cicd/)
- [Codex AGENTS.md 入口](https://developers.openai.com/codex/guides/agents-md/)
- [Claude Code 项目说明入口](https://code.claude.com/docs/en/memory)
- [Hermes 项目上下文文件](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)

仓库根目录 AGENTS.md / CLAUDE.md 用于让相应工具发现这份说明。工具的加载策略由其版本与工作目录决定；显式让 AI 读取本文件最可靠，不能宣称只 clone 仓库就会自动产生部署授权或执行部署。
