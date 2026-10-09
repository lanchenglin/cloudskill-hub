# 上传、存储与安全边界（当前实现）

本文件描述 main 当前实现；尚未在实际使用的 Cloudflare 账号首次部署。文档文件名中的 V2 指上传协议，不是需要另行安装的产品版本。实现入口：`public/lib/policy.js`、`public/lib/archive.js`、`src/upload-stream.js`、`src/uploads.js`、`src/packages.js`、`cli/transfer.mjs`。

## 当前默认上传方式

网页和 CLI 采用“统一限制 → 本地 ZIP 校验与规范化 → 二进制流上传 → 私有 R2 → 校验完成后发布”。包保存一份 ZIP 和一个小型 manifest，默认链路不把大包转换为 Base64 JSON。

Base64 JSON 会增加传输体积和解析内存，因此只在单独的小包兼容接口保留。普通首次使用不需要了解该接口；直接按 [部署指南](SETUP.md) 安装当前版本，再按 [A 发布、B 更新](USAGE.md) 操作。

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

## 客户端、接口与本地安装

默认包格式为 `format: 2`，客户端读取 manifest、版本固定的 ZIP，并验证完整内容后再安装。当前实现也保留 `format: 1` 的 JSON 文件映射读取以及小包兼容发布端点；这是技术兼容行为，不是首次安装需要经历的不同产品版本。兼容端点仍为 200 文件 / 总计 6 MiB / 单文件 4 MiB / JSON 9 MiB，详见 [API](API.md)。

JSON 映射摘要和 ZIP 摘要语义不同，必须按 format 处理。第三方公开 well-known 只提供显式公开的内容，私人技能统一使用当前 CloudSkill CLI，不将私有令牌写到 URL。

本地更新只修改本 Hub 管理的目标。默认拒绝覆盖本地编辑或未知来源同名目录；备份放在 Agent 配置根的 `.cloudskill-backups/`，不在 `skills/` 扫描目录。CLI 同一配置目录的 `.operation.lock` 阻止主要写操作并行，尚无跨不同配置的目标锁及自动遗留锁恢复，不要让多个配置同时更新同一目录。

`publish` 是显式回传，`update` / `sync` 是手动拉取；没有自动检测回传、后台定时同步或本地/云端自动合并。

## 当前完整性与恢复保护

- 恢复会话时核对服务器实际 visibility、项目、技能与摘要，不仅相信浏览器缓存。CLI 的显式私有/公开选择不匹配时拒绝恢复。
- 下载前验证 manifest 的大小、摘要格式、路径、条目和 ZIP 布局，再发起 HTTP；读取上限拒绝缺失、NaN 或非整数值。
- R2 同步或异步提前失败时，解除校验流背压并取消/等待相关管道，避免上传挂起。真实生产中断仍需验收。
- `sync` / `update` 核对云端元数据和本地指纹，跳过未变化 ZIP；显式 `install` 重新验证远端包。`--dry-run` 不下载 ZIP，不保证尚未下载字节的完整性。
- 外部删除的已托管目录不会被当作“已安装”；`--force` 可用于确认后的恢复。同内容对应不同版本号时，验证成功后刷新安装记录。

## 首次建库与持久化

首次部署按 [SETUP.md](SETUP.md) 执行 `npm run db:migrate`，自动按顺序应用当前 `migrations/` 下全部未应用 SQL，然后 `npm run deploy`。`0001` 与 `0002` 是同一应用结构的建库步骤，不要求安装其他软件版本；不要只应用其中一个或删除初始化文件。

实际使用后，D1 元数据和 R2 包需要配套备份并演练恢复。历史技能版本、备份和审计不默认自动删除，凭据也可能留在这些副本内。不能把回滚技能内容当作撤销第三方凭据，或只恢复 D1 而忽略被引用的 R2 对象。

## 验证范围

自动化测试覆盖 mock D1/R2 的完整 50 MiB + 1000 文件默认边界，以及路径/ZIP攻击、上传权限、长度与摘要、并发版本比较、幂等、过期清理、历史私有控制、三端本地安装与本地修改保护。

原生本地 workerd + 本地 D1/R2 使用 7 MiB 文件验证实际流式接口；浏览器使用 Chromium 验证上传、编辑、下载和窄屏布局。具体通过情况以 [测试报告](TEST_RESULTS.md) 和对应 GitHub Actions 记录为准。

未以这些测试替代真实 Cloudflare 生产性能/配额、手机真机、实际 Claude/Codex/Hermes 模型加载、第三方原生 CLI 发现及长时间故障恢复验收。尤其不要把“目录安装成功”描述为“所有 Agent 版本均已执行该技能”。

## 技术依据

- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- R2 Workers API: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- R2 Worker upload: https://developers.cloudflare.com/r2/examples/demo-worker/
- Workers FixedLengthStream: https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/

平台限制可能变化；本工程的策略值仍由当前代码及部署环境决定。
