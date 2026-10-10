# CloudSkill Hub API（当前实现）

本说明对应 main 当前代码。使用者应先完成 [首次部署](SETUP.md)，日常手动分发见 [USAGE.md](USAGE.md)。上传协议编号和文件 format 字段是接口标识，不要求安装多个应用版本。

认证有两条路径：网页用账号密码建立 HttpOnly Cookie 会话；CLI 用 `Authorization: Bearer csh_<48 hex>`。公开 `/api/auth/status`、登录与首次设置不要求既有会话，但其写操作要求 `X-CloudSkill-Request: 1`，浏览器来源必须与 Hub 相同；设置还需要初始化 Secret 或原管理员凭据。

所有 Cookie 鉴权的写操作额外要求 `X-CSRF-Token`。登录/会话接口返回 CSRF 值而不是 Cookie 明文。API Token 请求不依赖 Cookie，也不因无效 Bearer 回退为网页身份。响应不缓存、不开放跨站 CORS，秘密不放 URL。发布者只操作授权项目的私有技能，客户端只读，网页管理员负责管理。

### 账号接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/status` | 是否初始化、是否需原管理员转换；不暴露账号名称 |
| POST | `/api/auth/setup` | `{secret?,username?,password?}`；默认 admin/lanchenglin，初次 Secret 或原管理员 Bearer；固定 mustChangePassword=true |
| POST | `/api/auth/login` | `{username,password}`；Set-Cookie，返回 username/role/csrfToken/expiresAt/mustChangePassword/activationSecretRequired |
| GET | `/api/auth/session` | Cookie 会话信息、csrfToken、mustChangePassword、activationSecretRequired |
| POST | `/api/auth/logout` | Cookie + CSRF，当前会话失效 |
| POST | `/api/auth/reauth` | Cookie + CSRF + `{password}`；延续 5 分钟敏感操作验证 |
| POST | `/api/auth/password` | Cookie + CSRF + `{currentPassword,newPassword}`；完成首次改密或正常改密，撤销网页会话 |
| POST | `/api/auth/revoke-all-tokens` | 最近验证 + CSRF + `{confirm:"revoke-all-api-tokens"}`，显式撤销所有 API Token |

没有公网忘记密码重置接口；可信命令见 [AUTH.md](AUTH.md)。`/api/bootstrap` Token-only 接口返回 410，不能绕过密码设置。

### 首次登录限制

`mustChangePassword=true` 时不要加载目录或签发 Token。完成 `/api/auth/password` 才解除限制；正式新密码为 15–128 字符且不能与当前值相同。`activationSecretRequired` 仅为兼容字段，恒为 false；首次和日常改密均不要求初始化 Secret 或原管理员 Token。旧请求附带的 `bootstrapSecret` 字段会被忽略，但会话、当前密码、CSRF 和新密码规则仍必须通过。成功返回 `mustChangePassword:false`，所有旧 Cookie 失效，再次登录才有正常权限。客户端不能通过传 `mustChangePassword:false` 清除状态。

后台业务接口和已有 Bearer 的访问同样返回 403 `password_change_required`；自定义集成必须尊重该状态，不能自动重新初始化或调用可信恢复绕过。匿名公开入口保持原有语义。

## 主要接口

| 方法 | 路径 | 权限 / 用途 |
|---|---|---|
| GET | `/healthz` | 公开健康与应用版本 |
| POST | `/api/bootstrap` | 已关闭（410），使用账号初始化接口 |
| GET | `/api/me` | 当前令牌身份与范围 |
| GET | `/api/projects` | 已授权项目 |
| POST | `/api/projects` | 管理员，`{slug,title}` |
| GET | `/api/catalog?project=<slug>` | 可安装的最新版本；project 可省略 |
| GET | `/api/capabilities` | 上传协议编号、实际限制、JSON 小包兼容限制与会话参数 |
| POST | `/api/projects/{p}/skills/{s}/uploads` | 管理员或授权发布者创建 ZIP 上传会话 |
| GET | `/api/uploads` | 当前发布身份最近 50 条会话 |
| GET | `/api/uploads/{id}` | 当前发布身份的会话状态、实际 visibility 和 manifest |
| PUT | `/api/uploads/{id}/archive` | 当前发布身份上传规范 ZIP 二进制流 |
| POST | `/api/uploads/{id}/finalize` | 当前发布身份将 ready 内容提交为版本；幂等 |
| DELETE | `/api/uploads/{id}` | 取消尚未 committed 的会话 |
| POST | `/api/uploads/cleanup` | 管理员触发一次有界清理，通常由 Cron 自动执行 |
| POST | `/api/projects/{p}/skills/{s}` | JSON 小包兼容发布，不是默认上传方式 |
| GET | `/api/projects/{p}/skills/{s}/versions` | 历史版本列表 |
| GET | `/api/projects/{p}/skills/{s}/versions/{n}?format=manifest` | 按 format 返回 manifest 或 files；应带查询参数 |
| GET | `/api/projects/{p}/skills/{s}/versions/{n}/download` | 固定版本 ZIP，流式返回 |
| GET | `/api/projects/{p}/skills/{s}/versions/{n}/file?path=SKILL.md` | 单文件读取，path 可为 URL 编码的安全相对路径 |
| GET | `/api/projects/{p}/skills/{s}/download` | 最新 ZIP；对一致性敏感的客户端应使用版本固定地址 |
| POST | `/api/projects/{p}/skills/{s}/rollback` | 管理员或项目发布者，`{version,baseVersion?}` 创建新的历史引用版本 |
| GET | `/api/tokens` | 管理员查看令牌元信息，不返回已有令牌明文 |
| POST | `/api/tokens` | 管理员，`{label,role,projects,expiresInDays?}`；role=publisher/client；expiresInDays 为 1–365 整数或 null（永久），省略默认90天 |
| POST | `/api/tokens/{id}/revoke` | 管理员撤销其他令牌 |
| GET | `/api/devices` | 管理员查看客户端最后上报 |
| POST | `/api/devices/heartbeat` | 客户端上报已授权项目的安装清单 |
| GET | `/api/audit` | 管理员查看最近 100 条审计 |

