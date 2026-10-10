# CloudSkill Hub API — 当前 0.4.1

## 权限模型

共享 = `visibility: "public"`，任何人都能拉取；私有 = `"private"`，不向访客和共享修改 Token 暴露。

| 身份 | 内容读取 | 内容修改 | 网站管理 |
|---|---|---|---|
| guest | 共享 | 无 | 无 |
| shared_writer | 共享及其共享历史版本 | 新建/更新/回滚共享技能 | 无 |
| all_writer | 共享和私有 | 新建/更新/回滚全部技能，显式改变可见性 | 无 |
| 网页管理员 | 全部 | 全部 | 管理账号、分类、Token |

Token 在网页自行签发，CLI 使用 `Authorization: Bearer csh_<48 hex>`；不绑定 A/B/C，不用项目选择。旧 project-scoped client/publisher/admin Token 只兼容验证，按原权限工作，不再新签发、不自动扩大权限。

所有响应均 no-store；不开放跨站 CORS；秘密不放 URL。受保护接口的坏 Token 不回退为 Cookie/匿名。R2 始终私有，由 Worker 执行权限检查。

## 匿名读取

仅以下 GET 路由无需 Token：

| 路径 | 返回 |
|---|---|
| `/api/public/me` | guest 身份，不创建持久身份 |
| `/api/public/projects` | 存在共享技能的分类，不返回纯私有分类 |
| `/api/public/catalog` / `/api/public/skills` | 仅共享技能，支持 `?project=...` |
| `/api/public/capabilities` | 当前上传/包格式策略 |
| `/api/public/projects/{p}/skills/{s}/download` | 共享最新版 ZIP |
| `/api/public/projects/{p}/skills/{s}/versions` | 可公开读取的历史 |
| `/api/public/projects/{p}/skills/{s}/versions/{v}?format=manifest` | 可读取版本的 manifest / 小包信息 |
| `/api/public/projects/{p}/skills/{s}/versions/{v}/download` | 共享版本 ZIP |
| `/api/public/projects/{p}/skills/{s}/versions/{v}/file?path=SKILL.md` | 共享版本单文件 |

管理接口不在匿名白名单；匿名写入拒绝。私有技能、私有历史和不可读取的路径返回404，不包含内容。即使请求含管理员 Cookie 或 Token，`/api/public/*` 仍只返回公开数据。

共享网页 `/shared.html`，公开发现端点仍支持：

```text
GET /.well-known/skills/index.json
GET /.well-known/skills/{skill}/{relativePath}
GET /.well-known/agent-skills/index.json
GET /.well-known/agent-skills/{skill}/{archiveDigest}.zip
```

当前技能与指定历史版本必须都允许共享，不能仅凭“最新版共享”取得历史私有 ZIP。已经被下载的副本无法收回。公开发现的 Skill 名称跨项目唯一。

## 登录、强制改密与网页会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/status` | 是否初始化，是否属于旧账号转换 |
| POST | `/api/auth/setup` | 首次创建，需要初始化 Secret；旧实例需要原管理员授权 |
| POST | `/api/auth/login` | username/password，返回 HttpOnly Cookie、csrfToken、mustChangePassword |
| GET | `/api/auth/session` | 当前会话；首次改密限制状态 |
| POST | `/api/auth/password` | currentPassword/newPassword；不需要额外 Secret，清除门禁并撤销旧会话 |
| POST | `/api/auth/logout` | 退出当前会话 |
| POST | `/api/auth/reauth` | 当前密码确认，续接敏感操作验证 |
| POST | `/api/auth/revoke-all-tokens` | 明确确认 `confirm: "revoke-all-api-tokens"` |

账号默认为 admin/lanchenglin，首次强制改密，新密码6–20字符。待改密的受保护业务请求仍返回403 `password_change_required`。登录/写操作要求 `X-CloudSkill-Request: 1`、同源；Cookie 写还须正确 `X-CSRF-Token`。`activationSecretRequired` 仅兼容返回 false；旧 bootstrapSecret 字段不再是改密授权条件。

签发/撤销 Token 需最近5分钟内验证过网页密码；否则403 `reauth_required`。`all_writer` 不是管理员，不能通过任何 Token 管理/账号路由获得网站管理权。旧 `/api/bootstrap` 已关闭，返回410；无公网免验证恢复接口。

## 手动签发 Token

```http
POST /api/tokens
Content-Type: application/json
X-CloudSkill-Request: 1
X-CSRF-Token: <网页会话的 CSRF 值>
Cookie: <管理员会话>
```

