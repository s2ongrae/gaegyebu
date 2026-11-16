// 대기 프로그램: 가계부 서버에 20초마다 "폰 🔄 에서 토스 현황을 받아 와 달라는 요청"이 있는지 묻고, 있으면 동기화(조회 전용 → 서버 저장).
// 사용: node agent.js          계속 실행(노트북 시작 시 자동 실행은 README 3번)
//       node agent.js --once   한 번만 확인하고 끝(시험용)
//       node agent.js --status 지금 상태(하트비트 파일·프로세스)만 보고 끝
// 기록: ../gaegyebu-data/toss-agent.log (1MB 넘으면 앞부분을 버림) · toss-agent-beat.json(살아 있음 증거, 20초마다)
// 두 번 켜도 하나만 돎(toss-agent.pid). 단, 살아 있는데 하트비트가 끊긴 프로세스(멈춤)는 정리하고 새로 시작한다.
//
// 2026-11-16 보강 — "11:06 이후 멈춤 · 16:10 누락" 재발 방지
//  ① 모든 네트워크 호출에 시간 제한(기본 30초). 응답이 없으면 끊고 다음 확인으로(예전엔 fetch 가 영원히 매달려 루프 전체가 멈출 수 있었다)
//  ② 워치독: 한 번 확인이 TOSS_AGENT_TICK_MAX_MS(기본 15분)를 넘으면 끊고 다음 확인을 예약(루프가 굳지 않는다)
//  ③ 실패하면 지수 백오프(20→40→80→160→300초, ±10% 흔들기), 성공하면 20초로 복귀
//  ④ 예상치 못한 예외(uncaughtException·unhandledRejection)는 기록만 하고 계속 실행(프로세스가 조용히 죽지 않게)
//  ⑤ 하트비트 파일(toss-agent-beat.json)을 매 확인마다 씀 → hub-agent 데몬이 이 파일로 생존을 판단하고 자동 재시작
//  ⑥ PID 재사용 오판 방지: pid 가 살아 있어도 하트비트가 끊겼으면 멈춘 것으로 보고 정리 후 시작
'use strict';
const fs = require('fs'), path = require('path');
const T = require('./toss');

const POLL_MS = Number(process.env.TOSS_AGENT_POLL_MS) || 20000;
const MIN_SYNC_GAP_MS = 60000; // 동기화는 1분에 한 번까지
const NET_TIMEOUT_MS = Number(process.env.TOSS_AGENT_TIMEOUT_MS) || 30000;   // 한 번의 HTTP 호출 상한
const TICK_MAX_MS = Number(process.env.TOSS_AGENT_TICK_MAX_MS) || 15 * 60000; // 한 번 확인 전체 상한(워치독)
const MAX_BACKOFF_MS = Number(process.env.TOSS_AGENT_MAX_BACKOFF_MS) || 5 * 60000;
const BEAT_LOG_MS = Number(process.env.TOSS_AGENT_BEAT_LOG_MS) || 5 * 60000;  // 로그에 하트비트를 남기는 간격
const VERSION = '2.0.0';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 네트워크 시간 제한 ──────────────────────────────────────────────
// fetch 는 스스로 끝나지 않을 수 있다(절전에서 깬 뒤 끊긴 소켓, 응답 없는 서버).
// 모든 호출을 AbortController 로 감싸 '끝나지 않는 기다림'이 루프를 잡아먹지 않게 한다.
function timedFetch(ms = NET_TIMEOUT_MS, base = globalThis.fetch) {
  return async function (url, opts) {
    const limit = Math.max(1000, Number(ms) || NET_TIMEOUT_MS);
    const fail = () => { const e = new Error('요청 시간 초과 ETIMEDOUT (' + Math.round(limit / 1000) + '초)'); e.code = 'ETIMEDOUT'; return e; };
    if (typeof base !== 'function') return Promise.reject(fail());
    // ① 실제 요청은 AbortController 로 끊고 ② 그래도 응답이 없으면 우리 타이머로 확실히 끝낸다(둘 다 필요)
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null, kill = null;
    const cutoff = new Promise((_, reject) => {
      kill = () => reject(fail());
      timer = setTimeout(() => { if (ac) { try { ac.abort(); } catch (e) { /* 무시 */ } } kill(); }, limit);
    });
    try {
      const req = ac ? base(url, Object.assign({}, opts, { signal: ac.signal })) : base(url, opts);
      return await Promise.race([req, cutoff]);
    } catch (err) {
      if (err && err.code === 'ETIMEDOUT') throw err;
      if (ac && ac.signal && ac.signal.aborted) throw fail();   // 시간 초과로 끊은 것 → NET(일시)로 분류되어 한 번 더 시도
      throw err;
    } finally { if (timer) clearTimeout(timer); }
  };
}

