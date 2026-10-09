# CloudSkill Hub API v0.2

除 `/api/bootstrap` 外，所有 `/api/*` 必须使用 `Authorization: Bearer csh_<48 hex>`。不要把令牌放进 URL、普通日志或 Git。普通客户端只能读取已授权项目；发布、上传会话、令牌管理和清理要求管理员。上传会话还绑定具体创建令牌，不是管理员之间共享。

响应默认 `Cache-Control: private, no-store`，API 不开放跨源 CORS。JSON 请求发送 `Content-Type: application/json`；ZIP 流使用 `application/zip`。文件下载返回文件字节而不是 JSON。

## 主要接口

| 方法 | 路径 | 权限 / 用途 |
|---|---|---|
| GET | `/healthz` | 公开健康与应用版本 |
| POST | `/api/bootstrap` | 初始化 Secret 创建首个管理员 |
| GET | `/api/me` | 当前令牌身份与范围 |
| GET | `/api/projects` | 已授权项目 |
| POST | `/api/projects` | 管理员，`{slug,title}` |
| GET | `/api/catalog?project=<slug>` | 可安装的最新版本；project 可省略 |
| GET | `/api/capabilities` | v2 上传协议、实际限制、旧协议限制与会话参数 |
| POST | `/api/projects/{p}/skills/{s}/uploads` | 管理员创建 v2 上传会话 |
| GET | `/api/uploads` | 当前管理员令牌最近 50 条会话 |
| GET | `/api/uploads/{id}` | 当前令牌的会话状态和 manifest |
| PUT | `/api/uploads/{id}/archive` | 当前令牌上传规范 ZIP 二进制流 |
| POST | `/api/uploads/{id}/finalize` | 当前令牌将 ready 内容提交为版本；幂等 |
| DELETE | `/api/uploads/{id}` | 取消尚未 committed 的会话 |
| POST | `/api/uploads/cleanup` | 管理员触发一次有界清理，通常由 Cron 自动执行 |
| POST | `/api/projects/{p}/skills/{s}` | 兼容 v1 小包 JSON 发布，不用于大包 |
| GET | `/api/projects/{p}/skills/{s}/versions` | 历史版本列表 |
| GET | `/api/projects/{p}/skills/{s}/versions/{n}?format=manifest` | v2 manifest 或 v1 files；新客户端应带查询参数 |
| GET | `/api/projects/{p}/skills/{s}/versions/{n}/download` | 固定版本 ZIP，流式返回 |
| GET | `/api/projects/{p}/skills/{s}/versions/{n}/file?path=SKILL.md` | 单文件读取，path 可为 URL 编码的安全相对路径 |
| GET | `/api/projects/{p}/skills/{s}/download` | 最新 ZIP；对一致性敏感的客户端应使用版本固定地址 |
| POST | `/api/projects/{p}/skills/{s}/rollback` | 管理员，`{version,baseVersion?}` 创建新的历史引用版本 |
| GET | `/api/tokens` | 管理员查看令牌元信息，不返回已有令牌明文 |
| POST | `/api/tokens` | 管理员，`{label,role,projects}` 签发令牌 |
| POST | `/api/tokens/{id}/revoke` | 管理员撤销其他令牌 |
| GET | `/api/devices` | 管理员查看客户端最后上报 |
| POST | `/api/devices/heartbeat` | 客户端上报已授权项目的安装清单 |
| GET | `/api/audit` | 管理员查看最近 100 条审计 |

`p`、`s` 必须满足小写字母、数字及中划线命名规则，最长 64 字符。`n` 为版本号。上传 id 由服务端返回。

## 能力与限制

默认响应示例（这里仅展示关键字段）：

```json
{
  "version": "0.2.0",
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

## v2 发布协议

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

省略 visibility：新 Skill 私有，更新保留现有可见性。省略 baseVersion 的 API 调用会以创建会话时最新版本为基线；网页和 CLI 会明确带基线以保护过期编辑。

创建结果：`{id,state:"created",baseVersion,expiresAt,uploadPath,finalizePath}`，201。最终结果包含 `{project,slug,version,digest,archive_digest,format:2,unchanged}`。v2 digest 与 archive_digest 都代表规范 ZIP；不能与旧 JSON 文件映射摘要混为一谈。

相同会话 finalize 已成功但响应丢失：GET status 或重复 finalize 返回相同 result。ready 会话可重复利用完整 ZIP；created/中断状态不具备字节分片续传。状态长期 uploading 时先检查并取消，或等待过期后重建，不能无条件覆盖该对象。

## 下载与旧客户端

带 `?format=manifest` 的新客户端兼容两种结果：

- 格式 1：`{project,slug,version,description,digest,format:1,files:{path:base64}}`。
- 格式 2：`{project,slug,version,description,digest,format:2,manifest,downloadPath}`；manifest 包含文件清单、摘要、ZIP 大小及 rawBytes。

读取格式 2 却未声明 manifest 的旧调用返回 **426**。不会为了兼容而把新大包转换回大 JSON。客户端应只向与 Hub 同源、经过严格校验的下载路径发送凭据，并校验完整 ZIP 及各文件后安装。

旧发布端点仍接受 `{files:{path:base64},visibility,baseVersion?}`；限制为最多 200 文件、合计 6 MiB、单文件 4 MiB、请求体 9 MiB。省略 visibility 的旧端点仍沿用旧逻辑默认 private，请显式指定，不能套用 v2 的省略保留语义。

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
| 403 | 没有管理员/项目权限 |
| 404 | 不存在、会话不属于当前令牌，或匿名访问私有资源 |
| 409 | 并发发布、版本变化、名称冲突或状态冲突；刷新后重新确认 |
| 410 | 会话过期、取消竞态或清理中；创建新会话 |
| 413 | 文件、原始总量、ZIP 或请求体超限 |
| 415 | 请求 Content-Type 不正确 |
| 426 | 旧客户端无法读取新格式；升级 CLI |
| 429 | 会话创建频率或活跃数限制 |
| 500 / 503 | 内部错误、配置或后端资源问题；客户端收到通用信息，管理员查看服务日志 |

平台自身还可能返回请求限制或超时错误。不要无限重试管理员发布；先检查会话结果，避免重复版本或无意义 R2 写入。
