// Surge 环境模拟器：在 vm 中运行 qc_sign.js 并断言行为
const vm = require('vm');
const fs = require('fs');

const SRC = fs.readFileSync(process.argv[2], 'utf8');

function localDay(d) {
  d = d || new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 有状态的假服务端：POST /game/sign/record 之后 sign/list 才翻成已签
function server(opts) {
  opts = opts || {};
  let signed = !!opts.alreadySigned;
  return function (method, url) {
    if (url.indexOf('/game/my') >= 0) {
      if (opts.myErr) return { err: opts.myErr };
      if (opts.myStatus) return { status: opts.myStatus, body: opts.myBody || '' };
      return {
        headers: { 'Set-Cookie': 'PHPSESSID=refreshed123; path=/; HttpOnly' },
        body: JSON.stringify({ code: 200, data: { user_info: {
          user_id: 77, role_id: 'r1', game_id: '39', role_name: '蜗牛王',
          account: 'acc', server_id: 's1', server_name: '一服' } } }),
      };
    }
    if (url.indexOf('/game/sign/list') >= 0) {
      return { body: JSON.stringify({ code: 200, data: { is_get: signed, sign_total: signed ? 6 : 5 } }) };
    }
    if (url.indexOf('/game/sign/record') >= 0) {
      if (opts.recordErr) return { err: opts.recordErr };
      signed = true;
      return { body: JSON.stringify({ code: 200, message: 'ok' }) };
    }
    return { status: 404, body: '' };
  };
}

function makeEnv(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const notifications = [];
  const requests = [];
  const handler = opts.server || server(opts);

  const ctx = {
    console, setTimeout: (fn) => fn(), Date, JSON, Object, String, Number, Promise,
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { store[k] = v; },
    },
    $notification: { post: (t, s, b) => notifications.push({ t, s, b }) },
    $httpClient: {
      get: (opt, cb) => { requests.push({ method: 'GET', url: opt.url, headers: opt.headers });
        const r = handler('GET', opt.url); cb(r.err || null, r.err ? null : { status: r.status || 200, headers: r.headers || {} }, r.body || ''); },
      post: (opt, cb) => { requests.push({ method: 'POST', url: opt.url, headers: opt.headers, body: opt.body });
        const r = handler('POST', opt.url); cb(r.err || null, r.err ? null : { status: r.status || 200, headers: r.headers || {} }, r.body || ''); },
    },
    $done: () => {},
  };

  if (opts.url) ctx.$request = { url: opts.url, headers: opts.headers || {} };
  if (opts.responseHeaders) ctx.$response = { headers: opts.responseHeaders };
  if (opts.argument) ctx.$argument = opts.argument;

  return { ctx, store, notifications, requests };
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '\n         ' + JSON.stringify(extra)));
}

const today = localDay();
function run(env) { return new vm.Script(SRC).runInNewContext(env.ctx); }

