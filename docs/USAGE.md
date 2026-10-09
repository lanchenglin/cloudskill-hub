# A 发布、B 手动更新：日常使用

本项目的主要流程是 **A 修改 Skill → A 手动发布到私人 Hub → B 自己执行更新**，不是自动双向同步。

开始前先完成 [首次部署](SETUP.md)：Hub 已上线、网页创建了 `personal` 项目，A/B 各自安装并登录 CLI。下面的 `my-skill`、域名和目录都应换成自己的实际值。

## 1. A 修改完成后发布

Linux / WSL，默认 Hermes 目录：

```bash
cloudskill publish personal "$HOME/.hermes/skills/my-skill" --private
```

Windows PowerShell，默认目录：

```powershell
cloudskill publish personal "$HOME\.hermes\skills\my-skill" --private
```

任意准备好的技能目录或 ZIP 也可发布：

```bash
cloudskill publish personal ./my-skill --private
cloudskill publish personal ./my-skill.zip --private
```

目录里必须有 `SKILL.md`，frontmatter 的 `name` 与技能名一致。例如：

```markdown
---
name: my-skill
description: Describe when and how this skill should be used.
---
# My Skill
Write the instructions here.
```

可以一并包含 references、scripts、assets 和 Hermes metadata。每次 `publish` 发布一个 Skill，不是上传全部 `.hermes`；本地目录不要求由 CloudSkill 创建。当前发布需要管理员令牌。

新内容发布为新版本，相同规范 ZIP 内容重复发布不新增版本。`publish` 不会推送 GitHub 源码，也不会自动操作 B。省略可见性参数时，新 Skill 私有、已有 Skill 保留原可见性；私人使用建议每次明确加 `--private`。

如果 A 是平时用于编辑的源目录，继续用它发布即可，不必对这个源目录再执行下行 `update`。发布不会把任意源目录自动登记为受 CloudSkill 管理的安装目录，也不会保证将已有安装目录的本地修改记录重置。发布和接收是两个独立操作。

## 2. B 首次安装与后续更新

```bash
# 第一次安装
cloudskill install personal/my-skill --agents hermes

# 可选：先看是否有更新或本地修改
cloudskill check
cloudskill update --dry-run

# A 发布新版本后，B 需要时手动执行
cloudskill update
```

`update` 按本地安装清单更新已经托管的技能，不安装仓库里从未安装过的其他技能，也不上传本地改动。B 只需要对应项目读取权限。`sync` / `update` 会检查本地指纹；版本和内容未变化时跳过 ZIP 下载。

## 3. B 也要接收 A 新建的技能

```bash
# 只设置一次：订阅 personal 项目全部技能
cloudskill subscribe personal --agents hermes --skills '*'

# 每次想同步时自己执行
cloudskill sync --dry-run
cloudskill sync
```

`subscribe` 只记录配置，不下载、不定时执行。`sync` 安装订阅范围内的新技能并更新已有技能，不进行后台自动同步或自动删除。

只选部分技能，或同时安装给 Claude Code：

```bash
cloudskill subscribe personal --agents claude,hermes --skills my-skill,another-skill
cloudskill sync
```

同一 CloudSkill 配置中，每个项目只有一条订阅；重新 `subscribe` 该项目会替换这条订阅的 Agent 和技能选择，不是追加。取消某个订阅选择也不会自动删除已经安装的技能。

## 4. 多台机器与同机多套 Hermes

不同机器或系统账号通常各自使用默认 HOME、CLI 配置和令牌即可。Windows 与 WSL 也作为不同环境管理，不要直接共用状态文件。

同一系统账号有多套 Hermes 时，需要同时设置：

- `HERMES_HOME`：这一套 Hermes 的**实际配置根目录**，CLI 在其 `skills/` 下安装。
- `CLOUDSKILL_CONFIG_DIR`：这一套 CloudSkill 独立的令牌、订阅及安装清单目录。

Linux / WSL 示例，在对应实例的终端分别执行，路径必须换成实际实例目录：

```bash
# Hermes B
export HERMES_HOME="$HOME/hermes-b"
export CLOUDSKILL_CONFIG_DIR="$HOME/.config/cloudskill-hub/hermes-b"
cloudskill login https://skills.example.com
cloudskill install personal/my-skill --agents hermes

# 以后在同样的环境变量下执行
cloudskill update
```

另一套 Hermes C 使用另一对目录：

```bash
export HERMES_HOME="$HOME/hermes-c"
export CLOUDSKILL_CONFIG_DIR="$HOME/.config/cloudskill-hub/hermes-c"
cloudskill login https://skills.example.com
cloudskill install personal/my-skill --agents hermes
```

PowerShell 写法：

