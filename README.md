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
| 捕获 | `http-request` | 你在微信打开活动页时，截取请求头里的 `PHPSESSID` |
| 响应 | `http-response` | 同上，但从响应头的 `Set-Cookie` 捞（OAuth 跳转时新会话由响应下发） |
| 保活 | `cron` 每小时 | ping 一次刷新会话，利用 Laravel 会话的空闲超时续期 |
| 签到 | `cron` 每天 9 点 | 用存下来的会话签到，失败会通知 |

签到成功 / 已签到 / 会话失效都会弹通知。

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

- 每天 9 点自动签到（会话有效时）
- 每小时保活续期
- 会话断了会通知你"打开一次活动页"

### 换成其它游戏

在模块/插件里给 cron 的 `argument` 加 `app_id`：

```
argument=keepalive&app_id=58&page_id=8
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

- **会话 2 小时空闲超时**：手机断网或 Surge 停摆超过 2 小时，会话失效，需要重新打开一次活动页（会通知）
- **iOS 后台节流**：每小时唤醒不保证 100% 执行，深度休眠时可能跳过
- 保活每小时唤醒一次，**略微耗电**。不想要可以删掉「保活」那条 cron，退回"开页面才签"

## 清空状态

想重置当天状态（比如测试），在 Surge/Loon 里加一条临时脚本运行：

```js
const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
['qc_done_', 'qc_info_', 'qc_note_'].forEach(k => $persistentStore.write('', k + day));
$done();
```

## 免责声明

仅供学习与个人自动化使用。脚本不包含任何账号、密码或会话凭证，所有凭证都保存在你自己的设备上（`$persistentStore`）。使用风险自负。

## License

MIT
