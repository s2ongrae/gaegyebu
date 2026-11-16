// 2026-11-16 보강 검증 — "멈춤·누락" 재발 방지 장치
//  · 네트워크 호출 시간 제한(끝나지 않는 fetch 가 루프를 잡아먹지 않게)
//  · 워치독(한 번 확인이 상한을 넘으면 끊고 다음 확인 예약)
//  · 지수 백오프(20→40→80→160→300초)
//  · 하트비트 파일(살아 있음 증거) · PID 재사용/멈춤 판정(takeOver)
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, execFileSync } = require('child_process');
const T = require('../toss');
const A = require('../agent');
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? pass++ : fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : '→ ' + JSON.stringify(d)); };
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tsync2-'));

(async () => {
  console.log('[7] 네트워크 호출 시간 제한');
  {
    const never = () => new Promise(() => {});                     // 절대 끝나지 않는 fetch
    const f = A.timedFetch(60, never);
    const t0 = Date.now();
    let err = null; try { await f('https://example.invalid', {}); } catch (e) { err = e; }
    check('응답 없는 호출은 제한 시간에 끊긴다', !!err && /ETIMEDOUT/.test(err.message) && Date.now() - t0 < 1500, err && err.message);
    check('끊긴 오류는 [NET] 일시 오류로 분류(자동 재시도 대상)', T.classifyError(err).code === 'NET' && T.classifyError(err).transient === true, T.classifyError(err));
    const okBody = { ok: true };
    const fine = A.timedFetch(1000, async () => ({ status: 200, json: async () => okBody }));
    check('정상 호출은 그대로 통과', (await (await fine('https://example.invalid', {})).json()).ok === true);
  }

  console.log('\n[8] 지수 백오프');
  {
    const p = 20000, max = 300000;
    const d = n => A.nextDelay(n, p, max, () => 0.5);
    check('실패 0회는 기본 20초', d(0) === 20000);
    check('1→20 · 2→40 · 3→80 · 4→160초', d(1) === 20000 && d(2) === 40000 && d(3) === 80000 && d(4) === 160000, [d(1), d(2), d(3), d(4)]);
    check('최대 5분을 넘지 않는다', d(9) === 300000 && d(30) === 300000, [d(9), d(30)]);
    const lo = A.nextDelay(2, p, max, () => 0), hi = A.nextDelay(2, p, max, () => 0.999999);
    check('±10% 흔들기(같은 초에 몰리지 않게)', lo >= 36000 && hi <= 44000 && lo !== hi, [lo, hi]);
  }

  console.log('\n[9] 폴러 워치독·오류·예약');
  {
    const scheduled = [], logs = [];
    const setTimer = (fn, ms) => { if (ms <= 6000) return setTimeout(fn, ms); scheduled.push(ms); return { unref() {} }; }; // 6초 이하=워치독, 그 위=다음 확인 간격
    const clearTimer = t => { try { clearTimeout(t); } catch (e) { /* 무시 */ } };
    const hung = A.createPoller({ tick: () => new Promise(() => {}), pollMs: 20000, tickMaxMs: 80, log: s => logs.push(s), setTimer, clearTimer, random: () => 0.5 });
    const r1 = await hung.runOnce();
    check('끝나지 않는 확인은 워치독이 끊는다', r1 === 'timeout', r1);
    check('끊긴 뒤에도 다음 확인을 예약한다(루프가 굳지 않음)', scheduled.length === 1 && scheduled[0] >= 18000 && scheduled[0] <= 22000, scheduled);
    check('워치독 사실을 로그에 남긴다', logs.some(l => /워치독/.test(l)), logs);

    const sched2 = [], logs2 = [];
    let calls = 0;
    const flaky = A.createPoller({ tick: async () => { calls++; if (calls <= 2) throw new Error('가계부 서버 확인 실패: 500'); return 'idle'; }, pollMs: 20000, tickMaxMs: 5000, log: s => logs2.push(s), setTimer: (fn, ms) => { if (ms <= 6000) return setTimeout(fn, ms); sched2.push(ms); return { unref() {} }; }, clearTimer: () => {}, random: () => 0.5 });
    check('확인 실패는 error 로 끝나고 죽지 않는다', await flaky.runOnce() === 'error');
    check('첫 실패 뒤 20초, 두 번째 실패 뒤 40초', sched2[0] === 20000 && (await flaky.runOnce()) === 'error' && sched2[1] === 40000, sched2);
    check('성공하면 20초로 복귀 + 복구 로그', await flaky.runOnce() === 'idle' && sched2[2] === 20000 && logs2.some(l => /복구/.test(l)), sched2);
  }

  console.log('\n[10] 하트비트 파일 · PID 판정');
  {
    const dir = tmpdir();
    const beatFile = path.join(dir, 'toss-agent-beat.json'), pidFile = path.join(dir, 'toss-agent.pid');
    check('하트비트를 쓴다(pid·시각·확인 횟수)', A.writeBeat(beatFile, { pid: 1234, polls: 7, fails: 0 }) &&
      JSON.parse(fs.readFileSync(beatFile, 'utf8')).polls === 7 && !fs.existsSync(beatFile + '.tmp'));
    check('예전 형식(숫자만) pid 파일도 읽는다', (fs.writeFileSync(pidFile, '4321'), A.readPid(pidFile) === 4321));
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 4321, startedAt: 1 }));
    check('새 형식(JSON) pid 파일도 읽는다', A.readPid(pidFile) === 4321);

    // 살아 있는 자식 프로세스를 "멈춘 대기 프로그램"으로 꾸며 본다
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 250));
    fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid }));
    A.writeBeat(beatFile, { pid: child.pid, at: Date.now() - 600000 });
    const stale = A.readJson(beatFile);
    stale.at = Date.now() - 600000; fs.writeFileSync(beatFile, JSON.stringify(stale));
    const t1 = await A.takeOver({ pidFile, beatFile, log: () => {}, staleMs: 60000, killWaitMs: 3000 });
    check('살아 있지만 하트비트가 끊긴 프로세스는 정리하고 새로 시작', t1.ok === true && t1.reason === 'hung', t1);
    await new Promise(r => setTimeout(r, 300));
    check('정리한 프로세스는 실제로 종료됐다', !A.isAlive(child.pid));

    const child2 = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 250));
    fs.writeFileSync(pidFile, JSON.stringify({ pid: child2.pid }));
    A.writeBeat(beatFile, { pid: child2.pid, at: Date.now() });
    const t2 = await A.takeOver({ pidFile, beatFile, log: () => {}, staleMs: 60000 });
    check('살아 있고 하트비트도 최신이면 중복 실행하지 않는다', t2.ok === false && t2.reason === 'running', t2);
    try { process.kill(child2.pid, 'SIGKILL'); } catch (e) { /* 무시 */ }

    fs.writeFileSync(pidFile, JSON.stringify({ pid: 999999 }));
    const t3 = await A.takeOver({ pidFile, beatFile, log: () => {}, staleMs: 60000 });
    check('이미 끝난 pid 만 남아 있으면 그냥 시작', t3.ok === true && t3.reason === 'dead', t3);

    fs.unlinkSync(pidFile); fs.unlinkSync(beatFile);
    const t4 = await A.takeOver({ pidFile, beatFile, log: () => {} });
    check('pid 파일이 없으면 그냥 시작', t4.ok === true && t4.reason === 'none', t4);
  }

  console.log('\n[11] 서버 확인 자체가 매달려도 동기화 안전(동기화 중 예외 포함)');
  {
    const never = () => new Promise(() => {});
    const f = A.timedFetch(50, never);
    let err = null; try { await A.pollServer({ GAEGYEBU_SERVER_URL: 'https://example.invalid', GAEGYEBU_SERVER_KEY: 'k'.repeat(64) }, {}, f); } catch (e) { err = e; }
    check('서버 확인이 응답 없으면 시간 초과로 끝난다', !!err && /ETIMEDOUT/.test(err.message), err && err.message);
  }

  console.log('\n결과: ' + pass + ' 통과 · ' + fail + ' 실패');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('시험 자체가 실패:', e); process.exit(1); });
