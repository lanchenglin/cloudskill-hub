# 账号、会话与客户端授权

当前版本采用 **单管理员账号密码 + 共享/全部修改两种 API Token**。这不是多用户系统，也没有实现 MFA / Passkey / 独立密钥保险库。

## 账号初始化

首次初始化仍需要足够随机的 BOOTSTRAP_SECRET。默认用户名 `admin`，默认初始密码 `lanchenglin`；用户名可自定义并规范化为小写，3–64 个 ASCII 字母、数字、点、下划线或中划线。正式新密码必须 6–20 个字符，支持空格、中文和 Unicode，不截断、不去除首尾空白。已部署账号不因升级或重跑初始化变成默认密码。

所有新建账号都带 `must_change_password=1`，包括指定强初始密码的账号。登录及 `/api/auth/session` 返回 `mustChangePassword`。值为 true 时，所有需要鉴权的业务 API（包含读接口、文件下载、设备、上传、Token、旧管理员 Bearer）均返回 403 `password_change_required`，仅允许读取自己的登录状态、修改密码及退出。匿名健康检查、登录状态和本来就公开的内容不是私人数据。

前端显示独立的强制改密页，不加载后台数据，不提供关闭/跳过按钮。后端检查数据库状态，伪造页面、请求标记、Cookie 刷新或重新验证都无法绕过。修改成功以同一 UPDATE 清除强制标记并递增密码版本，触发器撤销全部旧网页会话；必须用新密码重新登录。

**首次改密不做额外所有权验证。** 请求只需要已登录的 Cookie 会话、有效 CSRF、当前密码和符合要求的新密码；网页要求再次确认新密码，不要求 `BOOTSTRAP_SECRET`、原管理员 Token 或引导文件。初始化 Secret 只校验首次创建账号，原管理员 Token 只校验已有实例的账号转换。

新账号不再保存初始化证明摘要。历史迁移中的 `activation_secret_hash` 列保留，避免修改已应用迁移；即使旧账号处于待改密状态且留有摘要，当前代码也不以此拦截改密，成功改密时会清空旧值。接口兼容字段 `activationSecretRequired` 恒为 false，没有对应的启用开关。本次没有新增数据库迁移。

安全边界：公开默认密码不提供部署者身份保证；知道地址和默认凭据的人可能抢先改密。首次部署后应立即完成改密，不要长期暴露未改密的实例。强制改密限制仍由后端执行，但不是防止默认账号被抢先使用的替代措施。

初始化、自定义初始密码、首次改密、日常改密和可信恢复统一要求 **6–20 个 Unicode 码点**（含首尾空格，不按字节数计）。没有大小写/数字/特殊字符混用的强制规则，不截断、不 trim；默认密码 lanchenglin 也在这个范围内，但正式新密码/恢复不能设置回公开的初始值。网页与服务端共享同一校验器。

已有账号不会被重置或截断。登录、当前密码验证和初始化脚本读取既有凭据保留此前 128 字符的兼容范围；下一次设置新密码时才执行 6–20 规则。HTML 的输入容量为最多 40 个 UTF-16 单元以容纳 20 个 emoji，实际合法长度由共享的码点校验器限制为 6–20。

初始化脚本首次只写仓库外 `web-admin.json` 并报告待改密（退出码 2），不会创建项目/Token，也不会偷偷更改默认密码。用户网页改密后，用新密码文件只继续验证账号和分类；不生成任何 Token。只有验证新密码成功才替换本地账号记录。

初始化事务使用单例主键，只能创建一个管理员。旧 `/api/bootstrap` 的 Token-only 初始化已关闭并返回 410，不能不设密码继续签发全站 Token。

## 密码存储与运行成本

使用 Node 原生 scrypt：N=16384、r=8、p=5、随机 16 字节盐、32 字节派生结果；每次不同盐。D1 仅保存带参数标识的密码哈希。此配置选用 OWASP 列出的约 16 MiB 内存档位，不把高熵 Token 的 SHA-256 保存方式套用到密码。单 isolate 最多同时运行两个 KDF，忙时返回错误，不无限排队。

Workers 的当前 Node crypto 提供原生 scrypt；原生本地 workerd 有端到端测试。强密码哈希仍有 CPU 成本，生产建议评估 Workers Paid，不承诺免费套餐可用；配额不足不得退化为普通 SHA-256、低工作量哈希或免认证。

## 浏览器会话

