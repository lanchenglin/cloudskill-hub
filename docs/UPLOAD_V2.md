# v0.2 上传、存储和兼容性设计

本文件描述已实现的功能，不把后续计划当作现有能力。实现入口：`public/lib/policy.js`、`public/lib/archive.js`、`src/upload-stream.js`、`src/uploads.js`、`src/packages.js`、`cli/transfer.mjs`。

## 为什么不直接把 6 MiB 改成 50 MiB

v1 把每个文件编码为 Base64，然后整体序列化为 JSON。Base64 至少约增加三分之一体积；在解码、解析、重新打包时还会产生多个内存副本。仅修改大小常量不能解决 Worker 的内存和 CPU 压力，而且上传限制、下载器和本地安装器会互相不一致。

v2 采用“统一限制 → 本地 ZIP 校验与规范化 → 二进制流上传 → 私有 R2 → 校验完成后发布”的整条链路。新包保存一份 ZIP 与一个小型 manifest，下载不再生成整个 Base64 JSON。旧包不被强制转换。

## 传输选择及权衡

### 本版本：经 Worker 流式写入私有 R2

浏览器和 CLI 读取服务器能力，预检查目录或 ZIP，生成规范化 ZIP 与文件清单；用现有 Bearer Token 创建上传会话，再将 ZIP 二进制流发送到 Worker。Worker 核对实际数据，流式写入 R2 binding，D1 记录会话和发布状态。

这不是“浏览器直连 R2 的预签名上传”。采用现有 R2 binding 无需额外 S3 Access Key、桶级 CORS 或客户端可用的 R2 密钥。鉴权和同源访问也保持一致。代价是上传会消耗 Worker 请求和校验 CPU，依然需要在真实 Cloudflare 套餐压测；不能承诺免费套餐一定承受满额大包。

预签名直传、multipart 断点续传和后台审核队列可作为后续独立扩展，但需要处理签名权限、对象校验、过期清理和发布一致性，本版没有伪装成已经支持。

### 为什么规范化为 STORE ZIP

输入支持普通 STORE / DEFLATE ZIP。解压和压缩包安全预检查发生在本地浏览器或 CLI。传输格式统一为确定性 STORE ZIP：文件按确定顺序排列、UTF-8 文件名、固定时间戳、规则化文件权限，不使用压缩、数据描述符或任意附加字段。

Worker 不需要在云端解压，而是逐段检查 ZIP 头、文件内容、目录及结尾。每个文件的偏移和长度可以由 manifest 计算，网页读取一个 `SKILL.md` 或 references 文件时可通过 R2 Range 读取，不必下载整个包。

权衡：STORE 不压缩，文本包通常会比原始 DEFLATE ZIP 更大；上传与下载使用规范包大小。浏览器及 CLI 检查 ZIP 时仍使用有上限的本地内存，这不是客户端零内存方案。SHA-256 基于内容完整性，不是作者签名，也不是恶意内容扫描。

## 实际限制

| 项目 | 默认 | 可配置安全上限 |
|---|---:|---:|
| Skill 文件数 | 1000 | 2000 |
| 原始文件合计 | 50 MiB | 64 MiB |
| 单文件 | 20 MiB | 32 MiB |
| ZIP 输入 / 规范 ZIP | 55 MiB | 70 MiB |
| SKILL.md 文件 | 256 KiB | 固定 |
| 相对路径 UTF-8 字节数 | 256 | 固定 |
| 路径分段数 | 16 | 固定 |
| ZIP 单条目解压倍率 | 200 倍 | 固定 |

文件数包含 `SKILL.md` 和所有实际文件，不计算 ZIP 的显式目录条目。允许一个最外层目录，并在本地移除这一层；一个上传只对应一个 Skill，不能在一个 ZIP 中隐含发布多个不同 Skill。macOS 的 `__MACOSX` / `.DS_Store` 元数据会被跳过并提示；其他隐藏路径默认拒绝，不静默漏掉可能影响功能的文件。

