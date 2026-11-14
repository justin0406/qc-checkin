# 青瓷游戏每日签到（Surge / Loon）

青瓷 H5 活动页的自动签到脚本。默认目标是**最强蜗牛（app_id=39）**；在同一台设备上打开过别的青瓷活动页后，会自动跟随到那个游戏，无需改配置。

## 为什么不能只填账号密码

本活动的签到接口只认**微信 OAuth 会话**：

- 微信授权会话里 `user_info.user_id` 是**活动用户 ID**，签到记录写的正是它
- 用账号密码调接口拿到的是**青瓷通行证 ID**，两者不是一回事
- 通行证会话去签到 → `Column 'user_id' cannot be null` → HTTP 500

所以脚本的思路是**借用你微信里已有的会话**，而不是模拟登录。

## 工作方式

| 模式 | 触发 | 作用 |
|---|---|---|
| 捕获 | `http-request` | 你在微信打开活动页时，截取请求头里的 `PHPSESSID`，并记下是哪个游戏 |
| 响应 | `http-response` | 同上，但从响应头的 `Set-Cookie` 捞（OAuth 跳转时新会话由响应下发） |
| 维持 | `cron` 每小时 | 刷新会话 → 当日未签则签到 → 按天去重通知 |

捕获/响应两条**只存凭证、立即放行**，不拖慢微信里的页面加载。签到全部由「维持」承担，因此：

- 某次唤醒被 iOS 后台节流跳过，下个整点会补上，不必等到第二天（一天 24 次机会）
- 签到成功、今日已签到、会话失效都会通知；失败类通知**每天最多一条**，不刷屏
- 网络抖动 / 网关错误不计为会话失效，静默等下一轮，不误报

## 安装

需要 **iOS / iPadOS 上的 Surge 或 Loon**，并已开启 MITM、安装并信任对应的 CA 证书。装好后必须在微信里打开一次活动页完成「播种」——这是脚本获取会话的唯一途径（微信的流量必须经过代理，走直连规则或代理未开启都捕获不到）。

### Surge

```
https://raw.githubusercontent.com/justin0406/qc-checkin/main/surge/qc-checkin.sgmodule
```

1. Surge → 首页 → 模块 → 安装的模块 → 添加上面的 URL
2. 确认 **MITM 已开启**，且 Surge CA 证书已在系统设置中信任
3. 微信里打开一次活动页

### Loon

```
https://raw.githubusercontent.com/justin0406/qc-checkin/main/loon/qc-checkin.plugin
```

1. Loon → 配置 → 插件 → 添加上面的 URL
2. 确认 MITM 已开启、证书已信任
3. 微信里打开一次活动页

> 两端脚本缓存的更新方式不同：Surge 的远程脚本默认每 24 小时自动检查更新（`script-update-interval` 默认 86400 秒），改脚本后用户无需操作；Loon 的脚本参数中没有更新间隔选项，新版本要等插件本身更新才生效。

## 使用

装好后**不需要任何额外操作**：在微信里打开一次活动页，之后：

- 每小时刷新会话（Laravel 会话为空闲超时，持续 ping 即可续命）
- 每小时检查一次，当天没签就签
- 会话断了会通知你「打开一次活动页」

### 换成其它游戏

**通常不用改配置**：脚本会从你在微信里打开的活动页请求中识别 `app_id` / `page_id` 并持久化，维持任务沿用最近一次的目标。

已知对应关系（来自官方 `/game/sign` 接口）：

| app_id | 游戏 | page_id |
|---|---|---|
| 39 | 最强蜗牛 | 1 |
| 33 | 提灯与地下城 | 3 |
| 35 | 时光旅行社 | 2 |
| 58 / 69 | 新仙剑奇侠传之挥剑问情 | 8 |
| 74 / 61 | 魔卡少女樱：回忆钥匙 | 11 |
| 82 / 40 | 刃心2 | 14 |
| 47 | 骑士冲呀 | 18 |

⚠️ **同一时刻只维持一个游戏目标**。自动识别会覆盖上一次的记录，所以如果你玩多个青瓷游戏，最后打开的那个才会被签到。要固定某个游戏，给「维持」这条 cron 的 `argument` 加参数（优先级最高，不受自动识别影响）：

```
argument=app_id=58&page_id=8
```

