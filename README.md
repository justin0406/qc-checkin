# 青瓷游戏每日签到（Surge / Loon）

青瓷 H5 活动页的自动签到脚本。默认适配**最强蜗牛（app_id=39）**，同平台其它游戏改个参数即可。

## 为什么不能只填账号密码

本活动的签到接口只认**微信 OAuth 会话**：

- 微信授权会话里 `user_info.user_id` 是**活动用户 ID**，签到记录写的正是它
- 用账号密码调接口拿到的是**青瓷通行证 ID**，两者不是一回事
- 通行证会话去签到 → `Column 'user_id' cannot be null` → HTTP 500

所以脚本的思路是：**借用你微信里的会话**，而不是模拟登录。

## 工作方式

| 模式 | 触发 | 作用 |
|---|---|---|
| 捕获 | `http-request` | 你在微信打开活动页时，截取请求头里的 `PHPSESSID`，同时记下是哪个游戏 |
| 响应 | `http-response` | 同上，但从响应头的 `Set-Cookie` 捞（OAuth 跳转时新会话由响应下发） |
| 维持 | `cron` 每小时 | 刷新会话 → 当日未签则签到 → 按天去重通知 |

捕获/响应两条**只存凭证、立即放行**，不会拖慢你在微信里的页面加载。签到全部由「维持」承担，所以：

- 某次唤醒被 iOS 后台节流跳过，**不会漏签**——下个整点补上（一天 24 次机会）
- 签到成功、今日已签到、会话失效都会弹通知；失败类通知**每天最多一条**，不会刷屏
- 网络抖动 / 网关错误不算会话失效，静默等下一轮，不误报

## 安装

### Surge

```
https://raw.githubusercontent.com/justin0406/qc-checkin/main/surge/qc-checkin.sgmodule
```

1. Surge → 首页 → 模块 → 安装的模块 → 添加上面的 URL
2. 确保 **MITM 已开启**，且已安装并信任 Surge CA 证书
3. 微信里打开一次活动页完成"播种"

### Loon

```
https://raw.githubusercontent.com/justin0406/qc-checkin/main/loon/qc-checkin.plugin
```

1. Loon → 配置 → 插件 → 添加上面的 URL
2. 确保 MITM 证书已安装信任
3. 微信里打开一次活动页

## 使用

装好后**不需要任何额外操作**：在微信里打开一次活动页，之后：

- 每小时刷新会话（Laravel 空闲超时 2 小时，持续 ping 即可续命）
- 每小时检查一次，当天没签就签
- 会话断了会通知你"打开一次活动页"

### 换成其它游戏

**不用改配置**：脚本会从你在微信里打开的活动页请求中自动识别 `app_id` / `page_id` 并存下来，之后维持任务沿用。打开哪个游戏就签哪个。

需要固定目标时，再给「维持」这条 cron 的 `argument` 加参数（优先级最高）：

```
argument=app_id=58&page_id=8
```

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

## 限制

- **会话 2 小时空闲超时**：手机断网或代理停摆超过 2 小时，会话失效，需要重新打开一次活动页（会通知）
- **iOS 后台节流**：每小时唤醒不保证 100% 执行，深度休眠时可能跳过。签到在维持任务里，跳过只会延后、不会漏
- **Loon 的 cron 可靠性低于 Surge**：Loon 没有 `wake-system` 等价开关，App 被系统挂起时唤醒更不稳定，建议把 Loon 加进后台刷新白名单
- 保活每小时唤醒一次，**略微耗电**。不想要可以删掉「维持」那条 cron，退回"开页面才签"

## 清空状态

想重置当天状态（比如测试），在 Surge/Loon 里加一条临时脚本运行：

```js
const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
const keys = ['qc_done_', 'qc_clean_', 'qc_n_dead_', 'qc_n_already_', 'qc_n_fail_', 'qc_n_nocap_', 'qc_n_err_'];
keys.forEach(k => $persistentStore.write('', k + day));
$done();
```

要连会话一起清（重新播种）再加一行：`$persistentStore.write('', 'qc_ck');`

## 开发

```bash
node --check scripts/qc_sign.js      # 语法
node tests/harness.js scripts/qc_sign.js   # 行为测试（模拟 Surge 运行时）
```

`tests/harness.js` 用 Node `vm` 模拟 `$persistentStore` / `$httpClient` / `$notification`，覆盖捕获、续期、签到、网络抖动、会话失效、通知去重、key 清理等路径。CI 在每次 push 时跑这两步。

## 免责声明

仅供学习与个人自动化使用。脚本不包含任何账号、密码或会话凭证，所有凭证都保存在你自己的设备上（`$persistentStore`）。使用风险自负。

## License

MIT
