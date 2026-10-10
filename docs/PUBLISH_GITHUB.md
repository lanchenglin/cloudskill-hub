# GitHub 发布流程：main → worker → Cloudflare

本项目固定使用两个长期分支：`main` 开发和测试，`worker` 保存通过 CI 的完整发布源码。**worker 只创建一次，此后由 GitHub Actions 快进更新，不生成合并提交、不另外维护代码。** 历史开发分支无需删除。

## 已配置的 GitHub 流程

```text
提交到 main
    ↓
Test CloudSkill Hub
    ├─ test (ubuntu-latest, 22)
    ├─ test (ubuntu-latest, 24)
    ├─ test (windows-latest, 22)
    ├─ test (windows-latest, 24)
    ├─ worker-runtime
    └─ browser
    ↓ 全部成功
Promote tested main to worker
    ↓ 精确快进到本次测试的 SHA
worker 分支收到推送
    ↓ Cloudflare 连接配置完成以后
Cloudflare Workers Builds 构建、迁移和部署
```

`.github/workflows/ci.yml` 的同步 job 显式依赖 test 矩阵、worker-runtime 和 browser。任何一项失败、取消或未成功，均不会更新 worker。它只在 **main 的 push** 上执行；PR、其他分支和手工运行脚本不具备相同发布入口。worker 推送不重复运行本项目 CI。

同步使用 Actions 自带的 `GITHUB_TOKEN`，只在同步 job 授予 `contents: write`；测试 job 保持只读。**不需要向 GitHub 填 Cloudflare 密钥、Hub Token 或个人 PAT。** 后续组织/仓库策略若收紧，应检查同步 job 的实际权限，不使用全站密钥绕过。

旧的 `.github/workflows/deploy.yml` 已移除，GitHub 不再执行 `wrangler deploy` 或远程数据库迁移。旧 `ENABLE_CLOUDFLARE_DEPLOY` 开关不再被当前流程使用；即使以前配置过它，也不会激活一个已移除的 job。历史 Actions 运行记录可以保留。

## 同步保护

同步脚本为 `scripts/promote-worker.mjs`。它核对本地 checkout 与测试 SHA；推送的永远是该 SHA，不是重新拉取一个未经测试的新 main。

main 已继续向前时，旧任务显示 `skipped / main-advanced`，让较新的 main CI 负责发布。worker 已相同则为 `current`，不重复推送。worker 存在不在该 main 提交历史中的改动时停止，**绝不 force push、重置或自动合并**。推送前再次检查 main，推送时由 Git 的非强制更新检查阻止回退；竞态失败会明确报错。

同步 job 使用独立的串行 concurrency group，不因新的同步 job 到来而取消正在执行的推送。Actions 对待执行任务的排序不保证先后，因此仍保留 SHA、祖先关系和远端二次检查。这里是自动化自身的保护，不等于已给每个仓库设置管理员分支保护规则；不要手工往 worker 塞入独有改动。

Actions 摘要记录 `created / promoted / current / skipped`、测试 SHA 及原 worker SHA。**这个结果只说明 GitHub 分支同步，不代表 Cloudflare 已上线。**

## 日常使用

正常在 main 或临时功能分支开发，检查差异后合入 main；不要直接修改 worker。主流程会自动同步通过检查的提交，不需要每次手动创建分支或合并。纯文档改动也走检查和同步，不通过路径过滤绕过发布规则。

```bash
git switch main
git pull --ff-only
# 修改后运行测试，再正常提交推送
npm run check
git push origin main
```

main 和 worker 正常情况下指向同一个通过检查的提交；当 main 正在测试或测试失败时，worker 保持上一个可发布版本。需要恢复时，应在 main 正常提交修复或 revert 后重新通过 CI，不直接强推 worker 回退。数据库和 R2 数据不随 Git/Worker 代码回退自动恢复。

## Cloudflare 后续连接（不是本次已完成事项）

用户授权配置 Cloudflare 时，连接这个仓库，并设置：

| 设置 | 值 |
|---|---|
| 生产分支 | **worker** |
| 项目根目录 | 仓库根目录 |
| 非生产分支 Preview Builds | 个人使用先关闭 |
| Node | 满足 package.json 的 >=22.16，选受支持的22/24版本 |
| 构建命令 | `npm run check` |
| 部署命令 | `npm run db:migrate && npm run deploy`（完成实际绑定后） |

Cloudflare 的生产分支监听是独立外部集成，不依赖 worker 再跑一次 GitHub Actions。GitHub 官方说明 GITHUB_TOKEN 产生的 push 不会递归触发新的 Actions 工作流；**Cloudflare 的实际监听仍须在连接后验证**：确认构建收到 worker 分支的对应 SHA，而不是仅检查 GitHub 同步成功。不要为了让 GitHub 再跑一遍而向公开仓库配置高权限个人 PAT。

首次仍必须建立/核对 D1 与私有 R2，准备统一生产配置。当前模板中的 D1 ID 不能原样部署。不要只在 worker 分支修改生产配置，否则分支将分叉；配置应在 main 统一维护并经 CI 同步，或由 Cloudflare 构建环境生成配置。部署配置不包含真实密码/Token。迁移使用同一目标 DB；失败时不要继续部署。之后的自动部署不得初始化/重置账号、清库或自动签发 Token。

只配置 GitHub 并不会修改 Cloudflare 的生产分支、授权 GitHub App 或创建云资源。完成首次 Cloudflare 连接时另按 [SETUP](SETUP.md) 与 [AI_DEPLOY](../AI_DEPLOY.md) 操作；这两项不能混报。

## 故障定位

| 状态 | 处理 |
|---|---|
| 测试失败 | 修复 main；worker 保持不变 |
| 同步被跳过 | 检查是否为 main push、是否 main 已前进、所有依赖是否成功 |
| 同步403/推送失败 | 检查 Actions 写权限、GitHub规则与远端状态；不自动强推 |
| worker 分叉 | 将需要的改动正常合回 main，再重新验证；不要删除远端历史 |
| CI通过但worker未更新 | 在本次 main 运行中重新运行失败/同步 job；仍核对测试 SHA；旧任务在main前进后会跳过 |
| worker已同步，Cloudflare无构建 | 检查 Cloudflare 是否已连接、生产分支是否worker、预览/构建规则和GitHub App授权 |
| Cloudflare构建失败 | 检查绑定、Node与命令、迁移和构建日志；不要把分支同步称为已上线 |

## 源码不等于 Skills

`git push` 保存程序源码；`cloudskill publish` 将技能送到自己的 Hub。不要把真实技能里的凭据、网页登录密码、Cloudflare密钥或Hub Token提交到这个公开源码仓库。初始化仍只保存仓库外 web-admin.json，Token由本人在网页手动签发。

参考：[GitHub jobs.needs / permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) · [GITHUB_TOKEN事件](https://docs.github.com/en/actions/concepts/security/github_token) · [Cloudflare构建分支](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)。保留 [MIT LICENSE](../LICENSE) 和项目原有来源说明。

## 令牌再次查看的生产 Secret

0.4.2新增运行时Secret TOKEN_ENCRYPTION_KEY和迁移0006。首次部署在Cloudflare Worker设置这个长期Secret；不放GitHub Actions、不提交wrangler vars、不仅放在Cloudflare Build环境变量。自动构建不得重新运行随机密钥生成，也不得将它按一次性bootstrap删除。每次部署仍使用同一密钥，D1迁移只增量应用；创建方式和恢复规则见 [TOKEN_VIEW](TOKEN_VIEW.md)。这里是部署要求，不表示本次已经操作生产账号。