// 다음 확인까지 기다릴 시간(지수 백오프 + 흔들기). 실패 1회 → 20초, 2회 → 40초 … 최대 5분.
function nextDelay(fails, pollMs = POLL_MS, maxMs = MAX_BACKOFF_MS, random = Math.random) {
  if (!fails || fails <= 0) return pollMs;
  const base = Math.min(maxMs, pollMs * Math.pow(2, Math.min(fails - 1, 10)));
  return Math.max(pollMs, Math.round(base * (0.9 + random() * 0.2)));
}

// ── 하트비트(살아 있음 증거) ─────────────────────────────────────────
const BEAT_NAME = 'toss-agent-beat.json';
const PID_NAME = 'toss-agent.pid';
const kstString = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

function writeBeat(file, info) {
  try {
    const body = JSON.stringify(Object.assign({ v: 1, at: Date.now(), atKst: kstString(Date.now()), version: VERSION }, info));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);           // 반쯤 쓰인 파일을 다른 프로그램이 읽지 않게
    return true;
  } catch (e) { return false; }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function readPid(file) {                       // 예전 형식(숫자만)도 읽는다
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (/^\d+$/.test(raw)) return Number(raw);
    const j = JSON.parse(raw); return Number(j && j.pid) || 0;
  } catch (e) { return 0; }
}
function isAlive(pid) { try { if (!pid) return false; process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }

/**
 * 이미 도는 대기 프로그램이 있는지 확인한다.
 *  · 살아 있고 하트비트도 최신  → 새로 띄우지 않는다(중복 실행 방지)
 *  · 살아 있는데 하트비트가 끊김 → 멈춘 것으로 보고 정리한 뒤 새로 시작(자동 복구의 핵심)
 *  · pid 만 남아 있음(이미 종료)  → 그냥 새로 시작
 */
async function takeOver({ pidFile, beatFile, log = () => {}, staleMs = Math.max(3 * POLL_MS, 60000), killWaitMs = 3000, now = () => Date.now() } = {}) {
  const old = readPid(pidFile);
  if (!old || old === process.pid) return { ok: true, reason: 'none' };
  if (!isAlive(old)) return { ok: true, reason: 'dead', oldPid: old };
  const beat = readJson(beatFile);
  const beatAt = beat && Number(beat.at);
  const age = beatAt ? now() - beatAt : Infinity;
  if (Number(beat && beat.pid) === old && age <= staleMs) return { ok: false, reason: 'running', oldPid: old, beatAgeMs: age };
  log('pid ' + old + ' 은(는) 살아 있지만 하트비트가 ' + (isFinite(age) ? Math.round(age / 1000) + '초' : '아주 오래') + ' 끊겼어요 → 멈춘 것으로 보고 정리한 뒤 새로 시작합니다');
  try { process.kill(old, 'SIGTERM'); } catch (e) { /* 이미 없음 */ }
  const until = now() + killWaitMs;
  while (now() < until && isAlive(old)) await sleep(250);
  if (isAlive(old)) { try { process.kill(old, 'SIGKILL'); } catch (e) { /* 무시 */ } await sleep(500); }
  const died = !isAlive(old);
  if (!died) log('⚠ pid ' + old + ' 를 끝내지 못했어요(권한·응답 없음). 새 프로세스로 시작하지만 잠시 둘이 함께 돌 수 있습니다');
  return { ok: true, reason: 'hung', oldPid: old, killed: died };
}

// ── 서버 확인 ────────────────────────────────────────────────────────
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
function createAgent({ env, getEnv = null, client = null, makeClient = null, fetchImpl = globalThis.fetch, now = () => Date.now(), log = T.log, saveCopy = null, saveStatus = null, sleep = ms => new Promise(r => setTimeout(r, ms)), retryMs = 5000, maxAttempts = 2 }) {
  let lastSync = 0, handled = null, report, stats = { synced: 0, failed: 0, lastSyncAt: 0, lastError: '' };
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
    if (now() - lastSync < MIN_SYNC_GAP_MS) { log('요청(' + j.requestedAt + ')이 있지만 지난 동기화와 1분이 안 됐어요 → 다음 확인에 처리'); return 'wait'; }
    handled = j.requestedAt; lastSync = now();
    const e = curEnv(), c = makeClient ? makeClient(e) : client;
    for (let attempt = 1; ; attempt++) {
      try {
        const s = await T.collect(c, { accountSeq: e.TOSS_ACCOUNT_SEQ || null });
        if (saveCopy) saveCopy(s);
        await T.uploadSnapshot({ url: e.GAEGYEBU_SERVER_URL, key: e.GAEGYEBU_SERVER_KEY, snapshot: s, fetchImpl });
        log(`폰 요청(${j.requestedAt}) 처리 · 종목 ${s.items.length}개 · 평가 ${T.won(s.totals.value.krwTotal)}` + (attempt > 1 ? ' (재시도 성공)' : ''));
        stats.synced += 1; stats.lastSyncAt = now(); stats.lastError = '';
        await notify(e, '');
        return 'synced';
      } catch (err) {
        const cls = T.classifyError(err);
        if (cls.transient && attempt < maxAttempts) {
          const wait = retryMs * Math.pow(3, attempt - 1);          // 5초 → 15초 → …
          log(`일시 오류 [${cls.code}] ${err.message} → ${Math.round(wait / 1000)}초 뒤 한 번 더`);
          await sleep(wait); continue;
        }
        let msg = T.errorText(err, cls);
        if (err instanceof T.TossIpError) { const ip = await T.publicIp(fetchImpl); msg = '[IP] 토스 허용 IP가 아닌 곳이에요(지금 ' + (ip || '?') + '). 집 와이파이인지, 토스 허용 IP가 지금 IP와 같은지 확인해 주세요.'; }
        log('✗ 동기화 실패: ' + msg);
        stats.failed += 1; stats.lastError = msg.slice(0, 300);
        await notify(e, msg.slice(0, 300));
        return 'error';
      }
    }
  }
  return { tick, stats: () => Object.assign({}, stats) };
}