- 32 字节随机不透明会话值，仅以 `__Host-csh_session` Cookie 发给浏览器，D1 保存其哈希。Cookie 包含 HttpOnly、Secure、SameSite=Strict、Path=/，不设置 Domain。
- 只有 HTTP loopback 开发环境使用非 Secure 的 `csh_dev_session`；远端认证要求 HTTPS。
- 默认 12 小时绝对有效期、30 分钟空闲期限，last_seen 写入最多每分钟一次；最多保留 10 个登录会话。
- 登录创建新会话；同一浏览器重新登录时废止旧 Cookie 对应会话。退出撤销当前会话，修改密码撤销全部网页会话。
- Session 中同时记录密码版本。数据库密码变更触发器也会删除会话，可信命令重置密码同样生效。
- 网页不保存长期管理员 API Token 到 localStorage/sessionStorage。旧 csh-token 浏览器存储在页面加载时清理。新签发设备 Token 只在当次响应/界面展示，后续列表不返回明文。

Cookie 鉴权的写操作必须带有效 X-CSRF-Token；还要求 X-CloudSkill-Request: 1，并拒绝不同 Origin / cross-site 请求。登录、初始化也要求自定义头和来源校验，避免登录 CSRF。API 不开放跨站 CORS。请求带 Authorization 时优先核验它，失效 Bearer 不会回退借用浏览器管理员 Cookie。

签发/撤销 Token 需要最近 5 分钟内验证过密码；超过时网页弹出隐藏密码确认。修改密码总是要求当前密码。

## 限速和审计

D1 保存跨 isolate 共享的登录计数，而非只在某个进程内计数。默认每 IP 10 次 / 10 分钟，全站 50 次 / 10 分钟；初始化、重新验证和改密采用更低独立额度。成功登录也计入这个窗口，超限返回 429 和 Retry-After。只信任 Cloudflare 提供的 CF-Connecting-IP，不使用 X-Forwarded-For；本地没有该头时使用统一本地桶。

限速表只保存 IP 摘要，过期计数/会话随已有 Cron 有界清理；不记录密码、Cookie、CSRF 值或 Token 明文。失败登录采用相同错误信息，未知用户名仍做密码验证。登录、改密、恢复和令牌管理写入审计。

这些是应用保护，不是完整 DDoS 防护；应另在 Cloudflare 为认证路径设置 WAF / 速率规则。大量分布式请求可能暂时耗尽全站限额，部署者需评估可用性。

## API Token（只有两种新签发类型）

共享技能公开可读，无需 Token。网页管理员手动签发；项目是分类，不是新 Token 的授权范围；不绑定 A/B/C 或某个设备。

| 身份 | 共享读取 | 共享修改 | 私有读取/修改 | 管理账号/分类/Token |
|---|---|---|---|---|
| guest（无 Token） | 是 | 否 | 否 | 否 |
| shared_writer | 是 | 是 | 否 | 否 |
| all_writer | 是 | 是 | 是 | 否 |
| web 管理员 | 是 | 是 | 是 | 是 |

修改包括现有上传、编辑和回滚；未实现技能删除。共享修改 Token 不能切换可见性或改写已私有的同名技能。全部修改 Token 能读取敏感私有内容，只交给可信环境；但不是网站管理员 Token。

新 Token 默认 90 天，显式 `expiresInDays:null` 代表永久；1–365 的整数代表定期。数据库保存过期日期或 null，不伪造很远的日期。过期/撤销检查、密码近期验证、CSRF 与首次改密门禁均保留。永久不意味着无法撤销或浏览器永久登录。

服务端保留 Token 认证摘要，同时对新签发值保存 AES-256-GCM 加密副本，用于管理员再次查看。加密密钥不放在 D1，使用独立 Worker Secret TOKEN_ENCRYPTION_KEY。旧的哈希记录不会被倒推、重置或自动补发。迁移 0005 增加 permission_mode=shared/all；旧记录为 legacy，原角色和项目范围不变。不再通过新签发 API 创建 client/publisher/admin。新类型不接受非空 projects，避免旧调用误以为有项目限制。