`p`、`s` 必须满足小写字母、数字及中划线命名规则，最长 64 字符。`n` 为版本号。上传 id 由服务端返回。

## 能力与限制

默认响应示例（这里仅展示关键字段）：

```json
{
  "version": "0.3.3",
  "uploadProtocol": 2,
  "limits": {
    "maxFiles": 1000,
    "maxBundleBytes": 52428800,
    "maxFileBytes": 20971520,
    "maxArchiveBytes": 57671680,
    "maxSkillMdBytes": 262144,
    "maxPathBytes": 256,
    "maxDepth": 16,
    "maxCompressionRatio": 200
  },
  "uploads": {
    "sessionTtlSeconds": 3600,
    "maxActive": 3,
    "maxStartsPerHour": 20,
    "resume": "completed-archive",
    "transport": "worker-stream-to-private-r2",
    "zipCompression": ["store", "deflate"]
  }
}
```

`zipCompression` 表示浏览器/CLI 可导入的 ZIP 算法；**PUT archive 不接收任意第三方 ZIP**，而要求由共享打包器生成的规范 STORE ZIP。普通集成优先使用 `cloudskill publish`，不要直接将未经规范化的 ZIP 发送到该端点。

## 默认 ZIP 发布协议

1. 获取 capabilities 与 catalog，确定当前版本。目录/ZIP 在本地完成安全预检查，使用 `public/lib/archive.js` 的 `pack` 生成规范 ZIP 和文件描述。
2. POST uploads，JSON 最多 1 MiB，包含 `files`、`archiveDigest`、`archiveBytes`、`baseVersion`，以及可选 `visibility`。
3. PUT 返回的 `uploadPath`，body 为规范 ZIP 原始字节。传输中服务端逐段核验，成功后状态变为 ready。
4. POST 返回的 `finalizePath`。只有成功提交后才可安装。得到 committed 结果前，不要把“100% 已上传”报告为“发布成功”。

创建请求字段：

```text
files: [{name, size, sha256, crc32, mode}, ...]
archiveDigest: 整个规范 ZIP 的 SHA-256 小写十六进制（不带 sha256:）
archiveBytes: 精确规范 ZIP 字节数
baseVersion: 当前版本号，新 Skill 为 0
visibility: private | public，可省略
```

`crc32` 为无符号 32 位整数；`mode` 为十进制表示的 0644 或 0755 权限（420 或 493）。文件摘要均为 SHA-256 小写十六进制。服务端从文件顺序与长度重新计算偏移和 ZIP 结构，不信任客户端自报偏移。

省略 visibility：新 Skill 私有，更新保留现有可见性。省略 baseVersion 的 API 调用会以创建会话时最新版本为基线；网页和 CLI 明确携带发布基线，阻止上传期间其他发布覆盖当前目标。CLI 读取的是本次发布前的云端版本，不是完整的多端编辑合并基线；两端都改过时先人工对齐。

创建结果：`{id,state:"created",baseVersion,expiresAt,uploadPath,finalizePath}`，201。最终结果包含 `{project,slug,version,digest,archive_digest,format:2,unchanged}`。format 2 的 digest 与 archive_digest 都代表规范 ZIP；不能与 format 1 的 JSON 文件映射摘要混为一谈。

恢复前核对会话实际的项目、技能、摘要和 visibility；显式私有要求不得复用公开会话。

