# 账号、会话与客户端授权

当前版本采用 **单管理员账号密码 + 每设备独立 API Token**。这不是多用户系统，也没有实现 MFA / Passkey / 独立密钥保险库。

## 账号初始化

网页首页设置用户名和密码，必须先有足够随机的 BOOTSTRAP_SECRET。用户名规范化为小写，3–64 个 ASCII 字母、数字、点、下划线或中划线；密码 15–128 个字符，支持空格、中文和 Unicode，不截断、不去除密码首尾空白。

没有通用默认密码。手动部署由用户设置；`scripts/initialize-hub.mjs` 默认用户名 admin，并在未提供密码文件时生成随机 32 字节密码，保存在仓库外 `web-admin.json`，建议首次登录后自行修改。

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

## API Token

| 身份 | 读取 | 发布 | 管理账号/项目/Token | 公开技能 |
|---|---|---|---|---|
| web 管理员 | 全站 | 全站 | 是 | 是 |
| publisher | 仅授权项目 | 仅授权项目的私有技能 | 否 | 否，也不能修改已公开技能 |
| client | 仅授权项目 | 否 | 否 | 否 |

新 Token 默认 90 天有效，接口可设置 1–365 天。服务端只保存 Token 摘要，检查到期/撤销状态；权限标签和最后使用时间可查看。上传会话继续绑定创建身份，并在各次请求检查当前项目权限。每个身份有独立上传会话配额。

为了不破坏已有表的 CHECK 与外键，publisher 在数据库内部存为 role=client、can_publish=1；API 输出有效角色 publisher。网页身份也有一个不可用作 API Key 的内部授权记录，既没有可登录的 Token 明文，也不出现在设备 Token 列表里。

已有 API-admin Token 兼容保留，未设置到期时间的旧 Token 不被静默设为失效；新接口不再签发 admin API Token。完成账号转换后，建议用 scoped publisher/client 替代，再明确撤销旧管理员 Token。现有技能、版本、上传会话和设备外键不重建。

## 密码与 Token 分别撤销

网页修改密码：撤销全部浏览器会话，客户端 Token 保持有效。需要撤销所有 API Token 时用单独按钮，确认会中断 A/B 后续访问。它不影响当前网页登录，也不会远程清除已下载技能。

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

必须显式选择 --remote 或 --local；不要把测试当作远程恢复。脚本读取当前账号版本，生成新的 scrypt 哈希，以版本条件更新，不打印密码或哈希；所有网页会话被撤销。没有账号时不会借此新建管理员。可用 --username 修正忘记的账号名，仍需完整管理授权。

临时 SQL 仅含哈希，保存在私有临时目录并清理。生产恢复前先核对账号、Worker 与 D1 ID。这个命令的管理权限等同数据库管理员，不能交给普通 Hermes 发布设备。

## 已有 Token-only 实例的一次性转换

用户尚未部署时无需此步骤。已有实例先备份，再应用全部新增迁移。网页初始化会显示“原管理员 Token”，或给初始化脚本显式 --legacy-admin-file 指向原 owner.json；必须持有原有效管理员 Token，不能靠新 BOOTSTRAP_SECRET 接管。转换不删除任何旧 Token / Skill / 版本；完成后再自行撤销不需要的旧凭据。

## 技术依据

- OWASP Password Storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Session Management: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP CSRF Prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Cloudflare node:crypto: https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/

这些依据不等于本项目获得独立安全认证；测试边界见 [TEST_RESULTS.md](TEST_RESULTS.md)。
