/************************************************************
 * 青瓷签到 · 全自动（最强蜗牛 app_id=39）—— 单文件三模式
 *
 * ┌── 原理 ──────────────────────────────────────────────────┐
 * │ 活动只认「微信 OAuth 会话」：/game/my 返回的              │
 * │ user_info.user_id（活动用户 ID）才是活动用户；账号密码登录   │
 * │ 拿到的是通行证 ID，活动系统认不出 → 签到时 user_id 为 null。 │
 * │                                                          │
 * │ Laravel 会话是「空闲超时」：每次响应都会下发新的          │
 * │ PHPSESSID（Max-Age 重新计时）。所以只要 2 小时内 ping     │
 * │ 一次，会话就能一直续命 → 无需每天开页面。                 │
 * └──────────────────────────────────────────────────────────┘
 *
 * 模式1 捕获 (http-request) ：截获微信里的会话，只存不签，不阻塞请求。
 * 模式2 响应 (http-response)：从 Set-Cookie 捞新会话，只存不签。
 * 模式3 维持 (cron 每小时)  ：刷新会话 → 当日未签则签 → 按天去重通知。
 *
 * 【Surge 配置】
 * [Script]
 *   青瓷捕获 = type=http-request,pattern=^https?://api\.qingcigame\.com/,script-path=qc_sign.js
 *   青瓷响应 = type=http-response,pattern=^https?://api\.qingcigame\.com/,script-path=qc_sign.js
 *   青瓷维持 = type=cron,cronexp=0 * * * *,wake-system=1,script-path=qc_sign.js
 *
 * [MITM]
 *   hostname = %APPEND% api.qingcigame.com, h5.qingcigame.com
 *
 * ⚠️ 保活要点：
 *   - 手机断网 / Surge 停摆超过 2 小时，会话会死，需要重新打开一次活动页。
 *   - 每小时唤醒一次比较耗电；想省电可改成每 2 小时一次（风险：卡在 2 小时边界）。
 *   - 每小时都会尝试签到，某次唤醒被系统跳过不会漏签，下个整点补上。
 ************************************************************/

// app_id 可用 argument 覆盖：argument=app_id=58&page_id=8
// 不传则沿用最近一次捕获到的游戏（微信里打开哪个就签哪个），最后回落到 39。
// 常见：39=最强蜗牛 33=提灯与地下城 35=时光旅行社 58/69=仙剑 74=魔卡少女樱
const DEFAULT_APP  = '39';
const DEFAULT_PAGE = '1';

const BASE = 'https://api.qingcigame.com';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN';

const KEY_CK    = 'qc_ck';      // 会话
const KEY_APP   = 'qc_app';     // 最近捕获到的游戏 app_id|page_id
const KEY_DONE  = 'qc_done_';   // 当日完成标记
const KEY_NOTE  = 'qc_n_';      // 当日通知标记
const KEY_CLEAN = 'qc_clean_';  // 当日清理标记

// 旧版本遗留 key（新版本不再写入，滚动清理掉）
const LEGACY_INFO = 'qc_info_';
const LEGACY_LOCK = 'qc_lock';

// notifyOnce 用到的全部后缀，清理时按天回收
const NOTE_SUFFIX = ['dead', 'already', 'fail', 'nocap', 'err'];

const ARG = (typeof $argument !== 'undefined' && $argument) ? String($argument) : '';
const IS_REQUEST  = (typeof $request !== 'undefined');
const IS_RESPONSE = (typeof $response !== 'undefined');
const IS_MAINTAIN = !IS_REQUEST && !IS_RESPONSE;   // cron / 手动运行

// ---------------- 工具 ----------------
function read(k) { try { return $persistentStore.read(k) || ''; } catch (e) { return ''; } }
function write(k, v) { try { $persistentStore.write(String(v), k); } catch (e) {} }
function dayStr(d) {
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function localDay() { return dayStr(new Date()); }
function truthy(v) { return v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v) === '1'; }
function jparse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function notify(t, s, b) { try { $notification.post('[青瓷签到] ' + t, s || '', b || ''); } catch (e) {} }

// 当天只提醒一次（用于失败/过期场景，避免刷屏）
function notifyOnce(key, t, s, b) {
  const k = KEY_NOTE + key + '_' + localDay();
  if (read(k) === '1') return;
  write(k, '1');
  notify(t, s, b);
}

