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
 * 模式1 捕获  (http-request)：你在微信里打开活动页时截获会话，顺手签到。
 * 模式2 保活  (cron + argument=keepalive)：每小时 ping 一次，刷新会话。
 * 模式3 签到  (cron)：用存下来的会话签到。
 *
 * 【Surge 配置】
 * [Script]
 *   青瓷捕获 = type=http-request,pattern=^https?://api\.qingcigame\.com/,script-path=qc_sign.js
 *   青瓷响应 = type=http-response,pattern=^https?://api\.qingcigame\.com/,script-path=qc_sign.js
 *   青瓷保活 = type=cron,cronexp=0 * * * *,wake-system=1,script-path=qc_sign.js,argument=keepalive
 *   青瓷签到 = type=cron,cronexp=0 9 * * *,wake-system=1,script-path=qc_sign.js
 *
 * [MITM]
 *   hostname = %APPEND% api.qingcigame.com, h5.qingcigame.com
 *
 * ⚠️ 保活要点：
 *   - 手机断网 / Surge 停摆超过 2 小时，会话会死，需要重新打开一次活动页。
 *   - 每小时唤醒一次比较耗电；想省电可改成每 2 小时一次（风险：卡在 2 小时边界）。
 ************************************************************/

// app_id 可用 argument 覆盖：argument=app_id=58&page_id=8
// 常见：39=最强蜗牛 33=提灯与地下城 35=时光旅行社 58/69=仙剑 74=魔卡少女樱
let APP_ID  = '39';
let PAGE_ID = '1';
const BASE = 'https://api.qingcigame.com';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN';

const KEY_CK   = 'qc_ck';       // 会话
const KEY_LOCK = 'qc_lock';     // 防重入
const KEY_DONE = 'qc_done_';    // 当日完成标记
const KEY_INFO = 'qc_info_';    // 当日结果
const KEY_NOTE = 'qc_note_';    // 当日提醒标记

const ARG = (typeof $argument !== 'undefined' && $argument) ? String($argument) : '';
(function () {
  const a = /app_id=(\d+)/.exec(ARG);
  if (a) APP_ID = a[1];
  const p = /page_id=(\d+)/.exec(ARG);
  if (p) PAGE_ID = p[1];
})();
const IS_CAPTURE   = (typeof $request !== 'undefined');
const IS_RESPONSE  = (typeof $response !== 'undefined');
const IS_KEEPALIVE = !IS_CAPTURE && !IS_RESPONSE && /keepalive/i.test(ARG);

// ---------------- 工具 ----------------
function read(k) { try { return $persistentStore.read(k) || ''; } catch (e) { return ''; } }
function write(k, v) { try { $persistentStore.write(String(v), k); } catch (e) {} }
function localDay() {
  const d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function truthy(v) { return v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v) === '1'; }
function jparse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function notify(t, s, b) { try { $notification.post('[青瓷签到] ' + t, s || '', b || ''); } catch (e) {} }

// 当天只提醒一次（用于失败/过期场景，避免刷屏）
function notifyOnce(key, t, s, b) {
  const k = 'qc_n_' + key + '_' + localDay();
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

// ---------------- 签到流程 ----------------
async function doSign(cookie) {
  const H = hdrs(cookie);

  const my = await http('GET', '/game/my?game_id=' + APP_ID + '&page_id=' + PAGE_ID, H);
  const mj = jparse(my.body);
  if (!mj) return { ok: false, reason: '接口异常', detail: String(my.body).slice(0, 120) };
  if (mj.code !== 200) return { ok: false, reason: '会话无效或已过期' };

  // 顺手刷新会话
  const fresh = setCookies(my.headers);
  if (fresh.length) write(KEY_CK, mergeCookie(cookie, fresh));

  const u = (mj.data && mj.data.user_info) || {};
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
  let rj = jparse(rec.body);

  if (rj && String(rj.message || '').indexOf('绑定角色') >= 0) {
    await http('POST', '/game/binds', H, JSON.stringify({
      account: u.account, page_id: PAGE_ID, game_id: gameId, role_id: roleId, role_name: role,
      server_id: u.server_id, server_name: u.server_name,
      type: 'android', platform: u.platform || 'android', extra: u.extra || '{}',
    }));
    rec = await http('POST', '/game/sign/record', H,
      JSON.stringify({ app_id: APP_ID, page_id: PAGE_ID, game_id: gameId }));
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

// ---------------- 会话保活 ----------------
async function keepAlive() {
  const ck = read(KEY_CK);
  if (!ck) return; // 还没捕获过，静默（等用户开一次页面）

  const r = await http('GET', '/game/my?game_id=' + APP_ID + '&page_id=' + PAGE_ID, hdrs(ck));
  const j = jparse(r.body);

  if (j && j.code === 200) {
    const fresh = setCookies(r.headers);
    if (fresh.length) write(KEY_CK, mergeCookie(ck, fresh));
    return; // 续期成功，静默
  }

  // 会话已死：每天提醒一次
  notifyOnce('dead', '会话已失效', '在微信里打开一次活动页', '打开后会自动恢复保活');
}

// ---------------- 入口 ----------------
(async function () {
  const day = localDay();
  const doneKey = KEY_DONE + day;
  const infoKey = KEY_INFO + day;

  try {
    // ===== 模式0：响应捕获（直接从 Set-Cookie 捞新会话，最可靠）=====
    if (IS_RESPONSE) {
      const pairs = setCookies(($response && $response.headers) || {});
      if (pairs.length && pairs.some(function (p) { return /^PHPSESSID=/.test(p); })) {
        write(KEY_CK, mergeCookie(read(KEY_CK), pairs));
      }
      return $done({});
    }

    // ===== 模式2：保活 =====
    if (IS_KEEPALIVE) {
      await keepAlive();
      return $done();
    }

    let cookie = '';

    if (IS_CAPTURE) {
      const h = ($request && $request.headers) || {};
      for (const k in h) { if (k.toLowerCase() === 'cookie') cookie = h[k]; }
      if (cookie && /PHPSESSID=/.test(cookie)) write(KEY_CK, cookie);
    }
    if (!cookie) cookie = read(KEY_CK);

    if (!cookie) {
      if (!IS_CAPTURE) notify('尚未捕获会话', '在微信里打开一次活动页', '之后即可自动签到');
      return IS_CAPTURE ? $done({}) : $done();
    }

    // 今天已完成：capture 静默；cron 继续查真实状态
    if (read(doneKey) === '1' && IS_CAPTURE) return $done({});

    if (IS_CAPTURE) {
      const lock = Number(read(KEY_LOCK) || 0);
      if (Date.now() - lock < 60000) return $done({});
      write(KEY_LOCK, String(Date.now()));
    }

    const res = await doSign(cookie);
    if (res.ok) {
      write(doneKey, '1');
      write(infoKey, (res.role || '') + '|' + (res.total || 0));
      if (res.already) notify('今日已签到', res.role || '', '累计 ' + res.total + ' 天，无需重复');
      else notify('签到成功 ✅', res.role || '', '累计签到 ' + res.total + ' 天');
    } else {
      if (String(res.reason).indexOf('会话') >= 0) {
        notify('会话已过期', '在微信里打开一次活动页', '打开后会自动签到');
      } else {
        notify('签到未完成', res.reason || '', res.detail || '');
      }
    }
    return IS_CAPTURE ? $done({}) : $done();
  } catch (e) {
    if (!IS_CAPTURE && !IS_KEEPALIVE) notify('脚本异常', String(e && e.message ? e.message : e), '');
    return IS_CAPTURE ? $done({}) : $done();
  }
})();