// ── 폴링 루프(스스로 굳지 않게) ─────────────────────────────────────
// tick 이 끝나지 않아도 워치독이 끊고 다음 확인을 예약한다. 예약은 한 곳(finally)에서만 한다.
function createPoller({ tick, pollMs = POLL_MS, maxBackoffMs = MAX_BACKOFF_MS, tickMaxMs = TICK_MAX_MS, log = () => {}, now = () => Date.now(), random = Math.random, onBeat = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false, inflight = false, timer = null, fails = 0, polls = 0, timeouts = 0, recovered = 0;
  let lastPollAt = 0, lastPollOk = null, lastError = '', nextAt = 0, lastResult = null, startedAt = now(), lastBeatLog = now();
  const WATCHDOG = { __watchdog: true };
  function snapshot() {
    return { polls, fails, timeouts, recovered, lastPollAt, lastPollOk, lastError, nextAt, lastResult, startedAt, inflight, pollMs, tickMaxMs, delayMs: nextAt ? Math.max(0, nextAt - now()) : null };
  }
  function beat(result) { if (!onBeat) return; try { onBeat(Object.assign(snapshot(), { lastResult: result })); } catch (e) { /* 하트비트 실패는 무시 */ } }
  function schedule(delay) {
    if (stopped) return;
    nextAt = now() + delay;
    timer = setTimer(() => { timer = null; runOnce(); }, delay);   // unref 하지 않는다 — 이 타이머가 프로세스를 살려 둔다
  }
  async function runOnce() {
    if (stopped || inflight) return lastResult;
    inflight = true; lastPollAt = now();
    let guard = null;
    const hung = new Promise(resolve => { guard = setTimer(() => resolve(WATCHDOG), tickMaxMs); });
    let result;
    try {
      const p = Promise.resolve().then(tick);
      p.catch(() => {});                       // 워치독으로 먼저 끝난 뒤 늦게 실패해도 미처리 예외가 되지 않게
      const r = await Promise.race([p, hung]);
      if (r === WATCHDOG) {
        timeouts += 1; fails += 1; lastPollOk = false;
        lastError = '워치독 · 확인이 ' + Math.round(tickMaxMs / 1000) + '초를 넘었어요';
        log('⚠ ' + lastError + ' → 끊고 다음 확인으로 넘어갑니다(지난 요청은 백그라운드에 남음)');
        result = 'timeout';
      } else {
        if (fails > 0) { recovered += 1; log('복구됐어요 · 지난 실패 ' + fails + '회 뒤 정상 확인'); }
        fails = 0; lastPollOk = true; lastError = ''; result = r;
      }
    } catch (err) {
      fails += 1; lastPollOk = false; lastError = String((err && err.message) || err).slice(0, 300); result = 'error';
      // 같은 오류가 반복되면 10분에 한 번만 남긴다
      if (fails === 1 || Date.now() - lastBeatLog > 10 * 60000) log('확인 실패: ' + lastError);
    } finally {
      if (guard) clearTimer(guard);
      inflight = false; polls += 1; lastResult = result;
      const delay = fails > 0 ? nextDelay(fails, pollMs, maxBackoffMs, random) : pollMs;
      beat(result);
      if (fails > 0) log('다음 확인은 ' + Math.round(delay / 1000) + '초 뒤(' + (fails > 1 ? '연속 실패 ' + fails + '회 · 최대 ' + Math.round(maxBackoffMs / 1000) + '초까지 늘어남' : '첫 실패') + ')');
      if (now() - lastBeatLog >= BEAT_LOG_MS) { lastBeatLog = now(); log('♥ 살아 있음 · 확인 ' + polls + '회 · 실패 ' + fails + ' · 마지막 ' + kstString(lastPollAt) + (lastError ? ' · ' + lastError : '')); }
      schedule(delay);
    }
    return result;
  }
  let reaper = null;
  // 마지막 안전장치: 어떤 이유로든 예약이 비어 있으면 다시 채운다(루프가 조용히 멈추는 일 방지)
  function armReaper() {
    if (stopped) return;
    reaper = setTimer(() => {
      if (!stopped && !inflight && !timer) { log('⚠ 확인 예약이 비어 있었어요 → 다시 예약합니다'); schedule(pollMs); }
      armReaper();
    }, Math.max(pollMs * 3, 60000));
    if (reaper && typeof reaper.unref === 'function') reaper.unref();
  }
  return {
    start() {
      log('대기 시작 · ' + (pollMs / 1000) + '초마다 확인 · 호출 제한 ' + Math.round(NET_TIMEOUT_MS / 1000) + '초 · 워치독 ' + Math.round(tickMaxMs / 1000) + '초');
      armReaper();
      runOnce();
    },
    stop() { stopped = true; if (timer) { clearTimer(timer); timer = null; } if (reaper) { clearTimer(reaper); reaper = null; } },
    runOnce, snapshot
  };
}

// ── 실행 ────────────────────────────────────────────────────────────
function makeLogger(env) {
  const dataDir = path.dirname(env.__file);
  const logFile = path.join(dataDir, 'toss-agent.log');
  return (...a) => {
    const line = '[' + kstString(Date.now()) + '] ' + T.mask(a.join(' '));
    try { console.log(line); } catch (e) { /* 콘솔이 없어도(VBS 실행) 기록은 남긴다 */ }
    try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.writeFileSync(logFile, fs.readFileSync(logFile, 'utf8').slice(-200 * 1024)); fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* 기록 실패는 무시 */ }
  };
}

