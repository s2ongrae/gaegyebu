// 대기 프로그램: 가계부 서버에 20초마다 "폰 🔄 에서 토스 현황을 받아 와 달라는 요청"이 있는지 묻고, 있으면 동기화(조회 전용 → 서버 저장).
// 사용: node agent.js          계속 실행(노트북 시작 시 자동 실행은 README 3번)
//       node agent.js --once   한 번만 확인하고 끝(시험용)
// 기록: ../gaegyebu-data/toss-agent.log (1MB 넘으면 앞부분을 버림). 두 번 켜도 하나만 돎(toss-agent.pid).
'use strict';
const fs = require('fs'), path = require('path');
const T = require('./toss');
const POLL_MS = Number(process.env.TOSS_AGENT_POLL_MS) || 20000;
const MIN_SYNC_GAP_MS = 60000; // 동기화는 1분에 한 번까지

async function pollServer(env, extra, fetchImpl) {
  T.registerSecret(env.GAEGYEBU_SERVER_KEY);
  const r = await fetchImpl(env.GAEGYEBU_SERVER_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ k: env.GAEGYEBU_SERVER_KEY, action: 'pollTossSync' }, extra)), redirect: 'follow' });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new T.TossError('가계부 서버 확인 실패: ' + (j.error || r.status));
  return j;
}

// 요청 하나는 한 번만 처리(실패해도 같은 요청으로 다시 하지 않음 → 폰에서 다시 누르면 새 요청)
// 2026-11-05 보강: ① 결과(성공/실패 이유)를 다음 확인을 기다리지 않고 바로 서버에 알림 ② 일시 오류(429·5xx·연결 끊김)는 retryMs 뒤 한 번 더
//   ③ 오류 종류 표시([IP]/[AUTH]/[API]/[SERVER]/[NET]) ④ 동기화마다 .env 를 다시 읽어 키를 바꾸면 바로 반영(getEnv·makeClient) ⑤ 노트북에 상태 파일
function createAgent({ env, getEnv = null, client = null, makeClient = null, fetchImpl = globalThis.fetch, now = () => Date.now(), log = T.log, saveCopy = null, saveStatus = null, sleep = ms => new Promise(r => setTimeout(r, ms)), retryMs = 5000 }) {
  let lastSync = 0, handled = null, report;
  const curEnv = () => (getEnv ? getEnv() : env);
  async function notify(e, error) { // 바로 알리고, 실패하면 다음 확인 때 실어 보냄
    const ok = await T.reportStatus({ url: e.GAEGYEBU_SERVER_URL, key: e.GAEGYEBU_SERVER_KEY, error, fetchImpl });
    report = ok ? undefined : error;
    if (saveStatus) saveStatus(error ? { ok: false, error } : { ok: true });
  }
  async function tick() {
    const e0 = curEnv();
    const j = await pollServer(e0, report === undefined ? {} : { error: report }, fetchImpl);
    report = undefined;
    if (!j.pending || j.requestedAt === handled) return 'idle';
    if (now() - lastSync < MIN_SYNC_GAP_MS) return 'wait';
    handled = j.requestedAt; lastSync = now();
    const e = curEnv(), c = makeClient ? makeClient(e) : client;
    for (let attempt = 1; ; attempt++) {
      try {
        const s = await T.collect(c, { accountSeq: e.TOSS_ACCOUNT_SEQ || null });
        if (saveCopy) saveCopy(s);
        await T.uploadSnapshot({ url: e.GAEGYEBU_SERVER_URL, key: e.GAEGYEBU_SERVER_KEY, snapshot: s, fetchImpl });
        log(`폰 요청(${j.requestedAt}) 처리 · 종목 ${s.items.length}개 · 평가 ${T.won(s.totals.value.krwTotal)}` + (attempt > 1 ? ' (재시도 성공)' : ''));
        await notify(e, '');
        return 'synced';
      } catch (err) {
        const cls = T.classifyError(err);
        if (cls.transient && attempt < 2) { log(`일시 오류 [${cls.code}] ${err.message} → ${retryMs / 1000}초 뒤 한 번 더`); await sleep(retryMs); continue; }
        let msg = T.errorText(err, cls);
        if (err instanceof T.TossIpError) { const ip = await T.publicIp(fetchImpl); msg = '[IP] 토스 허용 IP가 아닌 곳이에요(지금 ' + (ip || '?') + '). 집 와이파이인지, 토스 허용 IP가 지금 IP와 같은지 확인해 주세요.'; }
        log('✗ 동기화 실패: ' + msg);
        await notify(e, msg.slice(0, 300));
        return 'error';
      }
    }
  }
  return { tick };
}

if (require.main === module) {
  const env = T.loadEnv(), dataDir = path.dirname(env.__file);
  const logFile = path.join(dataDir, 'toss-agent.log'), pidFile = path.join(dataDir, 'toss-agent.pid');
  const log = (...a) => {
    const line = '[' + new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') + '] ' + T.mask(a.join(' '));
    console.log(line);
    try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.writeFileSync(logFile, fs.readFileSync(logFile, 'utf8').slice(-200 * 1024)); fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* 기록 실패는 무시 */ }
  };
  const once = process.argv.includes('--once');
  if (!once) {
    try { const old = Number(fs.readFileSync(pidFile, 'utf8')); if (old && old !== process.pid) { process.kill(old, 0); console.log('이미 실행 중이에요(pid ' + old + ').'); process.exit(0); } } catch (e) { /* 없거나 죽은 프로세스 */ }
    fs.writeFileSync(pidFile, String(process.pid));
    const bye = () => { try { if (Number(fs.readFileSync(pidFile, 'utf8')) === process.pid) fs.unlinkSync(pidFile); } catch (e) { /* 무시 */ } process.exit(0); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
  }
  // 동기화마다 .env 를 다시 읽어 키·주소를 바꾸면 재시작 없이 반영
  const getEnv = () => { try { return T.loadEnv(); } catch (e) { return env; } };
  const makeClient = e => new T.TossClient({ clientId: e.TOSS_CLIENT_ID, clientSecret: e.TOSS_CLIENT_SECRET });
  const snapDir = path.join(dataDir, 'toss-snapshots');
  const saveCopy = s => { try { fs.mkdirSync(snapDir, { recursive: true }); fs.writeFileSync(path.join(snapDir, s.date + '.json'), JSON.stringify(s, null, 2)); } catch (e) { /* 사본 실패는 무시 */ } };
  const saveStatus = st => T.writeStatusFile(env.__file, Object.assign({ by: 'agent' }, st));
  const agent = createAgent({ env, getEnv, makeClient, log, saveCopy, saveStatus });
  let lastErrLog = 0;
  const loop = async () => {
    try { const r = await agent.tick(); if (once) log('확인 결과: ' + r); }
    catch (e) { if (once || Date.now() - lastErrLog > 10 * 60000) { log('서버 확인 실패(인터넷·절전 중일 수 있음): ' + e.message); lastErrLog = Date.now(); } }
    if (!once) setTimeout(loop, POLL_MS);
  };
  log('대기 시작 · ' + POLL_MS / 1000 + '초마다 확인');
  loop();
}
module.exports = { createAgent, pollServer };
