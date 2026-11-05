// 2026-11-05 보강 검증: 결과 바로 알림 · 일시 오류 재시도 · 오류 종류 표시 · .env 다시 읽기 · 상태 파일 · sync.js 실패 알림
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const T = require('../toss'); const { createAgent } = require('../agent');
let pass = 0, fail = 0; const check = (n, c, d) => { c ? pass++ : fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : '→ ' + JSON.stringify(d)); };
const SKEY = 'k'.repeat(64), ID = 'test-client-id-123456', SECRET = 'test-secret-abcdefghijk';
function fakeGaegyebu() { // 가짜 가계부 서버: 요청 상태 · 알림 기록 · 저장
  const gs = { req: null, saved: null, polls: [], saves: 0, errHist: [] };
  const fetchImpl = async (u, o) => { const b = o && o.body ? JSON.parse(o.body) : {}; let out;
    if (u.includes('ipify')) out = { ip: '5.6.7.8' };
    else if (b.action === 'pollTossSync') { gs.polls.push(b); if ('error' in b) gs.errHist.push(b.error); out = { ok: true, pending: !!gs.req && (!gs.saved || gs.req > gs.saved), requestedAt: gs.req }; }
    else if (b.action === 'saveStockSnapshot') { gs.saves++; gs.saved = new Date(Date.now() + gs.saves * 10).toISOString(); out = { ok: true, saved: true, historyCount: 1 }; }
    return { status: 200, json: async () => out }; };
  return { gs, fetchImpl };
}
const env = { GAEGYEBU_SERVER_URL: 'https://example.invalid/exec', GAEGYEBU_SERVER_KEY: SKEY };
const okSnap = { v: 1, source: 'tossinvest-openapi', at: '2026-11-05T10:00:00+09:00', date: '2026-11-05', items: [{ symbol: 'A', valueKRW: 1, qty: 1, weight: 1 }], totals: { value: { krwTotal: 1 } }, cash: {}, accounts: [] };
(async () => {
  console.log('[1] 결과를 바로 알림');
  let { gs, fetchImpl } = fakeGaegyebu(); let calls = 0;
  const fakeClient = {}; const origCollect = T.collect;
  T.collect = async () => { calls++; return okSnap; };
  let st = [];
  let ag = createAgent({ env, client: fakeClient, fetchImpl, log: () => {}, saveStatus: x => st.push(x), sleep: async () => {} });
  gs.req = new Date().toISOString();
  check('성공하면 같은 차례에 바로 서버에 성공("") 알림', await ag.tick() === 'synced' && gs.errHist.slice(-1)[0] === '' && gs.saves === 1, gs.errHist);
  check('노트북 상태 파일 기록(성공)', st.length === 1 && st[0].ok === true);

  console.log('[2] 일시 오류는 한 번 더, 안 되면 이유를 바로 알림');
  ({ gs, fetchImpl } = fakeGaegyebu()); calls = 0; st = []; let slept = [];
  T.collect = async () => { calls++; if (calls === 1) throw new T.TossApiError('토스 API 오류 503', { status: 503 }); return okSnap; };
  ag = createAgent({ env, client: fakeClient, fetchImpl, log: () => {}, saveStatus: x => st.push(x), sleep: async ms => slept.push(ms), retryMs: 5000 });
  gs.req = new Date().toISOString();
  check('503 한 번은 5초 뒤 다시 해서 성공', await ag.tick() === 'synced' && calls === 2 && slept[0] === 5000 && gs.saves === 1, { calls, slept });
  ({ gs, fetchImpl } = fakeGaegyebu()); calls = 0; st = []; slept = [];
  T.collect = async () => { calls++; throw new T.TossApiError('토스 API 오류 429', { status: 429 }); };
  ag = createAgent({ env, client: fakeClient, fetchImpl, log: () => {}, saveStatus: x => st.push(x), sleep: async ms => slept.push(ms) });
  gs.req = new Date().toISOString();
  check('계속 실패하면 2번에서 멈추고 [API] 이유를 바로 알림', await ag.tick() === 'error' && calls === 2 && /^\[API\]/.test(gs.errHist.slice(-1)[0] || '') && st[0].ok === false, gs.errHist);
  ({ gs, fetchImpl } = fakeGaegyebu()); calls = 0;
  T.collect = async () => { calls++; throw new T.TossAuthError('토큰 발급 실패(401 invalid_client)'); };
  ag = createAgent({ env, client: fakeClient, fetchImpl, log: () => {}, sleep: async () => {} });
  gs.req = new Date().toISOString();
  check('키 오류는 재시도 없이 [AUTH]와 해결 힌트', await ag.tick() === 'error' && calls === 1 && /^\[AUTH\].*토스 키 확인/.test(gs.errHist.slice(-1)[0]), gs.errHist);
  ({ gs, fetchImpl } = fakeGaegyebu());
  T.collect = async () => { throw new T.TossIpError('허용 IP가 아닌 곳에서 호출했어요(403).', { status: 403 }); };
  ag = createAgent({ env, client: fakeClient, fetchImpl, log: () => {}, sleep: async () => {} });
  gs.req = new Date().toISOString();
  check('허용 IP 오류는 [IP]와 지금 공인 IP를 바로 알림', await ag.tick() === 'error' && /^\[IP\].*5\.6\.7\.8/.test(gs.errHist.slice(-1)[0]), gs.errHist);
  check('알림 본문에 토스 키·가계부 키 없음(가계부 키는 인증 칸에만)', gs.polls.every(p => !JSON.stringify(p.error || '').includes(SECRET) && !String(p.error || '').includes(SKEY)));

  console.log('[3] 서버 알림이 실패하면 다음 확인 때 다시');
  ({ gs, fetchImpl } = fakeGaegyebu()); let down = true;
  const flaky = async (u, o) => { const b = JSON.parse(o.body); if (down && b.action === 'pollTossSync' && 'error' in b) throw new Error('fetch failed'); return fetchImpl(u, o); };
  T.collect = async () => { throw new T.TossAuthError('토큰 발급 실패'); };
  ag = createAgent({ env, client: fakeClient, fetchImpl: flaky, log: () => {}, sleep: async () => {} });
  gs.req = new Date().toISOString();
  await ag.tick(); down = false; await ag.tick();
  check('바로 알리기가 실패했으면 다음 확인에 실어 보냄', /^\[AUTH\]/.test(gs.errHist.slice(-1)[0] || ''), gs.errHist);

  console.log('[4] .env 를 다시 읽음');
  ({ gs, fetchImpl } = fakeGaegyebu()); const seen = [];
  T.collect = async c => { seen.push(c.tag); return okSnap; };
  let cur = Object.assign({ TOSS_CLIENT_ID: 'old' }, env);
  ag = createAgent({ env: cur, getEnv: () => cur, makeClient: e => ({ tag: e.TOSS_CLIENT_ID }), fetchImpl, log: () => {}, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 61000); })() });
  gs.req = new Date().toISOString(); await ag.tick();
  cur = Object.assign({ TOSS_CLIENT_ID: 'new' }, env); gs.req = new Date(Date.now() + 1000).toISOString(); await ag.tick();
  check('키를 바꾸면 재시작 없이 다음 동기화에 새 키 사용', JSON.stringify(seen) === JSON.stringify(['old', 'new']), seen);
  T.collect = origCollect;

  console.log('[5] 오류 구분 · 상태 파일');
  const C = e => T.classifyError(e).code;
  check('IP·AUTH·API(429·500 일시)·NET(일시)·SERVER 구분', C(new T.TossIpError('x')) === 'IP' && C(new T.TossAuthError('x')) === 'AUTH' && T.classifyError(new T.TossApiError('x', { status: 429 })).transient && !T.classifyError(new T.TossApiError('x', { status: 400 })).transient && T.classifyError(new Error('fetch failed')).code === 'NET' && C(new T.TossError('가계부 서버 저장 실패: unauthorized')) === 'SERVER');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsync-')), envf = path.join(dir, '.env');
  check('상태 파일은 .env 옆 toss-sync-status.json', T.writeStatusFile(envf, { ok: false, error: '[IP] x' }) && JSON.parse(fs.readFileSync(path.join(dir, 'toss-sync-status.json'), 'utf8')).error === '[IP] x');

  console.log('[6] sync.js 실패도 서버·상태 파일·종료 코드로 알림');
  let got = null; const srv = http.createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { got = JSON.parse(b); r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"ok":true}'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  fs.writeFileSync(envf, `TOSS_CLIENT_ID=${ID}\nTOSS_CLIENT_SECRET=${SECRET}\nGAEGYEBU_SERVER_URL=http://127.0.0.1:${srv.address().port}/exec\nGAEGYEBU_SERVER_KEY=${SKEY}\n`);
  const { spawn } = require('child_process');
  const code = await new Promise(res => { const p = spawn(process.execPath, [path.join(__dirname, '..', 'sync.js')], { env: Object.assign({}, process.env, { TOSS_ENV_FILE: envf, NODE_OPTIONS: '' }), stdio: 'pipe' }); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.on('exit', c => res({ c, out })); setTimeout(() => p.kill(), 40000); });
  srv.close();
  const stf = JSON.parse(fs.readFileSync(path.join(dir, 'toss-sync-status.json'), 'utf8'));
  check('토스 접속 실패 → 서버에 이유 알림(pollTossSync error)', got && got.action === 'pollTossSync' && /^\[(NET|API|IP|AUTH)\]/.test(got.error), got);
  check('상태 파일에 실패·종류 기록, 종료 코드 0 아님', stf.ok === false && !!stf.code && code.c !== 0, { stf, c: code.c });
  check('출력·알림에 비밀값 없음', !code.out.includes(SECRET) && !JSON.stringify(got).includes(SECRET), code.out.slice(0, 200));
  console.log(`결과: PASS ${pass} / FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 중단:', e); process.exit(1); });
