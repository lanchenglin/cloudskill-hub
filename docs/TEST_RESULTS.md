# 当前应用代码测试报告

当前代码版本：**0.2.1**。本报告只汇总当前应用的验证情况，不将开发阶段的中间版本报告作为安装指南。

**部署状态：尚未在实际使用的 Cloudflare 账号完成首次部署，A/B 真实 AI 使用验收也尚未完成。自动化测试不是生产部署记录。**

## 验证依据

应用代码提交：`eef8bd8b6990d0e6f2e466ac0a18cfeda4a70980`。本轮仅整理文档，不改变应用代码、测试、数据库 SQL 或部署配置。

已核对该提交的 main 分支 [GitHub Actions 检查](https://github.com/lanchenglin/cloudskill-hub/actions/runs/37922337179)：四个 job 均完成且为 **success**。

| 环境 / 检查 | 结果及范围 |
|---|---|
| Linux，Node 22.23.3 / 24.18.1 本地检查 | 两个运行时分别 40 通过、0 失败 |
| GitHub Ubuntu，Node 22 | 通过语法、安全与集成测试 |
| GitHub Windows，Node 22 | 通过语法、安全与集成测试 |
| 原生本地 workerd + 本地 D1/R2 | 通过全部初始化 SQL、7 MiB 上传、三端目录安装、重复发布及清理 |
| Chromium 网页 | 通过 ZIP 上传、编辑、固定版本下载和 390/320 px 布局检查 |

运行详情和原始输出以链接中的 job logs 为准。CI 本地 workerd 使用临时资源，不接触生产 Cloudflare 数据。

## 40 项自动化测试覆盖

- 鉴权、项目权限、发布、技能版本/回滚、公开发现、私有历史访问和安全响应头。
- STORE / DEFLATE ZIP、单层包装目录、中文文件名、Hermes metadata、执行位及确定性打包。
- 路径穿越、隐藏敏感文件、软链接、特殊文件、加密包、压缩炸弹、CRC/摘要和长度造假、路径冲突等拒绝场景。
- 上传会话权限、上传/提交分离、校验失败不发布、重复提交、过期和取消清理、并发版本冲突及已发布包引用保护。
- 7 MiB 文件，以及 **50 MiB / 1000 文件完整默认边界（模拟 D1/R2）**。不是线上大包生产压测。
- CLI 目录/ZIP 发布、三端目录安装、手动更新、本地修改保护、响应丢失后的会话恢复、安装状态写入失败恢复。
- 下载前 manifest/读取上限校验、恢复公开/私有冲突、R2 提前失败与背压取消、被删除托管目录强制恢复、未变化同步不重复下载。

网页下载的 ZIP 还使用 Python `zipfile` 独立核对 CRC 和文本内容，避免只由同一实现自我验证。

## 本地复查命令

```bash
# Node.js 22.16+，源码根目录，无生产凭据
npm run check

# 先 npm install，使用真实本地 Workers 运行时
node scripts/worker-smoke.mjs

# 另需 Python、Playwright 与 Chromium
python scripts/browser-smoke.py
```

## 尚未完成的验收

- 实际使用的 Cloudflare 账号首次部署、WAF、CPU/内存/计费、满额上传和长期并发。
- A/B 真机按使用说明手动发布/更新，并在实际 Hermes、Claude Code 或 Codex 会话发现和执行技能。
- 第三方 `skills` / Hermes 原生 CLI 对线上域名的完整发现和更新互操作。
- 手机真机、所有 WSL 挂载/权限组合、故障断电与灾备恢复演练。

当前目录适配和内容完整性测试不代表所有 Agent 版本都能加载技能；私有访问测试也不代表实现了独立凭据保险库。首次使用按 [SETUP.md](SETUP.md) 和 [USAGE.md](USAGE.md) 验收。