function http(method, path, headers, body) {
  return new Promise(function (resolve) {
    const opt = { url: BASE + path, headers: Object.assign({}, headers) };
    if (body) { opt.body = body; opt.headers['Content-Type'] = 'application/json'; }
    const cb = function (err, resp, data) {
      resolve({
        err: err,
        status: (resp && resp.status) || 0,
        headers: (resp && resp.headers) || {},
        body: data || '',
      });
    };
    if (method === 'POST') $httpClient.post(opt, cb); else $httpClient.get(opt, cb);
  });
}

function hdrs(cookie) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://h5.qingcigame.com',
    'Referer': 'https://h5.qingcigame.com/package/template/enter1h15sds6myo?app_id=' + APP_ID,
    'Cookie': cookie,
  };
}

// 从响应头取 Set-Cookie（Surge 可能合并成逗号串）
function setCookies(headers) {
  const ATTR = { path: 1, domain: 1, expires: 1, 'max-age': 1, httponly: 1, secure: 1, samesite: 1 };
  let raw = '';
  Object.keys(headers || {}).forEach(function (k) {
    if (k.toLowerCase() !== 'set-cookie') return;
    const v = headers[k];
    raw += '; ' + (Array.isArray(v) ? v.join('; ') : String(v));
  });
  const out = [], seen = {};
  raw.split(/[;,]\s*(?=[A-Za-z0-9_\-.%]+\s*=)/).forEach(function (seg) {
    const m = /^\s*([A-Za-z0-9_\-.%]+)\s*=\s*([^;,]*)/.exec(seg);
    if (!m) return;
    if (ATTR[m[1].toLowerCase()] || seen[m[1]]) return;
    seen[m[1]] = 1;
    out.push(m[1] + '=' + m[2].trim());
  });
  return out;
}

// 合并新旧 cookie（新的覆盖旧的）
function mergeCookie(oldCookie, pairs) {
  const map = {};
  String(oldCookie || '').split(/;\s*/).forEach(function (p) {
    const i = p.indexOf('=');
    if (i > 0) map[p.slice(0, i).trim()] = p.slice(i + 1);
  });
  (pairs || []).forEach(function (p) {
    const i = p.indexOf('=');
    if (i > 0) map[p.slice(0, i).trim()] = p.slice(i + 1);
  });
  return Object.keys(map).map(function (k) { return k + '=' + map[k]; }).join('; ');
}

// ---------------- 目标游戏 ----------------
// 优先级：argument > 最近一次捕获 > 默认
let APP_ID = DEFAULT_APP, PAGE_ID = DEFAULT_PAGE;
(function () {
  const a = /app_id=(\d+)/.exec(ARG);
  const p = /page_id=(\d+)/.exec(ARG);
  const saved = read(KEY_APP).split('|');
  APP_ID = (a && a[1]) || saved[0] || DEFAULT_APP;
  PAGE_ID = (p && p[1]) || saved[1] || DEFAULT_PAGE;
})();

// 从被拦截的请求里认出真实目标：微信里打开哪个游戏就记哪个
function learnTarget(url) {
  const s = String(url || '');
  // app_id 比 game_id 更权威（/game/sign/list 同时带两者，game_id 是用户角色实例）
  const a = /[?&]app_id=(\d+)/.exec(s) || /[?&]game_id=(\d+)/.exec(s);
  const p = /[?&]page_id=(\d+)/.exec(s);
  if (!a && !p) return;
  if (a) APP_ID = a[1];
  if (p) PAGE_ID = p[1];
  write(KEY_APP, APP_ID + '|' + PAGE_ID);
}