async function run() {
  const env = T.loadEnv();
  const dataDir = path.dirname(env.__file);
  const log = makeLogger(env);
  const logFile = path.join(dataDir, 'toss-agent.log'), pidFile = path.join(dataDir, PID_NAME), beatFile = path.join(dataDir, BEAT_NAME);
  const once = process.argv.includes('--once');
  const statusOnly = process.argv.includes('--status');

  if (statusOnly) {
    const beat = readJson(beatFile), pid = readPid(pidFile);
    const ageMs = beat && beat.at ? Date.now() - Number(beat.at) : null;
    const out = { pidFile: pidFile, pid, alive: isAlive(pid), beatFile: beatFile, beat, beatAgeSec: ageMs === null ? null : Math.round(ageMs / 1000), statusFile: readJson(path.join(dataDir, 'toss-sync-status.json')) };
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  if (!once) {
    const staleMs = Number(process.env.TOSS_AGENT_STALE_MS) || Math.max(3 * POLL_MS, 60000);
    const take = await takeOver({ pidFile, beatFile, log, staleMs });
    if (!take.ok) { log('이미 실행 중이에요(pid ' + take.oldPid + ' · 하트비트 ' + Math.round(take.beatAgeMs / 1000) + '초 전).'); return 0; }
    if (take.reason === 'hung') log('멈춘 대기 프로그램을 정리하고 새로 시작합니다' + (take.killed === false ? ' (강제 종료 실패 — 그래도 새 프로세스로 진행)' : ''));
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* 무시 */ }
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: VERSION }));
  }

  // 동기화마다 .env 를 다시 읽어 키·주소를 바꾸면 재시작 없이 반영
  const getEnv = () => { try { return T.loadEnv(); } catch (e) { return env; } };
  const makeClient = e => new T.TossClient({ clientId: e.TOSS_CLIENT_ID, clientSecret: e.TOSS_CLIENT_SECRET, fetchImpl: timedFetch(NET_TIMEOUT_MS) });
  const snapDir = path.join(dataDir, 'toss-snapshots');
  const saveCopy = s => { try { fs.mkdirSync(snapDir, { recursive: true }); fs.writeFileSync(path.join(snapDir, s.date + '.json'), JSON.stringify(s, null, 2)); } catch (e) { /* 사본 실패는 무시 */ } };
  const saveStatus = st => T.writeStatusFile(env.__file, Object.assign({ by: 'agent' }, st));
  const agent = createAgent({ env, getEnv, makeClient, log, saveCopy, saveStatus, fetchImpl: timedFetch(NET_TIMEOUT_MS) });

  // 하트비트를 쓰기 전에 '내가 아직 주인인지' 확인한다 — 자동 복구로 새 프로세스가 이어받았으면 조용히 물러난다(두 개가 번갈아 쓰는 일 방지)
  const writeBeatNow = st => {
    try {
      const owner = readPid(pidFile);
      if (!once && owner && owner !== process.pid) { log('pid 파일 주인이 pid ' + owner + ' 로 바뀌었어요 → 이 프로세스는 종료합니다'); process.exit(0); }
    } catch (e) { /* 무시 */ }
    writeBeat(beatFile, Object.assign({ pid: process.pid, mode: once ? 'once' : 'poll' }, st, agent.stats()));
  };
  const bye = (why = 'signal') => {
    try { const cur = readPid(pidFile); if (cur === process.pid) fs.unlinkSync(pidFile); } catch (e) { /* 무시 */ }
    try { writeBeat(beatFile, Object.assign({ pid: process.pid, mode: 'stopped', stoppedBy: why, lastPollAt: 0, nextAt: 0 }, agent.stats())); } catch (e) { /* 무시 */ }
    process.exit(0);
  };
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => { try { process.on(sig, () => bye(sig)); } catch (e) { /* 윈도우에 없는 신호 */ } });
  if (process.platform === 'win32') { try { process.on('SIGBREAK', () => bye('SIGBREAK')); } catch (e) { /* 무시 */ } }
  // 예상치 못한 예외로 조용히 죽지 않게 — 기록하고 계속 돈다(다음 확인이 스스로 복구한다)
  process.on('uncaughtException', err => { try { log('⚠ 예상치 못한 오류(계속 실행): ' + ((err && err.stack) || err)); } catch (e) { /* 무시 */ } });
  process.on('unhandledRejection', err => { try { log('⚠ 처리되지 않은 거절(계속 실행): ' + ((err && err.stack) || err)); } catch (e) { /* 무시 */ } });
  process.on('exit', () => { try { const cur = readPid(pidFile); if (!once && cur === process.pid) fs.unlinkSync(pidFile); } catch (e) { /* 무시 */ } });

  if (once) {
    let r = 'error';
    try { r = await agent.tick(); } catch (e) { log('확인 실패: ' + ((e && e.message) || e)); }
    writeBeatNow({ lastResult: r, polls: 1 });
    log('확인 결과: ' + r);
    return r === 'error' ? 1 : 0;
  }

  const poller = createPoller({ tick: () => agent.tick(), pollMs: POLL_MS, maxBackoffMs: MAX_BACKOFF_MS, tickMaxMs: TICK_MAX_MS, log, onBeat: writeBeatNow });
  writeBeatNow({ polls: 0, lastResult: 'starting' });
  poller.start();
  return null;              // 계속 실행
}

if (require.main === module) {
  run().then(code => { if (code !== null && code !== undefined) process.exit(code); }).catch(err => {
    try { console.error('치명적 오류: ' + ((err && err.stack) || err)); } catch (e) { /* 무시 */ }
    process.exit(1);
  });
}
module.exports = { createAgent, pollServer, createPoller, timedFetch, nextDelay, takeOver, writeBeat, readJson, readPid, isAlive, kstString, VERSION };