相同会话 finalize 已成功但响应丢失：GET status 或重复 finalize 返回相同 result。ready 会话可重复利用完整 ZIP；created/中断状态不具备字节分片续传。状态长期 uploading 时先检查并取消，或等待过期后重建，不能无条件覆盖该对象。

## 下载结果与小包兼容端点

版本读取统一带 `?format=manifest`。当前代码按 format 区分两种返回结构：

- 格式 1：`{project,slug,version,description,digest,format:1,files:{path:base64}}`。
- 格式 2：`{project,slug,version,description,digest,format:2,manifest,downloadPath}`；manifest 包含文件清单、摘要、ZIP 大小及 rawBytes。

读取格式 2 却未声明 manifest 的调用返回 **426**，错误文本提示客户端能力不匹配。使用当前 CLI，或在自定义接口中正确声明 `?format=manifest`；服务端不会把 ZIP 大包转回 Base64 JSON。客户端应只向与 Hub 同源、经过严格校验的下载路径发送凭据，并校验完整 ZIP 及各文件后安装。

JSON 小包兼容发布端点接受 `{files:{path:base64},visibility,baseVersion?}`；限制为最多 200 文件、合计 6 MiB、单文件 4 MiB、请求体 9 MiB。此端点省略 visibility 时默认 private，不能套用默认 ZIP 协议的省略保留语义。普通用户使用网页或 `cloudskill publish`，不需要调用这个兼容端点或使用 `--legacy`。

## 公开发现

```text
GET /.well-known/skills/index.json
GET /.well-known/skills/{skill}/{relativePath}
GET /.well-known/agent-skills/index.json
GET /.well-known/agent-skills/{skill}/{archiveDigest}.zip
```

仅显式公开的技能可匿名读取。项目间公开名称必须唯一。公开技能历史 ZIP 的摘要地址仍可用，但该 Skill 改私有后，匿名历史地址也返回 404。已经下载的内容无法远程回收。私有工具分发使用本 Hub CLI，不把私有 Token 拼接为下载 URL。

## 错误

```json
{"error":"Upload session expired. Start again."}
```

| 状态码 | 含义与处理 |
|---|---|
| 400 | 内容、路径、ZIP、元数据或校验不合法；修正输入，不盲目重试 |
| 401 | 缺少、失效或被撤销的令牌 |
| 403 | 没有权限，或 password_change_required / reauth_required |
| 404 | 不存在、会话不属于当前令牌，或匿名访问私有资源 |
| 409 | 并发发布、版本变化、名称冲突或状态冲突；刷新后重新确认 |
| 410 | 会话过期、取消竞态或清理中；创建新会话 |
| 413 | 文件、原始总量、ZIP 或请求体超限 |
| 415 | 请求 Content-Type 不正确 |
| 426 | 请求能力与包格式不匹配；使用当前 CLI 或正确声明 manifest |
| 429 | 会话创建频率或活跃数限制 |
| 500 / 503 | 内部错误、配置或后端资源问题；客户端收到通用信息，管理员查看服务日志 |

平台自身还可能返回请求限制或超时错误。不要无限重试管理员发布；先检查会话结果，避免重复版本或无意义 R2 写入。

## 权限与会话补充

Cookie 管理员超过最近验证时限时，签发/撤销操作返回 403 `reauth_required`；网页先调用 reauth，再重试。新 Token 返回 `{id,token,role,projects,expiresAt}`，明文只出现一次；列表含 `expires_at`、`last_used_at`，不返回 Token。新建 admin API Token 请求被拒绝。旧 API Token 可兼容直到到期或撤销。

永久 Token 请求示例（需要已完成首次改密的管理员鉴权；Cookie 请求仍要 CSRF）：

```json
{"label":"Hermes-A","role":"publisher","projects":["personal"],"expiresInDays":null}
```

`expiresInDays` **省略为 90 天，显式 null 为永久**，两者不同。1–365 整数保留；0、366、字符串 "never" / "null"、布尔值、空字符串等返回 400，不签发令牌。永久令牌的签发响应和 `/api/me` 均返回 `expiresAt: null`，列表返回 `expires_at: null`。它仍可单独撤销/批量撤销，不改变角色、项目范围、网页登录与上传会话的超时规则。不要把 null 解析为 0 天或 90 天。

发布者禁止创建 public 包或编辑已公开 Skill；权限检查同时覆盖 JSON、ZIP 会话、上传、finalize 和回滚。web 身份的上传会话绑定内部管理员主体，不是 Cookie 原值；同一管理员重新登录可续接。

账号结构和强制改密状态分别由 `0003_web_auth.sql`、`0004_require_password_change.sql` 加法迁移建立。004 对已有账号使用默认标记 0，不改旧密码、不撤销旧会话；新建账号显式设置为 1。role=publisher 在内部通过 client + can_publish 标记表示；调用方使用 API 返回的有效 role，不直接推测数据库列。