(async () => {
  // 1 捕获
  console.log('\n[1] 捕获模式：只存会话与游戏，不发网络请求');
  const e1 = makeEnv({
    url: 'https://api.qingcigame.com/game/sign/list?game_id=58&role_id=x&app_id=58&page_id=8',
    headers: { Cookie: 'PHPSESSID=abc123; other=1' },
  });
  run(e1);
  check('无网络请求', e1.requests.length === 0, e1.requests);
  check('会话已存', e1.store.qc_ck === 'PHPSESSID=abc123; other=1', e1.store.qc_ck);
  check('学到目标游戏 58|8（非默认 39|1）', e1.store.qc_app === '58|8', e1.store.qc_app);

  // 2 正常签到
  console.log('\n[2] 维持模式：签到成功 + 会话续期 + 通知一次');
  const e2 = makeEnv({ store: { qc_ck: 'PHPSESSID=old; other=1' } });
  await run(e2);
  check('调用了签到接口', e2.requests.some((r) => r.url.indexOf('/game/sign/record') >= 0));
  check('会话已续期', String(e2.store.qc_ck).indexOf('refreshed123') >= 0, e2.store.qc_ck);
  check('当日完成标记', e2.store['qc_done_' + today] === '1', e2.store['qc_done_' + today]);
  check('成功通知 1 条', e2.notifications.length === 1 && /成功/.test(e2.notifications[0].t), e2.notifications);

  // 3 当日已签
  console.log('\n[3] 维持模式：当日已完成 → 只保活不重复签');
  const e3 = makeEnv({ store: { qc_ck: 'PHPSESSID=old', ['qc_done_' + today]: '1' } });
  await run(e3);
  check('未请求签到接口', !e3.requests.some((r) => r.url.indexOf('/game/sign/record') >= 0));
  check('无通知', e3.notifications.length === 0, e3.notifications);

  // 4 网络抖动
  console.log('\n[4] 网络抖动（P0-1 回归）：静默不报警');
  const e4 = makeEnv({ store: { qc_ck: 'PHPSESSID=old' }, myErr: 'network timeout' });
  await run(e4);
  check('无通知', e4.notifications.length === 0, e4.notifications);

  console.log('\n[4b] 网关 502 非 JSON：静默');
  const e4b = makeEnv({ store: { qc_ck: 'PHPSESSID=old' }, myStatus: 502, myBody: '<html>Bad Gateway</html>' });
  await run(e4b);
  check('无通知', e4b.notifications.length === 0, e4b.notifications);

  // 5 会话真死
  console.log('\n[5] 会话真死：每小时跑只提醒一次');
  const deadOpts = { store: { qc_ck: 'PHPSESSID=old' }, myStatus: 200, myBody: JSON.stringify({ code: 401, message: 'unauthenticated' }) };
  const e5 = makeEnv(deadOpts);
  await run(e5);
  const e5b = makeEnv({ store: Object.assign({}, e5.store), myStatus: 200, myBody: deadOpts.myBody });
  await run(e5b);
  check('两次运行合计仅 1 条', e5.notifications.length + e5b.notifications.length === 1,
    { first: e5.notifications, second: e5b.notifications });
  check('内容为会话失效', /会话已失效/.test((e5.notifications[0] || {}).t || ''), e5.notifications[0]);

  // 6 未捕获
  console.log('\n[6] 未捕获会话：每小时跑也不刷屏');
  const e6 = makeEnv({});
  await run(e6);
  const e6b = makeEnv({ store: Object.assign({}, e6.store) });
  await run(e6b);
  check('两次运行合计仅 1 条', e6.notifications.length + e6b.notifications.length === 1,
    { first: e6.notifications, second: e6b.notifications });

  // 7 响应捕获
  console.log('\n[7] 响应模式：Set-Cookie 合并，不阻塞');
  const e7 = makeEnv({
    responseHeaders: { 'Set-Cookie': 'PHPSESSID=new999; path=/, other=2; path=/' },
    store: { qc_ck: 'PHPSESSID=old; keep=1' },
  });
  run(e7);
  check('无网络请求', e7.requests.length === 0);
  check('会话已合并', String(e7.store.qc_ck).indexOf('new999') >= 0 && String(e7.store.qc_ck).indexOf('keep=1') >= 0, e7.store.qc_ck);

  // 8 argument 优先级
  console.log('\n[8] argument 优先于捕获存档');
  const e8 = makeEnv({ store: { qc_ck: 'PHPSESSID=x', qc_app: '58|8' }, argument: 'app_id=74&page_id=11' });
  await run(e8);
  check('请求打向 game_id=74', e8.requests[0].url.indexOf('game_id=74') >= 0, e8.requests[0].url);

  // 8b 无 argument 时跟随捕获存档
  console.log('\n[8b] 无 argument 时跟随捕获存档（P0-2 回归）');
  const e8b = makeEnv({ store: { qc_ck: 'PHPSESSID=x', qc_app: '58|8' } });
  await run(e8b);
  check('请求打向 game_id=58', e8b.requests[0].url.indexOf('game_id=58') >= 0, e8b.requests[0].url);

  // 9 已签到不重复通知
  console.log('\n[9] 游戏侧已签到：每小时跑只提醒一次');
  const e9 = makeEnv({ store: { qc_ck: 'PHPSESSID=x' }, alreadySigned: true });
  await run(e9);
  const e9b = makeEnv({ store: Object.assign({}, e9.store), alreadySigned: true });
  await run(e9b);
  check('两次运行合计仅 1 条', e9.notifications.length + e9b.notifications.length === 1,
    { first: e9.notifications, second: e9b.notifications });
  check('内容为今日已签到', /已签到/.test((e9.notifications[0] || {}).t || ''), e9.notifications[0]);

  // 10 清理
  console.log('\n[10] 清理只回收历史 key');
  const e10 = makeEnv({ store: { qc_ck: 'PHPSESSID=x', qc_lock: '12345', ['qc_info_' + today]: 'x' }, alreadySigned: true });
  await run(e10);
  check('遗留 qc_lock 已清', !e10.store.qc_lock, e10.store.qc_lock);
  check('会话保留（已续期）', String(e10.store.qc_ck).indexOf('refreshed123') >= 0, e10.store.qc_ck);
  check('今日 done 保留', e10.store['qc_done_' + today] === '1', e10.store['qc_done_' + today]);

  // 11 签到接口网络失败 → 不标记完成，下轮重试
  console.log('\n[11] 签到请求网络失败：不写完成标记，静默待重试');
  const e11 = makeEnv({ store: { qc_ck: 'PHPSESSID=x' }, recordErr: 'timeout' });
  await run(e11);
  check('未写完成标记', !e11.store['qc_done_' + today], e11.store['qc_done_' + today]);
  check('无通知', e11.notifications.length === 0, e11.notifications);

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length ? '❌ ' + failed.length + '/' + results.length + ' FAILED' : '✅ ' + results.length + '/' + results.length + ' passed'));
  process.exit(failed.length ? 1 : 0);
})();
