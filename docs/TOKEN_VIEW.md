# 访问令牌再次查看

## 使用

管理员登录 → 访问权限 → 令牌列表 → 查看 / 复制。新签发的“修改共享技能”和“修改全部技能”Token均可查看，无论永久或定期。页面默认隐藏值，显式查看后可复制、隐藏；60秒后、切到其他页面或标签页、退出时清除页面明文。刷新或重新登录后可以再次查看，不依赖浏览器本地保存。

查看不会替换Token、变更权限、延长有效期。过期/已撤销值仍可核对，但接口返回active:false，不能继续授权。系统剪贴板独立于网页，复制后不会由网页自动清除。

## 存储方式

访问鉴权仍查询token_hash。新迁移0006为access_tokens增加token_ciphertext，用AES-256-GCM加密：每条值用随机12字节IV、128-bit认证Tag；附加认证数据包含记录ID和认证摘要。密文不能直接复制到另一条记录解开。

独立运行时Secret TOKEN_ENCRYPTION_KEY为32随机字节的64位十六进制，不和密文存于D1，不由公开固定值或管理员密码派生。修改/恢复管理员密码不改变令牌加密密钥。此功能不是Skill内容保险库，也不是零知识或端到端加密；有Worker运行权限及密钥的代码仍能解密。

列表只有recoverable标志，不返回全部明文、密文或认证哈希。仅网页管理员有效会话可以POST显式查看一条，沿用同源、CSRF及已有近期验证；shared_writer/all_writer/旧API管理员Token都不能读取此接口。返回private/no-store，审计只有令牌ID，没有值。

## 首次配置（一次，不是每次登录或每次构建）

核对目标Worker、既有Secret与数据；只有确认没有既有加密数据/密钥的首次实例，才生成新密钥。合法部署AI照AI_DEPLOY.md执行即可，不要求用户在日常页面手填密钥。

```bash
# 仓库外私有目录。只生成或复用本地文件，不打印值，不访问Cloudflare。
node scripts/prepare-token-key.mjs --credentials-dir /PRIVATE/DEPLOY-DIR

# Worker已存在、已核对目标、确认首次配置后，再通过合法授权写入Secret。
npx wrangler secret bulk /PRIVATE/DEPLOY-DIR/token-encryption.json --config /PRIVATE/DEPLOY-DIR/wrangler.json
```

token-encryption.json目录0700、文件0600；Windows应核实ACL。远端已存在而本地缺失，先找原备份，不运行新的随机值覆盖。开发环境使用独立测试值，写入不入库的.dev.vars；CI/native smoke使用隔离随机测试值。

**TOKEN_ENCRYPTION_KEY需要长期保留和备份，不能像BOOTSTRAP_SECRET一样删掉。** 主分支CI→worker同步不携带生产密钥；Cloudflare自动部署保留同一运行时Secret。不要只放在构建环境变量，也不要每次构建生成新的密钥。

## 旧令牌与故障

旧版本只保存单向哈希的Token无法还原；原值、权限、撤销和到期状态均不变，列表会标明“未保存可恢复副本”。需要可查看的新令牌时，管理员手动签发并更新客户端，再按需要撤销旧令牌；程序不替用户做这些操作。

缺失/格式错误的密钥返回503 token_key_unavailable，禁止签发新Token，不悄悄退化为只能看一次。错误密钥、密文损坏或记录不匹配返回503 token_decryption_failed；恢复原密钥和对应备份，不生成新密钥覆盖。旧hash-only查看返回409 token_value_unavailable。

密钥丢失不会使仍有效的Token摘要鉴权失效，但不能从密文还原其值；恢复需要原密钥。D1和密钥应分别安全备份。不要在没有完整重新加密方案时轮换这个Secret。查看旧/已撤销值不会复活任何Token。

## 版本与边界

本功能版本0.4.2，升级需要增量应用0006；空库执行0001–0006全部迁移。应用不能替你从旧哈希中找回Token，也不会重置管理员密码或自动公开私有Skills。首次登录强制改密、6–20字符、两种手动签发权限和永久有效选项保持原规则。