// ---------------- 会话捕获（只存不签） ----------------
function captureCookie() {
  if (IS_RESPONSE) {
    const pairs = setCookies(($response && $response.headers) || {});
    if (pairs.length && pairs.some(function (p) { return /^PHPSESSID=/.test(p); })) {
      write(KEY_CK, mergeCookie(read(KEY_CK), pairs));
    }
    return;
  }
  const h = ($request && $request.headers) || {};
  let ck = '';
  for (const k in h) { if (k.toLowerCase() === 'cookie') ck = h[k]; }
  if (ck && /PHPSESSID=/.test(ck)) write(KEY_CK, ck);
}
// ---------------- 签到流程 ----------------
// data 为 /game/my 的 data（避免重复请求）
async function doSign(cookie, data) {
  const H = hdrs(cookie);
  const u = (data && data.user_info) || {};
  const roleId = u.role_id || '', gameId = u.game_id || APP_ID, role = u.role_name || '';

  const st = async function () {
    const r = await http('GET', '/game/sign/list?game_id=' + gameId + '&role_id=' + roleId + '&app_id=' + APP_ID, H);
    const j = jparse(r.body);
    return (j && j.code === 200 && j.data) ? j.data : null;
  };

  const d = await st();
  if (d && truthy(d.is_get)) return { ok: true, already: true, role: role, total: d.sign_total };

  let rec = await http('POST', '/game/sign/record', H,
    JSON.stringify({ app_id: APP_ID, page_id: PAGE_ID, game_id: gameId }));
  if (rec.err) return { ok: false, reason: '网络异常' };
  let rj = jparse(rec.body);

  if (rj && String(rj.message || '').indexOf('绑定角色') >= 0) {
    await http('POST', '/game/binds', H, JSON.stringify({
      account: u.account, page_id: PAGE_ID, game_id: gameId, role_id: roleId, role_name: role,
      server_id: u.server_id, server_name: u.server_name,
      type: 'android', platform: u.platform || 'android', extra: u.extra || '{}',
    }));
    rec = await http('POST', '/game/sign/record', H,
      JSON.stringify({ app_id: APP_ID, page_id: PAGE_ID, game_id: gameId }));
    if (rec.err) return { ok: false, reason: '网络异常' };
    rj = jparse(rec.body);
  }

  let signed = false, total = d ? d.sign_total : 0;
  for (let i = 0; i < 2 && !signed; i++) {
    if (i) await new Promise(function (r) { setTimeout(r, 1200); });
    const d2 = await st();
    if (d2) { signed = truthy(d2.is_get); total = d2.sign_total || total; }
  }
  if (signed) return { ok: true, role: role, total: total };
  return { ok: false, reason: '签到未生效', detail: rj ? (rj.message || ('code=' + rj.code)) : '无响应' };
}

// ---------------- 每日清理（$persistentStore 无法枚举，按已知 key 滚动回收） ----------------
function cleanup() {
  const now = Date.now();
  for (let n = 1; n <= 3; n++) {
    const day = dayStr(new Date(now - n * 86400000));
    write(KEY_DONE + day, '');
    write(KEY_CLEAN + day, '');
    write(LEGACY_INFO + day, '');
    for (const s of NOTE_SUFFIX) write(KEY_NOTE + s + '_' + day, '');
  }
  write(LEGACY_LOCK, '');
}

// ---------------- 维持（保活 + 签到） ----------------
async function maintain() {
  const day = localDay();
  if (read(KEY_CLEAN + day) !== '1') {
    cleanup();
    write(KEY_CLEAN + day, '1');
  }

  const ck = read(KEY_CK);
  if (!ck) {
    notifyOnce('nocap', '尚未捕获会话', '在微信里打开一次活动页', '之后即可自动签到');
    return;
  }

  // 1) 刷新会话，同时区分「真死」与「网络抖动」
  const my = await http('GET', '/game/my?game_id=' + APP_ID + '&page_id=' + PAGE_ID, hdrs(ck));
  if (my.err) return;                       // 网络异常：下个整点重试，不打扰
  const mj = jparse(my.body);
  if (!mj) return;                          // 网关/非 JSON：同上
  if (mj.code !== 200) {                    // 服务端明确拒绝 = 会话真死
    notifyOnce('dead', '会话已失效', '在微信里打开一次活动页', '打开后会自动恢复');
    return;
  }

  const fresh = setCookies(my.headers);
  const cookie = fresh.length ? mergeCookie(ck, fresh) : ck;
  if (fresh.length) write(KEY_CK, cookie);

  // 2) 当日已签：只保活，不再请求签到接口
  if (read(KEY_DONE + day) === '1') return;

  // 3) 签到
  const res = await doSign(cookie, mj.data);
  if (res.ok) {
    write(KEY_DONE + day, '1');
    if (res.already) notifyOnce('already', '今日已签到', res.role || '', '累计 ' + res.total + ' 天');
    else notify('签到成功 ✅', res.role || '', '累计签到 ' + res.total + ' 天');
  } else if (res.reason === '网络异常') {
    // 下个整点重试
  } else {
    notifyOnce('fail', '签到未完成', res.reason || '', res.detail || '');
  }
}

// ---------------- 入口 ----------------
(async function () {
  try {
    if (IS_REQUEST || IS_RESPONSE) {
      // 捕获 / 响应：只存会话与目标游戏，立即放行，不阻塞用户请求
      learnTarget(IS_REQUEST ? (($request && $request.url) || '') : '');
      captureCookie();
      return $done({});
    }
    await maintain();
    return $done();
  } catch (e) {
    if (IS_MAINTAIN) notifyOnce('err', '脚本异常', String(e && e.message ? e.message : e), '');
    return (IS_REQUEST || IS_RESPONSE) ? $done({}) : $done();
  }
})();