匿名读取使用 /api/public/* 的明确 GET 白名单及 well-known 索引，不能读取管理接口。受保护 /api/* 的无效 Bearer 不会回退为 Cookie 或匿名身份。共享 Token 读取历史版本还需要该版本发布时为 public；所有读/下载/文件/回滚路径均检查当前技能可见性。上传会话在继续上传和 finalize 时再次检查，不能因中途改私有而被旧会话重新共享。

共享可见性不是存储桶公开权限，R2 始终保持私有。新建技能默认为私有（共享写 Token 除外）；可见性转换生成新版本，防止把原先的私有版本直接标为共享。旧数据库无历史可见性信息，因此迁移仅标记原本已共享的最新版本；其他历史保留为私有，不猜测公开。

AI 初始化不签发任何 Token，不更新、续期或撤销已存在 Token，也不生成 A/B 凭据文件。你完成网页改密后自行选择类型、备注与有效期。

## 密码与 Token 分别撤销

网页修改密码：撤销全部浏览器会话，客户端 Token 保持有效。需要撤销所有 API Token 时用单独按钮，确认会中断持有这些 Token 的客户端后续访问。它不影响当前网页登录，也不会远程清除已下载技能。

Token 泄露、设备丢失和 Skill 内服务密钥泄露不是同一件事：撤销 Hub Token 只阻止后续取包；已复制出去的服务密钥应在原服务更换/撤销。

## 忘记密码：可信 D1 恢复

没有公网“免验证重置密码”入口。部署者使用已有 Wrangler / Cloudflare 管理授权和明确的数据库配置：

```bash
npm run reset-password -- --remote --config /PRIVATE/wrangler.json
# 明确需要一并撤销 API Token：
npm run reset-password -- --remote --config /PRIVATE/wrangler.json --revoke-tokens
# 自动化从仓库外私有文件读取新密码（文本或含 password 的 JSON）：
npm run reset-password -- --remote --config /PRIVATE/wrangler.json --password-file /PRIVATE/new-password.json
```

必须显式选择 --remote 或 --local；不要把测试当作远程恢复。脚本读取当前账号版本，生成新的 scrypt 哈希，以版本条件更新，不打印密码或哈希；所有网页会话被撤销，强制改密标记和一次性证明一并清除。恢复只接受正式强密码，不恢复到公开默认值。没有账号时不会借此新建管理员。可用 --username 修正忘记的账号名，仍需完整管理授权。

临时 SQL 仅含哈希，保存在私有临时目录并清理。生产恢复前先核对账号、Worker 与 D1 ID。这个命令的管理权限等同数据库管理员，不能交给普通 Hermes 发布设备。

## 已有 Token-only 实例的一次性转换

用户尚未部署时无需此步骤。已有实例先备份，再应用全部新增迁移。网页初始化会显示“原管理员 Token”，或给初始化脚本显式 --legacy-admin-file 指向原 owner.json；必须持有原有效管理员 Token，不能靠新 BOOTSTRAP_SECRET 接管。转换不删除任何旧 Token / Skill / 版本；完成后再自行撤销不需要的旧凭据。

## 技术依据

- OWASP Password Storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Session Management: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP CSRF Prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Cloudflare node:crypto: https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/

这些依据不等于本项目获得独立安全认证；测试边界见 [TEST_RESULTS.md](TEST_RESULTS.md)。

## 管理员再次查看 Token

网页“令牌列表 → 查看 / 复制”调用 POST /api/tokens/{id}/reveal，仅已完成首次改密的网页管理员会话可用，沿用现有 CSRF、同源和5分钟敏感操作验证。两种技能修改 Token 以及旧的管理员 API Token 都不能使用此接口；匿名、公共目录也不会返回这些值。

普通列表只增加 recoverable 布尔值，不返回明文、认证哈希或密文。管理员显式查看才解密一个值；响应 private/no-store，审计仅记录令牌 ID，不记录明文或密文。页面不保存到 localStorage/sessionStorage，60秒后或关闭/切页/退出时清除；晚到的网络响应不能在退出后重新显示秘密。复制到系统剪贴板的值不由网页自动撤回。

已过期/撤销的新令牌可以查看原值用于核对，但不会因此恢复权限。历史 hash-only 令牌返回409 token_value_unavailable；新签发可查看，旧令牌保持不变。缺少有效密钥时禁止签发新令牌（503 token_key_unavailable），不退化为明文或仅显示一次。错误密钥/篡改密文返回503 token_decryption_failed，客户端摘要认证不依赖此密钥，因此仍可正常验证有效旧 Token。

详见 [TOKEN_VIEW.md](TOKEN_VIEW.md)。本功能只解决 Hub 访问令牌再次查看，不加密 Skill 文件里另外保存的外部服务凭据，也不是端到端或零知识凭据保险库。
