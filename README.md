# dsh-alicoupon

[![CI](https://github.com/yangguozhongmax-max/dsh-alicoupon/actions/workflows/ci.yml/badge.svg)](https://github.com/yangguozhongmax-max/dsh-alicoupon/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/yangguozhongmax-max/dsh-alicoupon?label=release)](https://github.com/yangguozhongmax-max/dsh-alicoupon/releases)
[![license](https://img.shields.io/github/license/yangguozhongmax-max/dsh-alicoupon)](LICENSE)

在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的侧边栏底部，和 cost-meter 的余额行并排显示**阿里云代金券剩余额度**。

```
千问学生券            ¥279.59        ← 本插件（点一下打开配置面板，悬停看面值/张数/更新时间）
今日  ¥9.8254
━━━━━━━━━━━  峰时 · 1 小时 47 分后进入平价
```

- 只用**只读**接口：阿里云 BSS `DescribeCoupon`（`business.aliyuncs.com`，`2023-09-30`，ACS3-HMAC-SHA256 签名）。
- 凭据存在 DSH 凭据库里，**永远不回传给浏览器**；接口响应只有余额、面值、张数、到期日。
- 宿主半边每 `refreshMinutes`（默认 1 分钟）重查一次；浏览器半边每 60 秒读一次宿主快照，页面重新可见 / 窗口聚焦时各读一次。
- 点那一行打开**配置面板**：改标签、改刷新间隔（落盘、立即生效）、立即刷新、**直接填/清除阿里云 AccessKey**
  （交给宿主写进 DSH 凭据库），以及看凭据每一项的状态。

## 别人下载后能直接用吗？

**代码装上就能跑，但「有数据」需要你自己的阿里云 AccessKey** —— 它查的是**你这个账号**名下的券，
不是公共数据。不需要登录 DSH 账号，也不需要 GitHub 账号；除了 `business.aliyuncs.com`，插件不连任何服务器。

| 你需要 | 说明 | 不需要 |
| --- | --- | --- |
| DSH 0.2.x（桌面 App 或 `dsh web`） | 插件分宿主 / 侧边栏两半 | — |
| Node ≥ 20.10 | 宿主半边用内置 `fetch`，**零依赖、不用 build** | npm 全局安装 |
| 一个**能看到那张券的**阿里云账号 | 券跟着账号走，换个账号就查不到 | 阿里云控制台密码、MFA、登录态、OAuth |
| 一个**只读** AccessKey（RAM 用户） | 权限只要 `bss:DescribeCoupon` | 任何写权限 |

### 五步装好（大约 5 分钟）

```bash
# 1. 拿代码（二选一）
git clone https://github.com/yangguozhongmax-max/dsh-alicoupon.git
npm install github:yangguozhongmax-max/dsh-alicoupon   # 装进任意目录也行，脚本按包目录找 profile

# 2. 挂进 DSH profile（幂等；--dry 先看，--unlink 撤销）
cd dsh-alicoupon && node scripts/link-into-profile.mjs desktop
```

3. **建只读 AccessKey**：阿里云控制台 → 访问控制 RAM → 用户 → 创建用户 → 访问方式只勾
   「使用永久 AccessKey 访问」→ 授权 `AliyunBSSReadOnlyAccess`（省事）或下面这条最小策略：
   ```json
   { "Version": "1", "Statement": [{ "Effect": "Allow", "Action": ["bss:DescribeCoupon"], "Resource": "*" }] }
   ```
   ID / Secret **只在创建时显示一次**，记下来。
4. **填凭据**（三选一，都不用重启）：点侧边栏那一行在面板里填 / 写
   `~/.dsh/.credentials.yaml` 的 `refs:` / 设环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID` 与
   `ALIBABA_CLOUD_ACCESS_KEY_SECRET`。
5. **重启 App**（宿主模块只在启动时 import），侧边栏就会出现那一行。体检：
   ```bash
   node scripts/doctor.mjs --port 50989   # 端口看 DSH 界面地址
   ```

### 没配好会看到什么

| 看到 | 含义 | 怎么办 |
| --- | --- | --- |
| `阿里云代金券 · 待配置` | 没读到 AK | 面板里填，或检查 `refs:` 键名 / 环境变量 |
| `阿里云代金券 · 查询失败` | AK 错、被删、或没授权 | 悬停看阿里云原话：`InvalidAccessKeyId` / `Forbidden`（缺 `bss:DescribeCoupon`） |
| `¥0.00` | AK 正常，但这个账号名下没有可用券 | 换**持有券的那个账号**的 AK |
| 侧边栏一行都没有 | 插件没挂上 / 客户端没注册 | 先跑 `doctor.mjs`，再看 `~/.dsh/storages/dsh-alicoupon/client.log` |

## 它怎么工作

```
┌─ 宿主（Node 侧，lib/index.js） ─────────────────────────────┐
│  ctx.credentials.resolve('ALIBABA_CLOUD_ACCESS_KEY_ID'…)    │
│  → fetchCoupons() 调阿里云 DescribeCoupon（只读）            │
│  → 内存缓存 refreshMinutes                                  │
│  → 只读 HTTP 路由 /plugins/dsh-alicoupon/state | /refresh    │
└─────────────────────────────────────────────────────────────┘
┌─ 浏览器（lib/client.js） ───────────────────────────────────┐
│  ctx.get('slots').inject('sidebar.footer.action',             │
│      () => slots.register({name:'sidebar.footer.action', …})) │
│  每 60s GET 一次 state 路由 → 渲染「标签 + 余额」             │
└─────────────────────────────────────────────────────────────┘
```

## 准备：一个只读的阿里云 AccessKey（上面第 3 步的详细版）

1. 在**能看到那张券的阿里云账号**里进「访问控制 RAM → 用户 → 创建用户」。
2. 访问方式**只勾「使用永久 AccessKey 访问」**（不要勾"控制台访问"，那是给人登录网页用的，还要密码 + MFA）。
3. 记下 AccessKey ID / Secret（**只在创建时显示一次**）。
4. 给这个用户授权（任选其一）：
   - 省事：`AliyunBSSReadOnlyAccess`（系统策略，含 `bss:Describe*`，覆盖 `DescribeCoupon`）；
   - 最小化：自定义策略，只允许 `bss:DescribeCoupon`。
5. 把凭据写进 DSH（任选其一）：

   - **装好本插件后点侧边栏那一行，在面板里填**（最省事：宿主会调用 DSH 凭据服务写进凭据库）；或
   - **凭据库文件** `~/.dsh/.credentials.yaml`：

     ```yaml
     refs:
       ALIBABA_CLOUD_ACCESS_KEY_ID: LTAI…
       ALIBABA_CLOUD_ACCESS_KEY_SECRET: …
     ```

   - 或者设成环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`（STS 临时凭据再加 `ALIBABA_CLOUD_SECURITY_TOKEN`）。

> 凭据名可以在配置里改（见下）。`refs:` 的键名必须正好等于环境变量名。
> 注意：**被环境变量遮蔽的 ref 是只读的**，面板改不动它。

## 安装（三种方式，任选其一）

> 只想快点用上：照上面「五步装好」做就行。这一节是三种安装方式的全集。

### 用仓库自带的脚本（推荐，幂等，两个 profile 都能用）

```bash
node scripts/link-into-profile.mjs                    # 默认 desktop
node scripts/link-into-profile.mjs web                 # 指定 profile
node scripts/link-into-profile.mjs desktop --copy      # 没权限建联结时改成复制
node scripts/link-into-profile.mjs desktop --dry       # 只看会做什么
node scripts/link-into-profile.mjs desktop --unlink    # 撤掉
```

它做两件事：把本包联到 `<profile>/node_modules/dsh-alicoupon`（Windows 用目录联接，免管理员；
Unix 用符号链接），并把 `"dsh-alicoupon"` 追加进 `<profile>/package.json` 的 `dsh.profile.bundles`
（改前备份 `package.json.dsh-alicoupon.bak`）。包自带的 `cordis.patch.yml` 负责把那一行插进插件树。

### Web profile（`dsh web`）：也可以走 CLI

如果 `dsh` 在你的 PATH 上（`dsh plugin --help` 能列出 `add`）：

```bash
dsh plugin --profile web add github:yangguozhongmax-max/dsh-alicoupon
dsh plugin --profile web add /path/to/dsh-alicoupon      # 本地目录
```

它内部用 pnpm 装包，并把包名写进该 profile 的 `dsh.profile.bundles`。

### 桌面 App（Electron）

桌面 profile 由 App 独占，CLI 会拒绝 `dsh --profile desktop`。三种办法：

1. **App 内安装**：设置 → 插件（Plugins）里安装本包（需要它能解析到包，本地目录/仓库都行）。
2. **用上面的脚本挂载**（推荐）：`node scripts/link-into-profile.mjs desktop`。
3. **纯手工**：等价于上面两步——放包 + 改 `dsh.profile.bundles`。

三种办法之后都要**重启 App**：热重载不会重新 import 已经加载过的宿主模块。

`<profile>` 通常是 `~/.dsh/profiles/desktop`（桌面 App）或 `~/.dsh/profiles/web`。

## 配置（可选）

三种改法，优先级从高到低：

1. **配置面板**（点侧边栏那一行）：改完写到 `~/.dsh/storages/dsh-alicoupon/config.json`，**立即生效、不用重启**；
2. 本 profile 的 `cordis.patch.yml`（覆盖同一 `id` 的行配置）；
3. 插件的默认值。

```yaml
- id: alicoupon
  label: 千问学生券        # 侧边栏那一行的标签（默认「阿里云代金券」）
  refreshMinutes: 1        # 宿主多久重查一次阿里云（默认 1）
  timeoutMs: 15000         # 单次请求超时
  credentialRefs:          # 用别的凭据名时改这里
    accessKeyId: ALIBABA_CLOUD_ACCESS_KEY_ID
    accessKeySecret: ALIBABA_CLOUD_ACCESS_KEY_SECRET
    securityToken: ALIBABA_CLOUD_SECURITY_TOKEN
```

```json
// ~/.dsh/storages/dsh-alicoupon/config.json —— 面板写的就这两个字段
{ "label": "千问学生券", "refreshMinutes": 1 }
```

面板同时会显示**凭据状态**：每一项的 ref 名、配没配、值来自哪一层（`file` / `env`…）、以及能不能被插件写入。
凭据可以直接在面板里填：**「保存凭据」走宿主的 `POST /credentials`**，由宿主调用 DSH 凭据服务写进
`~/.dsh/.credentials.yaml`（等价于手工改 `refs:`），写完**立刻查一次阿里云**，所以键贴错、Secret 不对、
缺 `bss:DescribeCoupon` 权限都会当场看到阿里云的原话。要点：

- 留空的字段 = 不改；要删掉已保存的值就点「清除已保存的凭据」。
- 密钥只在请求体里过一遍，不回显（保存后输入框清空），宿主响应里也没有密钥。
- 如果某个 ref 被环境变量遮蔽（状态显示「来源 env，只读」），凭据服务会拒绝写入——这时改环境变量，或先取消遮蔽。
- 想完全绕开面板也可以照旧手工改 `refs:` 或设环境变量。

路径可以用环境变量 `DSH_ALICOUPON_CONFIG` 顶掉（测试与多 profile 隔离用）。

侧边栏只注册**一行**（点它开面板）。本包不注册 `settings.section`：桌面 App 的 profile 默认把
`@deepseek-ai/dsh-client-ui-settings` 关掉了（`enabled: false`），塞进去只是多一个启动期失败点。

## 排错

先跑体检——它会看 profile 有没有挂上插件、文件全不全、凭据 ref 在不在，还能顺手问一次活着的路由：

```bash
node scripts/doctor.mjs                 # 桌面 App（desktop profile）
node scripts/doctor.mjs --profile web   # 命令行界面
node scripts/doctor.mjs --port 50989    # 再问一次宿主路由（端口看 GUI 地址）
```

它会明确告诉你「插件没挂进 node_modules」「bundles 里没有」「凭据库缺 AK」「路由 404（这个进程里宿主半边没加载）」
这类结论，并且只读凭据、从不打印值。

再不带 DSH 跑一次探针（同样的签名与解析代码）：

```bash
node scripts/probe.mjs <AccessKeyId> <AccessKeySecret> [SecurityToken] [--raw] [--label 千问学生券]
# 或读环境变量：node scripts/probe.mjs
```

正常输出：

```json
{"label":"阿里云代金券 · 2027-10-20 到期","unit":"CNY","remaining":286.18,"maxBudget":300,"count":1,"expiresAt":"2027-10-20"}
```

| 现象 | 原因 |
| --- | --- |
| 行显示「· 待配置」 | 凭据没读到：检查 `refs:` 键名、环境变量、AK 是否被删除 |
| 行显示「· 查询失败」 | 悬停看具体原因：`InvalidAccessKeyId`（AK 错/已删）、`Forbidden`（没授权 `bss:DescribeCoupon`）、HTTP 4xx/5xx |
| 数字不更新 | 点那一行打开面板看「更新于」；interval 太大就调小；宿主定时器只在插件进程活着时跑 |
| 路由 404 | 宿主半边没加载：检查包名是否在 `dsh.profile.bundles`、日志里有没有插件报错 |
| 侧边栏一行都不出现，App 也没报错 | 先看 `~/.dsh/storages/dsh-alicoupon/client.log`（浏览器半边会往宿主发自检信标，也汇总在 `/state` 的 `diagnostics.clientLog` 里）。0.1.3 之前最常见的死因是 `cannot get property "slots" without inject`：不声明 `inject` 时 cordis 的 ctx 代理拒绝读 `ctx.slots`，注册就静默失败了。现在改成 `ctx.get('slots')`（不触发守卫）拿服务，再用 `slots.inject(name, () => slots.register(…))` 注册 |
| App 起不来，报 `web boot: 1 entry did not activate` | 有客户端条目没跑到 active。崩溃日志在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`，能直接看到 `<包名>: loading`。本包 0.1.1 起这样修：`dsh.client.immediately: true`（启动期先预取模块）+ 不在插件自身声明 `slots` 强依赖（插件立刻 active，服务晚到不影响启动）+ `apply` 同步返回 `undefined`、永不抛错。升级后仍然要重启 App |
| 改了 `lib/index.js` 但行为没变 | **热重载不会重新 import 已经加载过的宿主模块**——必须重启 App（或重启 `dsh web`）；改客户端 `lib/client.js` 同样要重开界面（桌面 App 的界面走 `dsh-app://`，F5 不重载） |

宿主日志：DSH 主进程 stdout；桌面 App 的渲染进程日志（只在启动失败时写）在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`。

想看内部过程：设 `DSH_ALICOUPON_TRACE=<文件路径>`（宿主启动前设好），宿主会把每次凭据解析、HTTP 状态、汇总结果追加进去。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/plugins/dsh-alicoupon/state` | 当前快照（命中缓存不打阿里云） |
| POST | `/plugins/dsh-alicoupon/refresh` | 强制刷新后返回 |
| GET | `/plugins/dsh-alicoupon/config` | 生效配置 + 凭据是否就绪 + 落盘路径 |
| POST | `/plugins/dsh-alicoupon/config` | `{"label":"…","refreshMinutes":n}`，落盘并立即生效；非法字段 400 |
| GET | `/plugins/dsh-alicoupon/credentials` | 每个 ref 的 `configured` / `source` / `writable`，以及凭据服务支不支持写入 |
| POST | `/plugins/dsh-alicoupon/credentials` | `{"accessKeyId":"…","accessKeySecret":"…","securityToken":"…"}` 写进凭据库；`{"clear":["accessKeyId"]}` 删除；整条校验不过就 400 且不写 |

所有路由都处理 `OPTIONS` 预检（浏览器半边跟宿主不同源，JSON `POST` 会先发预检）。

`state` / `refresh` 的响应里还带 `config`（生效配置）与 `diagnostics`（`clientHits` / `otherHits` 计数，
用来判断浏览器那半边到底有没有在轮询）。

响应示例：

```json
{
  "status": "ok",
  "label": "阿里云代金券",
  "title": "阿里云代金券 · 2027-10-20 到期",
  "unit": "CNY",
  "remaining": 279.59,
  "maxBudget": 300,
  "count": 1,
  "expiresAt": "2027-10-20",
  "message": "",
  "updatedAt": 1792570717509
}
```

`status` 只有 `ok` / `unconfigured` / `error` 三种（都是 200，靠 `status` 区分）。

## 开发与测试

```bash
npm test    # 42 个用例，全部离线、零依赖
npm run check
npm run doctor
```

测试文件都是零依赖、离线可跑的：`aliyun-coupon` 测签名/翻页/解析/汇总，`config` 测配置白名单，
`host` 用**假的 cordis ctx** 驱动真实路由处理器（注册路由 → 无凭据不联网 → 读配置 → 写配置 → 落盘 → 当场生效 → 非法输入被拒；
凭据路由用假凭据库 + 假 fetch：写入后当场查到券、`clear` 后回到未配置、非法输入一个字节都不写），
`client` 用**假的 React** 渲染那一行与配置面板（验证 bundle 契约、槽位注册、面板字段）。
`host` / `client` 都不碰阿里云、不需要浏览器，所以 CI 里也安全。

`integration` 是两端合起来的端到端测试：**真实宿主路由 + 真实客户端 bundle**，中间用内存桥接
（假 `fetch` → 真实 handler → 假凭据库 → 假阿里云），跑完「面板读 `/config` → 填 AK/Secret → 保存 →
宿主落库并立刻查一次 → 面板回显 → 那一行显示 `¥286.18`」整条链路。单测证明不了两半对得上——
`fix: answer CORS preflight` 那个 bug（客户端带 JSON 的 POST 会先发 OPTIONS，而宿主回 405）就是这类问题。

`scripts/link-into-profile.mjs` 也属于可跑的脚本：`--dry` 不写盘，可以直接拿来检查挂载状态。

`lib/aliyun-coupon.js` 是零依赖的纯核心（签名 / 请求 / 解析 / 汇总），可以单独复用：

```js
import { fetchCoupons, summarizeCoupons } from 'dsh-alicoupon/aliyun-coupon'

const result = await fetchCoupons({ accessKeyId, accessKeySecret })
console.log(summarizeCoupons(result, { label: '阿里云代金券' }))
```

## 已知限制

- 宿主半边需要 DSH 的 Web 服务器（`ctx.webServer`）与凭据库（`ctx.credentials`），纯终端界面里插件会停在 pending。
- `DescribeCoupon` 返回的券对象没有名字字段，所以「一张券 = 一行汇总」：把同一账号下所有可用券的剩余/面值加总，到期日取最近的那个。要挑特定的券，得按 `CouponId` 过滤（还没做）。
- 这些路由和 DSH 的 Web 服务器一样**不带认证**（DSH 自己的设计：路由各自负责）。`/state` 只读，
  `/config` 也只能改标签和刷新间隔（白名单校验），但如果你把 DSH 的端口暴露到局域网，任何能访问它的
  本地网页都能改这两个字段、也能看到你的券余额；`POST /credentials` 更敏感——它**只往凭据库里写**
  （不能读回任何值，响应里只有 ref 名、状态和阿里云那边的结果），但暴露出去就等于让别人能替换你的 AK。
  所以：别把端口开到局域网，要就要给它加一层守卫（本插件以后要做的事）。
- 只读，不会动任何阿里云资源。

## English quick start

A DSH plugin that shows your Alibaba Cloud coupon balance in the sidebar footer.

**You do not log in anywhere.** The plugin holds one read-only Alibaba Cloud AccessKey in the local
DSH credential store and talks to `business.aliyuncs.com` only — no OAuth, no console session, no
telemetry. Without an AccessKey the row simply says `unconfigured`.

1. Create a RAM user with **permanent AccessKey** only, grant `AliyunBSSReadOnlyAccess` (or just `bss:DescribeCoupon`).
2. Store the credentials as `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` in the DSH credential store (or as env vars). Or skip this step and type them into the panel (click the sidebar row) — the host writes them into the DSH credential store for you and immediately re-queries Alibaba Cloud, so a wrong key or a missing permission shows up right there.
3. Install: `dsh plugin --profile web add github:yangguozhongmax-max/dsh-alicoupon`. Desktop profile: install from the app's Settings → Plugins, or run `node scripts/link-into-profile.mjs` (link + `dsh.profile.bundles` in one idempotent step, `--unlink` to undo), then restart the app — hot reload does not re-import an already-loaded host module.
4. The host polls `DescribeCoupon` every `refreshMinutes` (default 1) and serves a read-only snapshot at `/plugins/dsh-alicoupon/state`; the browser half renders it next to cost-meter's balance row. Click the row to change the label / interval, refresh now, or manage credentials.

## License

MIT