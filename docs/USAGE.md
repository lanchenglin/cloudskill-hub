# 日常使用：A 发布，B 手动更新

管理员必须先完成首次强制改密，才能创建项目和签发 A/B Token。默认 admin / lanchenglin 仅是初始登录，不能用来长期管理仓库。

本项目只需要部署一个 Hub。网站管理员用账号密码管理；AI/CLI 用各自的 Token。首次安装见 [SETUP.md](SETUP.md)，权限见 [AUTH.md](AUTH.md)。

## 1. 两种凭据，不要混用

管理员网页账号不会交给每套 Hermes。A 使用 `publisher` Token，B 使用 `client` Token；两种 Token 都限定项目、可到期和撤销。旧全权限 admin API Token 仅兼容保留，正常新部署不需要它。

```bash
cloudskill login https://skills.example.com
cloudskill whoami
cloudskill projects
cloudskill list
```

客户端提示输入访问 Token，输入不回显。`CLOUDSKILL_TOKEN` 可用于非交互登录；只能通过已授权的环境/私有文件提供，不把实际值硬编码到命令、聊天、Skill 或 Git。

## 2. A 修改后发布

假设 Hub 已有 personal 项目，技能 name 是 my-skill：

```bash
cloudskill publish personal "$HOME/.hermes/skills/my-skill" --private
# 也可以发布准备好的目录或 ZIP
cloudskill publish personal ./my-skill --private
cloudskill publish personal ./my-skill.zip --private
```

一包一个 Skill，根目录必须有 SKILL.md。A 的来源目录不要求由 CloudSkill 安装。相同内容不重复增加版本。发布者只能发布授权项目的私有内容，不能通过 --public 公开，也不能修改已公开的技能；这类操作交给网页管理员。

## 3. B 首次安装，以后按需更新

```bash
cloudskill install personal/my-skill --agents hermes
cloudskill update
```

update 更新本设备已通过 CloudSkill 安装的技能，不自动安装所有新增技能。需要接收某项目新增内容时：

```bash
cloudskill subscribe personal --agents hermes --skills '*'
cloudskill sync --dry-run
cloudskill sync
```

subscribe 只记录订阅；sync 只下载，不自动上传改动，也不启动后台任务。B 有发布权限并明确执行 publish 时也能回传。

## 4. Claude / Codex 及多套 Hermes

```bash
cloudskill install personal/my-skill --agents claude
cloudskill install personal/my-skill --agents claude,hermes
```

当前目录实现：

| Agent | 默认安装根 | 环境变量 |
|---|---|---|
| Claude Code | ~/.claude/skills | CLAUDE_CONFIG_DIR |
| Hermes | ~/.hermes/skills | HERMES_HOME |
| Codex | ~/.codex/skills | CODEX_HOME |

上述是当前代码路径，不承诺所有 Agent 版本都会加载。Codex 等工具可能使用其他发现路径，须按真实客户端验收；这次认证改造没有改变安装目录，也没有新增任意工具适配。

同机同用户多套 Hermes，**每套同时隔离 HERMES_HOME 和 CLOUDSKILL_CONFIG_DIR**。不要让两个配置操作同一个安装目标：

```bash
# 示例：运维 Hermes。整个使用期间保持这组变量一致。
export HERMES_HOME="$HOME/hermes-ops"
export CLOUDSKILL_CONFIG_DIR="$HOME/.config/cloudskill-ops"
cloudskill login https://skills.example.com
cloudskill subscribe personal --agents hermes --skills '*'
cloudskill sync
```

另一套使用不同目录和单独 Token，不覆盖真实 Hermes 配置。Windows PowerShell 对应 `$env:HERMES_HOME=...`、`$env:CLOUDSKILL_CONFIG_DIR=...`。容器把配置和技能目录挂载为自己的持久卷。

## 5. 冲突、备份和删除

B 本地改过同一技能时默认拒绝覆盖；先比较，再决定保留哪份。两端都编辑时不自动合并，也不要把上传期间的并发保护当作完整多端编辑基线。

确认要放弃本地修改后，`--force` 可替换**已托管**的技能或恢复已删除的托管目录；不会接管未知来源同名目录。替换前备份留在 Agent 根的 `.cloudskill-backups/`，不放在可加载技能目录中。备份默认不自动删除。

`cloudskill check` 检查版本及本地修改，`--dry-run` 预检不下载 ZIP。`cloudskill status` 上报安装清单，不执行技能。CLI 使用同一配置目录的操作锁；异常遗留锁先确认没有运行进程，不要盲目删除。

## 6. Token 到期与网页改密码

个人长期使用可以在网页“访问权限 → 签发访问令牌 → 有效期”选择 **永久有效（直到手动撤销）**。A 的发布 Token 和 B/C 的只读 Token 都支持；列表会显示“永久有效（可手动撤销）”，不是“旧令牌未设到期时间”。保留 30 / 90 / 365 天，默认仍为 90 天。

永久令牌不会仅因超过一年而失效，但手动撤销仍会阻止之后的 API 请求。已经有期限的 Token 不会自动延期；需要永久时新建并让该设备重新 `cloudskill login`，验证成功后再撤销旧 Token。其他设备不受影响。网页登录会话仍独立过期，修改密码仍撤销浏览器会话，**不更换 A/B 的 Token**；疑似泄露时撤销对应 Token，或明确执行“撤销全部客户端 / API 令牌”。

`cloudskill logout` 仅移除本地配置中的凭据，不撤销服务器 Token。网页退出则会撤销该浏览器会话，这两种退出不要混淆。

## 7. 文件限制与隐私

`cloudskill limits` 查看服务器上限。默认总计 50 MiB、单文件 20 MiB、1000 文件、ZIP 55 MiB。支持 STORE/DEFLATE 输入，不支持加密 ZIP、ZIP64、软链接和危险路径。隐藏 .env/.ssh/.git 路径仍被拒绝。

普通文件中的真实凭据会随包分发，并进入历史和备份；账号密码登录不等于独立凭据保险库。始终保持私有，不把凭据写进公开 name/description 或公开 Git 示例。Token 被撤销不能收回已下载文件；泄露的服务密钥需要在原服务撤销/更换。

配置文件在 Unix 以 0600 保存，Windows 依赖用户目录和 ACL；同一系统用户运行的进程仍可读取，不能宣称端到端加密。

## 8. 上传中断

```bash
cloudskill uploads
cloudskill uploads up_YOUR_SESSION_ID
cloudskill publish personal ./my-skill.zip --private --resume up_YOUR_SESSION_ID
cloudskill cancel-upload up_YOUR_SESSION_ID
```

会话归创建它的身份所有。重新上传同样内容前先确认状态，避免重复发布；已上传完整包可以复用会话，部分中断要重传完整 ZIP，不是字节级续传。恢复时仍核对私有/公开选择。

公开 well-known 只暴露管理员显式公开的技能；私有分发使用 cloudskill，不把 Token 拼进 URL。程序源码提交、Hub 部署和 Skill 发布是三件不同的事。
