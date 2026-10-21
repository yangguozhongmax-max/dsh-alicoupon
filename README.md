# dsh-alicoupon

在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的侧边栏底部，和 cost-meter 的余额行并排显示**阿里云代金券剩余额度**。

```
千问学生券            ¥279.59        ← 本插件（点一下立即刷新，悬停看面值/张数/更新时间）
今日  ¥9.8254
━━━━━━━━━━━  峰时 · 1 小时 47 分后进入平价
```

- 只用**只读**接口：阿里云 BSS `DescribeCoupon`（`business.aliyuncs.com`，`2023-09-30`，ACS3-HMAC-SHA256 签名）。
- 凭据存在 DSH 凭据库里，**永远不回传给浏览器**；接口响应只有余额、面值、张数、到期日。
- 宿主半边每 `refreshMinutes`（默认 1 分钟）重查一次；浏览器半边每 60 秒读一次宿主快照，页面重新可见 / 窗口聚焦时各读一次，点那行强制刷新。

## 它怎么工作

```
┌─ 宿主（Node 侧，lib/index.js） ─────────────────────────────┐
│  ctx.credentials.resolve('ALIBABA_CLOUD_ACCESS_KEY_ID'…)    │
│  → fetchCoupons() 调阿里云 DescribeCoupon（只读）            │
│  → 内存缓存 refreshMinutes                                  │
│  → 只读 HTTP 路由 /plugins/dsh-alicoupon/state | /refresh    │
└─────────────────────────────────────────────────────────────┘
┌─ 浏览器（lib/client.js） ───────────────────────────────────┐
│  ctx.slots.register({name:'sidebar.footer.action', …})      │
│  每 60s GET 一次 state 路由 → 渲染「标签 + 余额」             │
└─────────────────────────────────────────────────────────────┘
```

## 准备：一个只读的阿里云 AccessKey

1. 在**能看到那张券的阿里云账号**里进「访问控制 RAM → 用户 → 创建用户」。
2. 访问方式**只勾「使用永久 AccessKey 访问」**（不要勾"控制台访问"，那是给人登录网页用的，还要密码 + MFA）。
3. 记下 AccessKey ID / Secret（**只在创建时显示一次**）。
4. 给这个用户授权（任选其一）：
   - 省事：`AliyunBSSReadOnlyAccess`（系统策略，含 `bss:Describe*`，覆盖 `DescribeCoupon`）；
   - 最小化：自定义策略，只允许 `bss:DescribeCoupon`。
5. 把凭据写进 DSH：

   - **设置界面**：把 AK/Secret 填进任意能写凭据的插件表单；或
   - **凭据库文件** `~/.dsh/.credentials.yaml`：

     ```yaml
     refs:
       ALIBABA_CLOUD_ACCESS_KEY_ID: LTAI…
       ALIBABA_CLOUD_ACCESS_KEY_SECRET: …
     ```

   - 或者设成环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`（STS 临时凭据再加 `ALIBABA_CLOUD_SECURITY_TOKEN`）。

> 凭据名可以在配置里改（见下）。`refs:` 的键名必须正好等于环境变量名。

## 安装

### Web profile（`dsh web` / 浏览器界面）

```bash
# 本地目录
dsh plugin --profile web add /path/to/dsh-alicoupon
# 或从 GitHub
dsh plugin --profile web add github:yangguozhongmax-max/dsh-alicoupon
```

`dsh plugin add` 会把包名写进该 profile 的 `dsh.profile.bundles`，包自带的 `cordis.patch.yml` 负责把这一行插进插件树。

### 桌面 App（Electron）

桌面 profile 由 App 独占，`dsh --profile desktop` 会被 CLI 拒绝。两种办法：

1. **App 内安装**：设置 → 插件（Plugins）里安装本包。
2. **手工挂载**（本地开发常用）：把包放进 `<profile>/node_modules/dsh-alicoupon`（目录联接 / 复制都行），再把 `"dsh-alicoupon"` 追加到 `<profile>/package.json` 的 `dsh.profile.bundles`，然后重启 App。

`<profile>` 通常是 `~/.dsh/profiles/desktop`（桌面 App）或 `~/.dsh/profiles/web`。

## 配置（可选）

插件的加载行可以带配置；也可以在本 profile 的 `cordis.patch.yml` 里覆盖同一 `id`：

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

## 排错

先不带 DSH 跑一次探针（同样的签名与解析代码）：

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
| 数字不更新 | `refreshMinutes` 太大、或宿主没在跑（重启 App / 重载插件） |
| 路由 404 | 宿主半边没加载：检查包名是否在 `dsh.profile.bundles`、日志里有没有插件报错 |

宿主日志：DSH 主进程 stdout；桌面 App 的渲染进程日志（只在启动失败时写）在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`。

想看内部过程：设 `DSH_ALICOUPON_TRACE=<文件路径>`（宿主启动前设好），宿主会把每次凭据解析、HTTP 状态、汇总结果追加进去。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/plugins/dsh-alicoupon/state` | 当前快照（命中缓存不打阿里云） |
| POST | `/plugins/dsh-alicoupon/refresh` | 强制刷新后返回 |

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
node --test test/aliyun-coupon.test.mjs   # 纯函数单测（签名、翻页、错误映射、汇总）
node --check lib/index.js && node --check lib/client.js && node --check lib/aliyun-coupon.js
```

`lib/aliyun-coupon.js` 是零依赖的纯核心（签名 / 请求 / 解析 / 汇总），可以单独复用：

```js
import { fetchCoupons, summarizeCoupons } from 'dsh-alicoupon/aliyun-coupon'

const result = await fetchCoupons({ accessKeyId, accessKeySecret })
console.log(summarizeCoupons(result, { label: '阿里云代金券' }))
```

## 已知限制

- 宿主半边需要 DSH 的 Web 服务器（`ctx.webServer`）与凭据库（`ctx.credentials`），纯终端界面里插件会停在 pending。
- `DescribeCoupon` 返回的券对象没有名字字段，所以「一张券 = 一行汇总」：把同一账号下所有可用券的剩余/面值加总，到期日取最近的那个。要挑特定的券，得按 `CouponId` 过滤（还没做）。
- 只读，不会动任何阿里云资源。

## English quick start

A DSH plugin that shows your Alibaba Cloud coupon balance in the sidebar footer.

1. Create a RAM user with **permanent AccessKey** only, grant `AliyunBSSReadOnlyAccess` (or just `bss:DescribeCoupon`).
2. Store the credentials as `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` in the DSH credential store (or as env vars).
3. Install: `dsh plugin --profile web add github:yangguozhongmax-max/dsh-alicoupon` (desktop profile: install from the app's Settings → Plugins, or link the package into `<profile>/node_modules` and add it to `dsh.profile.bundles`).
4. The host polls `DescribeCoupon` every `refreshMinutes` (default 1) and serves a read-only snapshot at `/plugins/dsh-alicoupon/state`; the browser half renders it next to cost-meter's balance row.

## License

MIT