```json
{"label":"共享修改","role":"shared_writer","expiresInDays":null}
```

或 role=`all_writer`。省略 projects 或发送空数组；非空项目列表拒绝，防止误以为存在项目限制。不接受 client/publisher/admin/guest 的新签发请求。初始化脚本不调用此接口。

`expiresInDays` 省略=90天；显式null=永久；1–365整数=定期。0、366、字符串、布尔值均拒绝。响应 `{id,token,role,scope,projects:[],expiresAt}`，其中 scope=shared/all；永久的 expiresAt=null。仅当次返回 Token 明文。

`GET /api/tokens` 仅管理员，返回备注、有效角色、permission_mode、旧project_scope、expires_at、revoked_at、last_used_at，不返回Token值。

`POST /api/tokens/{id}/revoke` 撤销指定Token；永久也能撤销。改网页密码不自动撤销Token；升级/初始化不会改变已签发Token的期限。

## 受保护内容与管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/me` | 当前Token权限与期限 |
| GET | `/api/projects` | 全部修改身份看到所有分类；共享身份仅看到有共享内容的分类 |
| GET | `/api/catalog` / `/api/skills` | 按身份过滤的最新技能 |
| GET | `/api/capabilities` | 上传/版本能力 |
| POST | `/api/projects` | 仅网页管理员创建分类 |
| GET | `/api/devices`, `/api/audit` | 仅管理员 |
| POST | `/api/devices/heartbeat` | 已授权Token上报自己的可读安装；匿名不上报 |
| GET | `/api/uploads` | 发布身份自己的上传记录 |
| GET/DELETE | `/api/uploads/{id}` | 查询/取消本人未发布会话 |
| POST | `/api/uploads/cleanup` | 仅管理员；清理未引用对象，不删除已发布版本 |
| GET | `/api/projects/{p}/skills/{s}/versions` | 经过内容/历史权限过滤 |
| GET | `/api/projects/{p}/skills/{s}/download` | 最新可读ZIP |
| GET | `/api/projects/{p}/skills/{s}/versions/{v}` | 可读版本；二进制要求format=manifest |
| GET | `/api/projects/{p}/skills/{s}/versions/{v}/download` | 可读历史ZIP |
| GET | `/api/projects/{p}/skills/{s}/versions/{v}/file?path=...` | 可读版本单文件 |
| POST | `/api/projects/{p}/skills/{s}/rollback` | 有内容修改权限，{version,baseVersion?}；私有历史不可被共享Token读取/回滚 |

## ZIP 发布

```text
POST /api/projects/{p}/skills/{s}/uploads
PUT  /api/uploads/{id}/archive
POST /api/uploads/{id}/finalize
```

创建请求为规范ZIP manifest（files/长度/CRC32/SHA-256）加 `baseVersion` 与可选 `visibility`；PUT为 `application/zip` 二进制。创建返回id、uploadPath、finalizePath、baseVersion、expiresAt。只有finalize提交成功才产生可安装版本。

已有技能省略visibility时保持当前值；新共享写Token默认为public，其他新技能默认为private。共享Token不能读/改私有、不能切换可见性；全部Token可以显式public/private。所有上传步骤检查令牌、会话归属与当前内容权限；共享写入期间目标变为私有时后续请求拒绝。

正常未改变的文件与可见性会no-op；可见性改变建立新版本，即使文件相同。并发版本冲突返回409，不自动覆盖。会话失去响应可查询/恢复，完整文件断流仍需重传，不是字节级续传。

兼容小包 `POST /api/projects/{p}/skills/{s}` 接受 `{files:{path:base64},visibility?,baseVersion?}`，亦受相同内容权限约束；仍限200文件/6MiB/单文件4MiB/请求9MiB，不代替默认大包上传。

manifest包 `format:2` 的digest表示archiveDigest；历史JSON `format:1` 表示文件映射摘要。详细布局、限制和校验见 [UPLOAD_V2](UPLOAD_V2.md)。

## 数据库与错误

首次统一运行0001–0005迁移。0005保留旧Token权限，增加新Token分类；历史可见性不可回溯推断，所以旧公开技能仅将已公开的最新版标为public，其他历史不自动公开。

401：无效/撤销/到期身份或匿名写；403：越权、CSRF、待改密、需重新验证；404：不存在或不可读；409：版本/状态冲突；413：大小超限；426：客户端包格式能力不足；429：现有限速；500/503：配置/后端错误。安全边界见 [AUTH](AUTH.md)，测试范围见 [TEST_RESULTS](TEST_RESULTS.md)。