Loon 的 `argument` 建议加双引号，避免 `&` 被解析截断：

```
argument="app_id=58&page_id=8"
```

> 远程模块在更新时会重写模块内容，你在 App 里手改的 `argument` 可能被覆盖。更新后如果签到目标不对，回到这里复查一次。

## 限制

- **会话 2 小时空闲超时**：手机断网或代理停摆超过 2 小时，会话失效，需要重新打开一次活动页（会通知）。整天没有网络时当天确实会漏签
- **iOS 后台节流**：每小时唤醒不保证 100% 执行，深度休眠时可能被跳过。签到在维持任务里，跳过只会延后到下一个整点
- **Loon 的 cron 可靠性低于 Surge**：Loon 没有 `wake-system` 等价开关，App 被系统挂起时唤醒更不稳定，建议把 Loon 加入后台刷新白名单
- **维持任务每小时唤醒一次，略微耗电**。注意：删掉这条 cron **不等于**退回「开页面才签」——捕获模式只存凭证、不签到，删掉后是完全停止签到。想省电可改成每 2 小时一次，代价是贴着 2 小时超时边界跑，掉会话概率上升：

  ```
  # Surge
  青瓷维持 = type=cron,cronexp=0 */2 * * *,wake-system=1,script-path=...

  # Loon
  cron "0 */2 * * *" script-path=..., timeout=60, tag=青瓷维持
  ```

## 排查

不确定脚本是否在工作，先加一条临时脚本运行，确认状态：

```js
const ck = $persistentStore.read('qc_ck');
$notification.post('[青瓷签到] 状态',
  '会话：' + (ck ? '已捕获' : '未捕获'),
  '目标：' + ($persistentStore.read('qc_app') || '默认 39|1'));
$done();
```

| 现象 | 原因与处理 |
|---|---|
| 完全收不到通知 | 多数是微信流量没走代理：检查代理已开启、微信未被分流到直连、`api.qingcigame.com` 未被规则绕过；其次才是 MITM 未开启 / 证书未信任 |
| 通知「尚未捕获会话」 | 按提示打开一次活动页即可，该提醒每天只发一次 |
| 通知「会话已失效」 | 同上。打开活动页后下一个整点自动恢复 |
| 通知「签到未完成」 | 附带的详情是服务端返回的 message，通常是活动未开始、角色未绑定或接口调整 |
| 通知「脚本异常」 | 脚本内部报错，附带异常信息；带这条信息去仓库开 issue |
| 签到的不是想要的游戏 | 打开目标游戏的活动页一次，或在 `argument` 里写死 `app_id` |
| 装了几天一直没通知 | 正常：签到成功只发一次，已签到每天最多一次。用上面的状态脚本确认会话是否已捕获 |

## 清空状态

想重置当天状态（比如测试），加一条临时脚本运行：

```js
const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
const keys = ['qc_done_', 'qc_clean_', 'qc_n_dead_', 'qc_n_already_', 'qc_n_fail_', 'qc_n_nocap_', 'qc_n_err_'];
keys.forEach(k => $persistentStore.write('', k + day));
$done();
```

要连会话一起清（需要重新播种），再加一行：`$persistentStore.write('', 'qc_ck');`

## 开发

```
scripts/qc_sign.js          单文件脚本，捕获 / 响应 / 维持三模式共用
surge/qc-checkin.sgmodule   Surge 模块
loon/qc-checkin.plugin      Loon 插件
tests/harness.js            行为测试
.github/workflows/ci.yml    CI
```

```bash
node --check scripts/qc_sign.js            # 语法检查
node tests/harness.js scripts/qc_sign.js   # 行为测试（模拟 Surge 运行时）
```

`tests/harness.js` 用 Node `vm` 模拟 `$persistentStore` / `$httpClient` / `$notification`，覆盖捕获、会话续期、签到、网络抖动、会话失效、通知去重、状态清理等 25 条断言。CI 在每次 push 和 PR 时依次跑语法检查、模块配置检查、行为测试。

本仓库通过 raw URL 直装分发，脚本一旦有语法错误会让所有已安装用户的模块失效，所以改脚本请务必跑完上面的两条命令。

## 免责声明

仅供学习与个人自动化使用。脚本不包含任何账号、密码或会话凭证，所有凭证只保存在你自己的设备上（`$persistentStore`）。使用风险自负。

## License

MIT
