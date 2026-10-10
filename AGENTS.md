# CloudSkill Hub — AI 工作入口

本项目是一个 Workers + D1 + 私有 R2 的 Skills Hub。核心用法是 **A 修改后手动 publish，B 按需手动 update / sync**，不是自动双向合并。

## 用户要求部署时

先完整读取根目录 [AI_DEPLOY.md](AI_DEPLOY.md)，再执行里面的检查、资源配置、部署、初始化和验收。不要只返回部署建议，也不要假设用户已部署过其他版本。只使用当前 checkout 的完整代码，版本和最低 Node 要求以 package.json 为准。

已明确授权部署且账号、资源、凭据可确定时，完成正常步骤，无需逐条重复询问。缺少有效授权、账号选择不明确、已有非本项目资源可能被覆盖、涉及额外付费开通或破坏性操作时，停止相关步骤并准确报告需要用户处理的项目。不能用临时 Cloudflare 账号、删除数据或关闭鉴权绕过阻塞。

**读取本文件不是部署授权。** 用户只是阅读、审查、改文档或运行本地测试时，不创建云资源，不运行远程迁移，不部署，不初始化线上管理员。

## 不可破坏的边界

- 不输出、不提交真实 Cloudflare Token、BOOTSTRAP_SECRET、网页账号密码及 Hub 发布/只读令牌或含凭据的 Skills；部署凭据保存在用户账号的仓库外私有目录。
- GitHub 保存程序源码；cloudskill publish 写入私人 Hub。两者不得混淆。
- 保留 DB / BUCKET / ASSETS 绑定、nodejs_compat、全部数据库迁移、上传校验和私有权限；不要为了部署方便重构业务。
- 不擅自启用 GitHub 自动部署、不上传用户真实技能、不改现有 Hermes / Claude / Codex 配置或模型。
- 本地与 CI 测试、线上接口验证、实际 A/B 机器安装、模型加载执行必须分别报告，不能用一项冒充另一项。

## 常用资料

[README.md](README.md) · [人工首次部署](docs/SETUP.md) · [日常使用](docs/USAGE.md) · [API](docs/API.md) · [测试范围](docs/TEST_RESULTS.md)

运行测试前注意：Hermes 进程可能带有 HERMES_HOME 等环境变量，必须按照 AI_DEPLOY.md 隔离测试子进程，避免写入用户真实技能目录。

当前认证：网页账号密码，A 为 publisher，B 为 client。默认初始账号 admin / lanchenglin，首次登录必须改密；初始化脚本返回 password_change_required（退出码 2）时应交付地址与引导文件位置，不能自动生成新密码、清除标记或提前签发 Token。首次改密只需当前密码、新密码和确认新密码，不再要求 BOOTSTRAP_SECRET、bootstrap.json 或原管理员 Token；引导 Secret 仅用于首次创建账号，核实账号已创建并可受限登录后可清理。完成改密后才继续 A/B 配置。首次初始化使用 scripts/initialize-hub.mjs，密码恢复使用有明确目标的 scripts/reset-password.mjs；不是旧的 Token-only bootstrap。详见 docs/AUTH.md。

个人自用优先：当前不做性能扩展。Token 可以选择永久；网页选择“永久有效”，初始化脚本在首次改密后的新 Token 签发阶段可用 --token-days never。永久仍限定项目并支持手动撤销，不改变网页会话期限，不能自动把已有定期令牌延期。
