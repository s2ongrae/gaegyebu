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
function createAgent({ env, client, fetchImpl = globalThis.fetch, now = () => Date.now(), log = T.log, saveCopy = null }) {
  let lastSync = 0, handled = null, report;
  async function tick() {
    const j = await pollServer(env, report === undefined ? {} : { error: report }, fetchImpl);
    report = undefined;
    if (!j.pending || j.requestedAt === handled) return 'idle';
    if (now() - lastSync < MIN_SYNC_GAP_MS) return 'wait';
    handled = j.requestedAt; lastSync = now();
    try {
      const s = await T.collect(client, { accountSeq: env.TOSS_ACCOUNT_SEQ || null });
      if (saveCopy) saveCopy(s);
      await T.uploadSnapshot({ url: env.GAEGYEBU_SERVER_URL, key: env.GAEGYEBU_SERVER_KEY, snapshot: s, fetchImpl });
      log(`폰 요청(${j.requestedAt}) 처리 · 종목 ${s.items.length}개 · 평가 ${T.won(s.totals.value.krwTotal)}`);
      report = '';
      return 'synced';
    } catch (e) {
      let msg = e.message;
      if (e instanceof T.TossIpError) { const ip = await T.publicIp(fetchImpl); msg = '토스 허용 IP가 아닌 곳이에요(지금 ' + (ip || '?') + '). 집 와이파이인지 확인해 주세요.'; }
      log('✗ 동기화 실패: ' + msg);
      report = msg.slice(0, 300);
      return 'error';
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
  const client = new T.TossClient({ clientId: env.TOSS_CLIENT_ID, clientSecret: env.TOSS_CLIENT_SECRET });
  const snapDir = path.join(dataDir, 'toss-snapshots');
  const saveCopy = s => { try { fs.mkdirSync(snapDir, { recursive: true }); fs.writeFileSync(path.join(snapDir, s.date + '.json'), JSON.stringify(s, null, 2)); } catch (e) { /* 사본 실패는 무시 */ } };
  const agent = createAgent({ env, client, log, saveCopy });
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
