# 当前版本说明

## 0.2.1

使用 `main` 中的当前完整代码。这里汇总当前功能，不把开发阶段的中间提交写成需要依次安装的版本；代码变更历史仍保留在 Git 提交中。

**当前状态：本地与 CI 测试已执行，实际使用环境尚未首次安装部署；真实 Cloudflare 和 A/B AI 使用验收未完成。**

### 主要用途

A 的 Hermes 技能修改好后手动 `publish` 到私人 Hub，B 的 Hermes 或 Claude Code 首次 `install`，以后手动 `update`。需要接收新增技能时先 `subscribe`，再按需 `sync`。不要求自动双向同步。

### 当前包含

- Workers + D1 + 私有 R2，中文网页、项目权限、技能版本与回滚。
- 目录和 ZIP 发布，默认总计 50 MiB、单文件 20 MiB、1000 文件；统一配置与预检查。
- 上传会话、流式校验、完整性验证、进度、取消、已完整上传包的恢复及过期清理。
- 公开/私有恢复冲突检查、并发发布保护、幂等提交。
- Claude、Codex、Hermes 的当前目录适配与手动安装更新；本地修改和未知同名目录保护。
- 更新前备份、异常恢复、未变化同步不重复下载 ZIP、`--dry-run` 只预检。
- Ubuntu / Windows 测试、原生本地 workerd/D1/R2 与 Chromium 网页检查。

### 首次使用

按 [SETUP.md](docs/SETUP.md) 创建资源、设置初始化 Secret、执行全部数据库初始化 SQL、部署 Worker，并在 A/B 分别安装 CLI。无需先安装其他版本。

当前未实现独立凭据保险库、字节级断点续传、自动双向合并或任意 AI 工具适配。具体测试与边界见 [TEST_RESULTS.md](docs/TEST_RESULTS.md)。
