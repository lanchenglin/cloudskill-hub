# 将 CloudSkill Hub 发布为你自己的开源 GitHub 项目

本项目不是 `Qsnh/skillsgist` 的 fork，源码独立实现，可直接使用 MIT 许可证公开发布。

## 新建公开仓库

在准备好的项目文件夹中执行（先安装并登录 GitHub CLI）：

```bash
gh auth login

git init -b main
git add .
git commit -m "feat: release standalone CloudSkill Hub v0.1.0"

gh repo create YOUR_ACCOUNT/cloudskill-hub --public --source=. --remote=origin --push
```

如果需要先保密开发，将 `--public` 替换为 `--private`，验收完成后再改成公开。

## Cloudflare CI/CD

- `ci.yml`：推送或 PR 自动执行本地测试。
- `deploy.yml`：默认**不会部署**。需要 Cloudflare 账号已经创建 D1/R2 并部署过，且修改 `wrangler.jsonc` 的真实 D1 database_id。
- GitHub Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。
- GitHub Variables：`ENABLE_CLOUDFLARE_DEPLOY=true` 后才启用主分支自动发布。
- 首次 Cloudflare 部署务必先执行 README 中的 Secret 设置与数据库迁移，GitHub 仓库不存储管理员 API token、BOOTSTRAP_SECRET 或客户端凭据。

## 版权与上游说明

`CloudSkill Hub` 以 Agent Skills 标准为兼容目标，参考 skillsgist、Vercel skills-handler 和 Hermes 的公开接口/产品思路，没有导入它们的源码、Logo、字体或素材。未来引入第三方代码或资产时应检查其原始许可证并添加 NOTICE 说明。