```powershell
$env:HERMES_HOME = "$HOME\hermes-b"
$env:CLOUDSKILL_CONFIG_DIR = "$env:APPDATA\cloudskill-hub\hermes-b"
cloudskill login https://skills.example.com
cloudskill update
```

这些变量只告诉 CloudSkill 读写哪里，**不会创建 Hermes Profile，也不会替你配置或启动 Hermes**。实际运行的 Hermes 必须使用同一配置根目录。每次操作保持对应变量，不能只更换 `HERMES_HOME` 却继续复用另一个实例的安装清单；也不要让两个配置同时更新同一个目标。

## 5. 当前客户端安装路径

下表是当前代码的真实路径，不是对所有工具版本的加载保证：

| `--agents` 参数 | 默认安装目录 | 可指定配置根目录 |
|---|---|---|
| `hermes` | `~/.hermes/skills` | `HERMES_HOME` |
| `claude` | `~/.claude/skills` | `CLAUDE_CONFIG_DIR` |
| `codex` | `~/.codex/skills` | `CODEX_HOME` |

当前没有任意 Agent 插件适配或项目级安装。Claude 指本地 Claude Code，不同步 claude.ai 网页账号。Codex 路径由当前代码按 `CODEX_HOME/skills` 处理，需核对实际安装的 Codex 会扫描该目录，未验证时不要仅凭“安装成功”认定能加载。此轮只改文档，没有更改任何 Agent 路径实现。

CloudSkill 安装 Hermes 文件时不写 Hermes 自身的 `.hub/lock.json`，这些托管技能继续使用 `cloudskill update` 管理，不混用原生更新器。没有通过真实 AI 会话执行验收的部分见 [测试报告](TEST_RESULTS.md)。

## 6. 本地修改和恢复

B 本地也改过同一个技能时，默认更新会拒绝覆盖。先保存、比较或发布 B 的修改，再决定是否以仓库内容为准，不要把 `--force` 当日常默认参数。

确认需要覆盖已托管目录，或恢复被外部删除的托管目录时，可以显式使用：

```bash
# 只针对指定 Skill；本地内容可能被仓库版本替换
cloudskill install personal/my-skill --agents hermes --force
```

未知来源的同名目录即使有 `--force` 也不会直接接管。备份位于 Agent 配置根的 `.cloudskill-backups/`，不在可被扫描为技能的目录；暂无自动保留数量策略。

`publish` 的并发检查保护上传过程，不是多端长期编辑的自动合并。A/B 都要轮流编辑时，先拉取并核对最新文件再修改；两边都改过时先人工对齐，再由选定的一方发布。

## 7. 上传失败与手动重试

```bash
cloudskill uploads
cloudskill uploads up_YOUR_SESSION_ID
cloudskill publish personal ./my-skill.zip --private --resume up_YOUR_SESSION_ID
cloudskill cancel-upload up_YOUR_SESSION_ID
```

把示例会话 ID 换成命令实际返回的值。重试时使用同一项目、同一份文件和一致的可见性；不要通过恢复旧公开会话改变当前私有选择。

已经完整传好的 ZIP 可以复用会话继续提交；未完整上传需要重新传整个 ZIP，不能续传部分字节。上传进度到 100% 不等于已经提交发布成功。安全规则、配额和清理见 [上传设计](UPLOAD_V2.md)。

## 8. 凭据与权限边界

程序源码开源不意味着私人 Skill 公开。技能通过 Hub 进入自己的私有 R2，而不是 GitHub。但当前不是独立凭据保险库，普通文件中的 API Key 等会作为文件内容一起复制：

- `.env`、`.git` 等隐藏路径默认拒绝；不要为了通过检查简单改名绕过。
- `SKILL.md` 中的敏感文本可能随技能被 AI 读取。优先保留环境变量引用，真实值由受控环境提供。
- 含凭据的 Skill 保持 `--private`，不公开 R2 桶，不提交到公开源码、示例、Issue 或日志。
- 历史 ZIP、其他设备和本地备份可能还含旧凭据；删除最新版文本不等于删除全部副本。
- 撤销 Hub 令牌只阻止之后访问 Hub，无法收回已下载内容。泄露的第三方密钥还需在对应服务撤销或更换。

Hub 访问令牌也不要混用：A 发布需要管理员令牌，B/C 读取使用各自的只读令牌。当前没有限定项目的发布角色，不要把管理员令牌配置到所有不可信实例。

Linux/WSL 的 CLI 配置默认为 `~/.config/cloudskill-hub/`；Windows 默认为 `%APPDATA%/cloudskill-hub/`。Unix 配置文件权限设为 `0600`，但同一系统用户的程序仍可能读取；Windows 依赖用户权限和 ACL，没有专门的系统加密凭据存储。

`cloudskill logout` 仅删除本地登录配置，不撤销服务器令牌。丢失设备时，在网页撤销该设备使用的令牌，并评估技能内其他密钥的轮换需求。