`SKILL.md` 必须是有效 UTF-8，具有 YAML frontmatter。名称最多 64 字符，描述最多 1024 字符；现有 frontmatter 提取器只读取必要的顶层字段，frontmatter 结束位置仍受 16384 字符限制，其余内容原样保留，不声称是完整 YAML 编辑器。

`wrangler.jsonc`：

```json
"vars": {
  "MAX_SKILL_FILES": "1000",
  "MAX_SKILL_BYTES": "52428800",
  "MAX_FILE_BYTES": "20971520",
  "MAX_ARCHIVE_BYTES": "57671680"
}
```

只有上述四项可通过环境配置。取值必须为正安全整数，单文件 ≤ 总文件 ≤ ZIP，且不得超过代码安全上限。无效配置返回 503，并在服务端记录具体问题；客户端不静默使用过大的值。

管理网页和 `cloudskill limits` 从认证的 `GET /api/capabilities` 读取实际限制。当前没有网页修改部署参数的设置页。

## ZIP 与文件安全边界

拒绝绝对路径、路径穿越、隐藏路径段、反斜杠、控制字符、Windows ADS/保留设备名、尾部点或空格、不规范 Unicode 名称、大小写或 Unicode 等价冲突、文件与目录占用同一路径。

ZIP 拒绝加密、多磁盘、ZIP64、软链接和特殊文件、重复文件、CRC 不符、声明长度与实际内容不符、目录与本地记录冲突、异常重叠、超限解压及压缩炸弹。允许普通文件的 0644 / 0755 权限；禁止把特殊文件属性当作普通脚本权限执行。浏览器目录选择不能读取 Unix 执行位，需要保留脚本执行位时使用 CLI 目录发布或含正确权限的 ZIP。

服务端不会仅信任客户端提交的 manifest：实际上传流再次检查规范 ZIP 结构、精确字节数、每文件 SHA-256 / CRC32、整个 ZIP SHA-256，以及 SKILL.md 的真实名称和描述。只有验证后的内容可以变为 ready。校验失败即拒绝，不创建可安装的新版本。

## 会话状态与发布事务

```text
created → uploading → ready → committed
   ↓           ↓         ↓
 cancelled / expired → deleting → 清理
```

会话绑定“创建它的具体管理员令牌”，即使另一个管理员也不能直接接管这个会话。项目级只读客户端令牌不能发起、上传或提交发布。每次新请求都会重新鉴权；撤销令牌后不能继续提交新请求，但正在处理中的单个请求不是实时远程中断。

创建时记录目标 project/skill、manifest、可见性和 baseVersion。上传结束只代表 R2 收到了正确内容，不代表已经发布。finalize 使用 D1 batch 事务及版本比较提交：只有当前版本仍等于 baseVersion 且会话已 ready 才能建立新版本。并发发布或公开名称冲突返回 409，不覆盖刚发布的内容。

重复 finalize 已 committed 会话返回原结果，不产生重复版本。同一当前 ZIP 内容再次发布返回 unchanged，可应用明确的可见性选择。新的文件版本不覆盖旧 R2 对象。回滚同样创建新版本引用历史对象，不原地改写历史内容。

## 中断、恢复、配额与清理

- 默认会话有效期 1 小时；每个管理员令牌最多 3 个活跃会话、每小时 20 次创建，这些值目前为服务端常量。
- 客户端二进制上传超时 5 分钟，支持取消。取消非 committed 会话会尝试删除其对象，失败或遗留内容由后续清理补偿。
- 已 ready 的完整包可复用会话继续 finalize；CLI 可用 `--resume <id>`，网页会在当前浏览器会话中保留不含令牌的上传会话 ID。
- `--resume` 会核对本地规范 ZIP 摘要、目标与会话一致。**不能续传 ZIP 的一部分字节**。未完整上传时需要重新传整个包；工作进程异常中断后，可能需取消旧会话或等待过期后重建。
- 在 `wrangler.jsonc` 配置每 5 分钟 Cron；每次最多处理 10 条，避免单次清理工作不受限。过期未提交会话清理对象；已提交会话记录保留约 24 小时后可清理，但有版本引用的 ZIP/manifest 永不被该清理器删除。
- 无变化发布生成的无引用对象也由清理器回收。取消后记录可能仍保留到过期，以维持创建频率统计。
- 不是 R2 全桶删除或无差别生命周期过期。不要给 `packages/` 设置会删除已发布版本的桶规则。

