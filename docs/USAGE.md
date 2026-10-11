# 日常使用：共享无需 Token，修改由你授权

只部署一个 Hub，其他环境主动连接。网页管理员管理分类、可见性和 Token；客户端不会自动获得管理员权限。

## 网页操作指引 / 发给 AI 的话

登录后打开侧栏“使用说明”；公开阅读地址是部署站点的 `/usage.html`，纯文本给 AI 的地址是 `/usage.md`。登录页、共享页也有入口，不需要先登录才能阅读。

先选择工具、任务和访问方式，再从已有技能中选择或填写真实的分类英文 ID、技能 ID。页面自动带入当前站点地址。点击“复制给 AI”，把说明发给具有目标机器终端、文件和网络权限的 AI 执行。页面本身不替你运行安装、发布或部署。

技能详情的“让 AI 安装”会自动填入这一个技能；私有技能的信息只留在本次后台页面，不放进公开链接，退出后清除。匿名说明页只读取公开 catalog，加载失败仍可手动填 ID。

没有填完整 ID 时，生成的话只让 AI 列出可选技能，不给出猜测的安装命令。私有访问使用“修改全部技能”Token，令牌在本机隐藏登录提示输入或提前安全注入 `CLOUDSKILL_TOKEN`；不要放进聊天。UI 不读取或复制真实令牌。

四种任务：安装仅选择的技能；订阅分类会改变同分类订阅，随后 sync 处理当前配置的全部订阅；update 处理当前配置全部已托管技能（没有 --agents 过滤）；publish 上传你指定目录/ZIP，不是提交到 GitHub。页面有范围提醒和预检查命令，失败必须停止。

Windows 选择 PowerShell，Linux/WSL/macOS 选择 Bash；只对命令参数做相应引用，不擅自改变机器和实例。现有 Codex 适配器与其他工具发现目录的边界仍以下文为准，本轮没有变更 CLI 路径。

## 1. 每个环境安装 CLI

```bash
git clone --branch worker --single-branch https://github.com/lanchenglin/cloudskill-hub.git
cd cloudskill-hub
npm link --omit=dev --ignore-scripts
cloudskill --help
```

CLI 运行使用 Node 内置模块，不必安装 Wrangler 或部署服务端。无需 sudo，也不必把网页登录密码交给 Hermes。`npm link` 不适合当前环境时，直接用 `node cli/cloudskill.mjs ...`。

## 2. 仅使用共享内容，不签发 Token

```bash
cloudskill connect https://YOUR-HUB
cloudskill list
cloudskill install personal/example --agents hermes
cloudskill update
cloudskill subscribe personal --agents hermes --skills '*'
cloudskill sync
```

`connect` 保存地址和匿名模式，不需要任何密钥。网站 `/shared.html` 也可匿名浏览、下载。共享就是公开可读，不是限定自己的设备；共享页面不会发送浏览器管理员凭据。

`update` 更新已托管技能；订阅后 `sync` 也能安装新增的共享技能。它们都由你手动执行，不是自动互推。匿名连接不上报设备，不允许 publish；无效写入 Token 会报错，不自动降级为匿名。

## 3. 修改内容时才去网页签发

网页“访问权限” → “新建令牌” → 填备注 → 选择以下一种 → 选择有效期 → 生成。以后仍可在列表中“查看 / 复制”。

| 类型 | 允许 | 不允许 |
|---|---|---|
| 修改共享技能 `shared_writer` | 跨分类读取、新建、更新、回滚共享技能 | 读取/修改私人内容、将私有改为共享、将共享隐藏、网站管理 |
| 修改全部技能 `all_writer` | 跨分类读取、推送、更新、回滚共享与私有技能，明确切换可见性 | 网站账号管理、分类管理、签发/撤销其他 Token |

不勾选项目、不预分配 A/B/C，不需要公共只读 Token。备注和分发给哪些实例由你决定。项目分类请先在网页“项目分类”页面建立。

有效期保留 30 / 90 / 365 天和永久；API 定期可为 1–365 天。不主动选择仍为 90 天。永久直到手动撤销，不延长网页登录会话。新签发不会改变旧 Token。

```bash
cloudskill login https://YOUR-HUB
# 在隐藏输入提示中粘贴自己签发的 Token
cloudskill whoami
cloudskill publish personal ./shared-skill --public
# 以下命令需要修改全部 Token：
cloudskill publish personal ./private-skill --private
cloudskill install personal/private-skill --agents hermes
```

