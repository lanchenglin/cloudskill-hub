# GitHub 源码仓库与可选部署工作流

当前项目源码仓库：[`lanchenglin/cloudskill-hub`](https://github.com/lanchenglin/cloudskill-hub)，使用 `main` 当前版本。仓库已经建立，**无需重新 `git init`、另建仓库或强推覆盖历史**。

项目还没有在实际使用的 Cloudflare 账号完成首次部署；先按 [SETUP.md](SETUP.md) 手动完成初始化，再考虑自动部署。

## 源码提交不等于技能同步

| 操作 | 去向 | 内容 |
|---|---|---|
| `git commit` / `git push` | GitHub 程序源码仓库 | Worker、网页、CLI、测试、部署模板、文档 |
| `cloudskill publish personal <目录> --private` | 自己的私人 Hub | Skill 文件到 R2，项目和版本元数据到 D1 |
| `cloudskill update` / `sync` | 从私人 Hub 到当前设备 | 拉取托管/订阅范围内的技能 |

日常 A 修改技能、B 手动更新，不需要提交 GitHub。不要把真实技能凭据、Cookie、私钥或 Token 放进这个公开仓库，包括 `examples/`、测试样例、Issue、提交信息和日志。

## 继续开发源码

```bash
git clone https://github.com/lanchenglin/cloudskill-hub.git
cd cloudskill-hub
npm install
npm run check
```

已持有源码时直接进入目录。正常在新分支开发、检查差异和测试后提交；不要用强推重写已有 `main`。

当前 MIT 许可证和来源说明继续保留。公开程序源码不会自动公开私有 R2 中的技能内容，但自己提交到 Git 的文件会受 GitHub 仓库可见性约束。

## 两个 GitHub Actions 工作流

**`ci.yml`：测试。** 推送或 PR 会触发 Ubuntu / Windows、原生本地 workerd/D1/R2 和 Chromium 检查。通过测试不表示已经上线 Cloudflare。

**`deploy.yml`：可选部署。** 首次使用保持不开启。它需要实际资源绑定、初始化 Secret 和部署授权；不会替你自动建立完整生产环境或保存网页管理员令牌。

首次手动部署成功、准备交给 GitHub 后续部署时，才配置：

| 位置 | 名称 | 用途 |
|---|---|---|
| GitHub Actions Secrets | `CLOUDFLARE_API_TOKEN` | Cloudflare 部署权限，不是 `csh_` 开头的 Hub 令牌 |
| GitHub Actions Secrets | `CLOUDFLARE_ACCOUNT_ID` | 目标 Cloudflare 账号 |
| GitHub Actions Variables | `ENABLE_CLOUDFLARE_DEPLOY` | 明确设为 `true` 才启用部署 job |
| `wrangler.jsonc` | 真实 D1 ID / R2 桶名 | 指向已经建立的资源 |
| Cloudflare Worker Secret | `BOOTSTRAP_SECRET` | 首次网页初始化使用，不提交到 Git |

工作流顺序为安装依赖、测试、应用数据库 SQL、部署 Worker。启用开关后，匹配工作流路径规则的 `main` 推送可能部署；只修改 README/docs 不在当前部署路径触发范围内。此说明更新不设置任何 Secret、不启用部署开关，也不执行生产部署。

## 版权与参考

实现思路参考 skillsgist、Agent Skills、skills-handler 和 Hermes 的公开约定，项目本身独立实现，不依赖 skillsgist 的程序运行。保留 [LICENSE](../LICENSE)；未来引入第三方代码或资产时应检查许可证并保留要求的说明。