这些配额是每令牌的上传资源保护，**不是全站总存储、日流量或账单额度控制**。已发布历史版本、审计记录及客户端备份默认不自动删除；长期运行需要监控，后续再做有明确确认及引用保护的保留策略。

## 客户端与旧数据兼容

| 组合 | 行为 |
|---|---|
| v0.2 CLI + v1 JSON 历史包 | 正常读取与安装 |
| v0.2 CLI + v2 ZIP 包 | 读取 manifest、版本固定的 ZIP、校验并安装 |
| v0.1 CLI + v2 ZIP 包 | 返回 426，明确要求升级；不返回巨大 Base64 包 |
| v1 小包发布 API | 保持 200 文件 / 总计 6 MiB / 单文件 4 MiB / JSON 9 MiB |
| v0.2 CLI 向旧服务端发布 | 不静默猜测协议；仅显式 `--legacy` 使用旧格式小目录 |
| 第三方 public well-known | 保持公开索引与下载接口；私有内容不暴露 |

原 JSON 内容摘要和新 ZIP 摘要是不同语义，manifest 通过 format 区分，不能混用哈希推断同一版本。旧历史包可能因新安全路径规则而被拒绝安装；不要以兼容为由绕过安全检查。

本地更新只修改本 Hub 管理的目标，验证新包后再落盘，发现本地编辑或未知来源同名目录时拒绝覆盖。v2 备份放在目标 Agent 配置根的 `.cloudskill-backups/`，与目标在同一文件系统，但不在 Agent 扫描的 `skills/` 目录，避免备份也变成可用技能。未实现系统级跨进程锁，避免同时启动多个 CLI 进程更新同一目录。

## 升级与回退

1. 先保存 D1 导出和 R2 备份，并在测试实例验证恢复。保存当前版本代码及真实 Wrangler 资源绑定。
2. 拉取 v0.2 代码，运行 `npm install` 与 `npm run check`。核对真实 `database_id`、R2 桶名、域名和 Secrets 没有被示例覆盖。
3. 执行 `npm run db:migrate`，先应用 `0002_binary_uploads.sql`，再 `npm run deploy`。
4. 每台 CLI 设备更新源码并 `npm link`；确认 `cloudskill limits` 能读取 v2 能力后再发布大包。
5. 验证一个原 v1 Skill、一个 v2 Skill、一次更新与回滚、一次取消和过期清理，再逐渐扩大使用。

迁移是加法式，旧记录仍保留格式 1，但**已经发布 v2 数据以后不能直接把 Worker 回退到 v0.1 并认为一切兼容**。优先修复前进；需要完整回退时应使用事前演练的 D1/R2 一致性备份恢复，不能只删迁移字段或只回退数据库。任何生产恢复都要单独确认，不能由普通客户端发起。

## 验证范围

自动化测试覆盖 mock D1/R2 的完整 50 MiB + 1000 文件默认边界，以及路径/ZIP攻击、上传权限、长度与摘要、并发版本比较、幂等、过期清理、历史私有控制、三端本地安装与本地修改保护。

原生本地 workerd + 本地 D1/R2 使用 7 MiB 文件验证跨越旧限制的真实流式接口；浏览器使用 Chromium验证上传、编辑、下载和窄屏布局。具体通过情况以 [测试报告](TEST_RESULTS.md) 和对应 GitHub Actions 记录为准。

未以这些测试替代真实 Cloudflare 生产性能/配额、手机真机、实际 Claude/Codex/Hermes 模型加载、第三方原生 CLI 发现及长时间故障恢复验收。尤其不要把“目录安装成功”描述为“所有 Agent 版本均已执行该技能”。

## 技术依据

- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- R2 Workers API: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- R2 Worker upload: https://developers.cloudflare.com/r2/examples/demo-worker/
- Workers FixedLengthStream: https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/

平台限制可能变化；本工程的策略值仍由当前代码及部署环境决定。