同一 Token 可交给多套受信任工具；分别签发便于单独撤销，但不是必须按设备绑定。要拉取私有内容，当前使用修改全部 Token；此模型没有新增私有只读 Token。

已有技能省略可见性时保持原值；新建时共享修改 Token 默认共享，全部修改 Token 默认私有。推荐显式参数避免混淆。共享修改 Token 不能读取以前的私有版本；共享改回私有后，访客和共享 Token 都无法继续读取。已经下载的副本不能收回。

## 4. 多套 Hermes / Claude

每套运行环境自己执行登录或匿名 connect，不互相自动覆盖。全局目录仍按当前适配器使用：

| Agent | 目录 | 配置 |
|---|---|---|
| Hermes | `~/.hermes/skills` | HERMES_HOME |
| Claude Code | `~/.claude/skills` | CLAUDE_CONFIG_DIR |
| Codex（现有目录适配器） | `~/.codex/skills` | CODEX_HOME |

本次没有改 Agent 路径矩阵；实际 Codex/Hermes 版本是否发现应另行验证，不以文件复制成功冒充模型执行成功。

同一系统用户运行多套 Hermes 时，每套同时隔离 `HERMES_HOME` 与 `CLOUDSKILL_CONFIG_DIR`。例如：

```bash
export HERMES_HOME="$HOME/hermes-dev"
export CLOUDSKILL_CONFIG_DIR="$HOME/.config/cloudskill-hermes-dev"
cloudskill connect https://YOUR-HUB
# 需要私有或写入权限时改为 cloudskill login
```

更新前可以 `cloudskill check` / `cloudskill sync --dry-run`。本地改过时拒绝覆盖；明确放弃修改才使用 `--force`，并且它不会接管未知同名目录。备份在 Agent 根目录的 `.cloudskill-backups/`，不是 Skills 加载目录。

## 5. 凭据和维护

含真实凭据的技能保持私有。共享页面与 well-known 端点对所有人可读。`.env` 等路径仍被拒绝；本次没有新增凭据保险库、自动文件排除、永久删除或自动清理备份。

`cloudskill logout` 只删除当前本地凭据，不撤销服务器 Token。网页撤销才阻止后续访问；改网页密码不会自动撤销 Token。旧 Token-only/项目限定令牌可继续按原权限使用，但不再新签发，也不自动升权。

其他已知使用问题见 [ROADMAP](ROADMAP.md)，权限/API 见 [AUTH](AUTH.md) / [API](API.md)。

## 令牌不用只复制一次

登录网页 → 访问权限 → 令牌列表 → 查看 / 复制。新签发的两种 Token 都支持重复查看；刷新、退出后重新登录、修改管理员密码不会让已保存的新令牌值消失。页面不默认列出所有明文，可手动隐藏，60秒后也会隐藏，之后可再点查看。

查看不重置 Token，不影响其他设备；已经过期/撤销时仍标注无效，不会因查看而恢复。老版本只保存哈希的令牌没有可恢复原值，会给出明确提示，不替你自动换 Token。部署者需一次性配置长期 TOKEN_ENCRYPTION_KEY，详见 [TOKEN_VIEW](TOKEN_VIEW.md)；日常查看不需要输入这个密钥。

## 网页布局与退出

访问权限只处理令牌，列表在页面主体，提供备注、权限、状态筛选与有效数量统计。新建表单在弹窗中，默认90天、可选永久，两种权限不变；已有令牌值仍可重复查看。过期与已撤销状态独立显示，查看不会恢复授权。

分类在“项目分类”中创建，网页密码在“账号设置”中修改。顶部账号入口可打开账号设置；旁边的“退出登录”在手机也可用，向下滚动后仍可见。账号设置里也有“退出当前登录”。

普通退出只撤销本浏览器会话，已登录的其他浏览器及 CLI Token 不因此失效。上传中退出先确认；取消退出继续上传，确认会中断当前上传，不删除已发布版本。网络失败提示“退出未完成”，不要误以为本地隐藏界面等于远端退出。

“撤销全部令牌”放在访问权限底部的高风险操作区，需要展开并确认；不要将它作为普通退出操作。密码长度6–20、首次强制改密、令牌再次查看和 main→worker 发布流程不变。
