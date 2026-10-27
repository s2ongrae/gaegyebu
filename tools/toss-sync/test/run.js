// 토스 동기화 도구 테스트 — 실제 토스 서버·실제 데이터 없이, 공식 명세(v1.2.14)와 같은 모양의 가짜 서버로 검증
'use strict';
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const T = require('../toss');
let pass = 0, fail = 0; const check = (n, c, d) => { c ? pass++ : fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : '→ ' + JSON.stringify(d)); };
const ID = 'test-client-id-123456', SECRET = 'test-secret-abcdefghijk', SKEY = 'k'.repeat(64);

// ── 가짜 토스 서버 ──
function mockToss(opts = {}) {
  const st = { token: 0, calls: [], mode: opts.mode || 'ok', once401: !!opts.once401, once429: !!opts.once429, tokN: 0 };
  const H = { // 가짜 보유 현황: 국내 2종목 + 미국 1종목
    totalPurchaseAmount: { krw: '10000000', usd: '1000.00' },
    marketValue: { amount: { krw: '12000000', usd: '1200.00' }, amountAfterCost: { krw: '11950000', usd: '1195.00' } },
    profitLoss: { amount: { krw: '2000000', usd: '200.00' }, amountAfterCost: { krw: '1950000', usd: '195.00' }, rate: '0.2', rateAfterCost: '0.19' },
    dailyProfitLoss: { amount: { krw: '120000', usd: '-10.00' }, rate: '0.01' },
    items: [
      { symbol: '005930', name: '삼성전자', marketCountry: 'KR', currency: 'KRW', quantity: '100', lastPrice: '80000', averagePurchasePrice: '70000', marketValue: { purchaseAmount: '7000000', amount: '8000000', amountAfterCost: '7970000' }, profitLoss: { amount: '1000000', amountAfterCost: '970000', rate: '0.142857', rateAfterCost: '0.1386' }, dailyProfitLoss: { amount: '100000', rate: '0.0126' }, cost: { commission: '1200', tax: '28800' } },
      { symbol: '000660', name: 'SK하이닉스', marketCountry: 'KR', currency: 'KRW', quantity: '20', lastPrice: '200000', averagePurchasePrice: '150000', marketValue: { purchaseAmount: '3000000', amount: '4000000', amountAfterCost: '3980000' }, profitLoss: { amount: '1000000', amountAfterCost: '980000', rate: '0.3333', rateAfterCost: '0.3267' }, dailyProfitLoss: { amount: '20000', rate: '0.005' }, cost: { commission: '600', tax: null } },
      { symbol: 'AAPL', name: '애플', marketCountry: 'US', currency: 'USD', quantity: '6', lastPrice: '200.00', averagePurchasePrice: '166.67', marketValue: { purchaseAmount: '1000.00', amount: '1200.00', amountAfterCost: '1195.00' }, profitLoss: { amount: '200.00', amountAfterCost: '195.00', rate: '0.2', rateAfterCost: '0.195' }, dailyProfitLoss: { amount: '-10.00', rate: '-0.0083' }, cost: { commission: '1.00', tax: null } }
    ]
  };
  const orders = [
    [{ orderId: 'o1', symbol: '005930', side: 'BUY', orderType: 'LIMIT', currency: 'KRW', status: 'FILLED', quantity: '10', orderedAt: '2026-10-20T09:01:00+09:00', execution: { filledQuantity: '10', averageFilledPrice: '79000', filledAmount: '790000', commission: '120', tax: null, filledAt: '2026-10-20T09:01:05+09:00' } },
     { orderId: 'o2', symbol: '000660', side: 'SELL', orderType: 'LIMIT', currency: 'KRW', status: 'CANCELED', quantity: '5', orderedAt: '2026-10-21T10:00:00+09:00', execution: { filledQuantity: '0', averageFilledPrice: null, filledAmount: null, commission: null, tax: null, filledAt: null } }],
    [{ orderId: 'o3', symbol: 'AAPL', side: 'BUY', orderType: 'MARKET', currency: 'USD', status: 'FILLED', quantity: '1', orderedAt: '2026-10-22T23:30:00+09:00', execution: { filledQuantity: '1', averageFilledPrice: '199.5', filledAmount: '199.5', commission: '0.1', tax: null, filledAt: '2026-10-22T23:30:02+09:00' } }]
  ];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let body = '';
    req.on('data', d => body += d); req.on('end', () => {
      const send = (code, obj, hdr = {}) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, hdr)); res.end(JSON.stringify(obj)); };
      st.calls.push(req.method + ' ' + u.pathname);
      if (u.pathname === '/oauth2/token') {
        st.token++; const f = new URLSearchParams(body);
        if (st.mode === 'ip') return send(403, { error: 'access_denied', error_description: 'IP address not allowed' });
        if (f.get('grant_type') !== 'client_credentials' || f.get('client_id') !== ID || f.get('client_secret') !== SECRET) return send(401, { error: 'invalid_client', error_description: 'bad client ' + f.get('client_secret') });
        st.tokN++; return send(200, { access_token: 'tok-' + st.tokN + '-zzzzzzzzzz', token_type: 'Bearer', expires_in: 600 });
      }
      const auth = req.headers.authorization || '';
      if (!/^Bearer tok-/.test(auth)) return send(401, { error: { code: 'invalid-token', message: 'no token' } });
      if (st.once401 && u.pathname === '/api/v1/holdings') { st.once401 = false; return send(401, { error: { code: 'expired-token', message: 'expired' } }); }
      if (st.once429 && u.pathname === '/api/v1/holdings') { st.once429 = false; return send(429, { error: { code: 'rate-limit-exceeded', message: 'slow down' } }, { 'Retry-After': '1' }); }
      if (req.method !== 'GET') return send(405, { error: { code: 'method', message: 'GET only in mock' } });
      const acc = req.headers['x-tossinvest-account'];
      const needAcc = ['/api/v1/holdings', '/api/v1/buying-power', '/api/v1/orders'].includes(u.pathname);
      if (needAcc && acc !== '1') return send(400, { error: { code: 'account-header-required', message: 'need account' } });
      switch (u.pathname) {
        case '/api/v1/accounts': return send(200, { result: [{ accountNo: '12345678901', accountSeq: 1, accountType: 'BROKERAGE' }, { accountNo: '99999999999', accountSeq: 2, accountType: 'PENSION_SAVINGS' }] });
        case '/api/v1/holdings': return send(200, { result: opts.noUsd ? { totalPurchaseAmount: { krw: '10000000', usd: null }, marketValue: { amount: { krw: '12000000', usd: null }, amountAfterCost: { krw: '11950000', usd: null } }, profitLoss: { amount: { krw: '2000000', usd: null }, amountAfterCost: { krw: '1950000', usd: null }, rate: '0.2', rateAfterCost: '0.19' }, dailyProfitLoss: { amount: { krw: '120000', usd: null }, rate: '0.01' }, items: H.items.slice(0, 2) } : H });
        case '/api/v1/buying-power': return send(200, { result: { currency: u.searchParams.get('currency'), cashBuyingPower: u.searchParams.get('currency') === 'USD' ? '50.00' : '1500000' } });
        case '/api/v1/orders': { const page = u.searchParams.get('cursor') === 'p2' ? 1 : 0; return send(200, { result: { orders: orders[page], nextCursor: page === 0 ? 'p2' : null, hasNext: page === 0 } }); }
        case '/api/v1/exchange-rate': return send(200, { result: { baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1395.5', midRate: '1390.0', basisPoint: '39.6', rateChangeType: 'UP', validFrom: '2026-10-23T09:00:00+09:00', validUntil: '2026-10-23T09:10:00+09:00' } });
        default: return send(404, { error: { code: 'not-found', message: u.pathname } });
      }
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, st, base: 'http://127.0.0.1:' + srv.address().port })));
}

(async () => {
  console.log('[1] 보유 현황 → 스냅샷(원화 환산·비중·체결 내역)');
  let m = await mockToss();
  const slept = [];
  let c = new T.TossClient({ clientId: ID, clientSecret: SECRET, baseUrl: m.base, sleep: async ms => { slept.push(ms); } });
  const now = Date.parse('2026-10-23T07:00:00Z');
  const s = await T.collect(c, { now, sleep: async () => {} });
  const MID = 1390;
  check('원화 환산 총 평가금액 = 국내 + 해외×매매기준율', s.totals.value.krwTotal === 12000000 + Math.round(1200 * MID), s.totals.value);
  check('투자원금·손익·오늘 손익도 같은 방식으로 환산', s.totals.purchase.krwTotal === 10000000 + 1000 * MID && s.totals.pl.krwTotal === 2000000 + 200 * MID && s.totals.daily.krwTotal === 120000 - 10 * MID);
  check('손익률 = 손익 ÷ 투자원금(원화 기준)', Math.abs(s.totals.plRate - (2000000 + 200 * MID) / (10000000 + 1000 * MID)) < 1e-12, s.totals.plRate);
  check('종목 3개, 평가금액 큰 순서, 비중 합계 100%', s.items.length === 3 && s.items[0].symbol === '005930' && Math.abs(s.items.reduce((a, b) => a + b.weight, 0) - 1) < 1e-9, s.items.map(i => i.symbol));
  const aapl = s.items.find(i => i.symbol === 'AAPL');
  check('해외 종목은 원래 통화(USD)와 원화 환산값을 둘 다 보관', aapl.currency === 'USD' && aapl.value === 1200 && aapl.valueKRW === Math.round(1200 * MID), aapl);
  check('수량·현재가·평균가·세금이 숫자로(세금 없음은 null)', s.items[0].qty === 100 && s.items[0].last === 80000 && s.items[0].avg === 70000 && s.items[1].tax === null);
  check('예수금: 원화 + 달러×환율', s.cash.krwTotal === 1500000 + Math.round(50 * MID), s.cash);
  check('환율은 매매기준율(midRate) 사용', s.fx.usdkrw === 1390 && s.fx.rate === 1395.5);
  check('체결 내역: 체결된 것만(취소 제외), 최근 순, 두 쪽 다 받음', s.orders.length === 2 && s.orders[0].id === 'o3' && s.orders[1].id === 'o1' && s.orders[1].name === '삼성전자', s.orders.map(o => o.id));
  check('계좌번호는 끝 4자리만', s.accounts.length === 1 && s.accounts[0].no === '****8901', s.accounts);
  check('종합매매(BROKERAGE) 계좌만 대상(연금 계좌 제외)', !m.st.calls.some(x => /holdings/.test(x)) || s.accounts.every(a => a.type === 'BROKERAGE'));
  check('날짜는 한국 시간 기준', s.date === '2026-10-23' && /\+09:00$/.test(s.at), [s.date, s.at]);
  check('토큰은 한 번 받아 계속 재사용', m.st.token === 1, m.st.token);
  m.srv.close();

  console.log('[2] 토큰 만료·호출 한도·해외 종목 없음');
  m = await mockToss({ once401: true, once429: true }); slept.length = 0;
  c = new T.TossClient({ clientId: ID, clientSecret: SECRET, baseUrl: m.base, sleep: async ms => { slept.push(ms); } });
  const s2 = await T.collect(c, { now, sleep: async () => {} });
  check('401(만료)이면 토큰을 1회 다시 받아 이어서 진행', m.st.token === 2 && s2.items.length === 3, m.st.token);
  check('429면 Retry-After(1초)만큼 기다린 뒤 재시도', slept.includes(1000), slept);
  m.srv.close();
  m = await mockToss({ noUsd: true });
  c = new T.TossClient({ clientId: ID, clientSecret: SECRET, baseUrl: m.base, sleep: async () => {} });
  const s3 = await T.collect(c, { now, sleep: async () => {} });
  check('해외 종목이 없으면 환율을 부르지 않고 usd는 null', s3.fx === null && s3.totals.value.usd === null && s3.totals.value.krwTotal === 12000000 && !m.st.calls.some(x => /exchange-rate/.test(x)), s3.totals.value);
  m.srv.close();

  console.log('[3] 오류: 허용 IP · 잘못된 키');
  m = await mockToss({ mode: 'ip' });
  c = new T.TossClient({ clientId: ID, clientSecret: SECRET, baseUrl: m.base, sleep: async () => {} });
  let err = null; try { await T.collect(c, { now }); } catch (e) { err = e; }
  check('허용 IP가 아니면 TossIpError(재등록 안내)', err instanceof T.TossIpError && /허용 IP/.test(err.message), err && err.message);
  m.srv.close();
  m = await mockToss();
  c = new T.TossClient({ clientId: ID, clientSecret: 'wrong-secret-zzzzzz', baseUrl: m.base, sleep: async () => {} });
  err = null; try { await c.accounts(); } catch (e) { err = e; }
  check('키가 틀리면 TossAuthError, 메시지에 비밀값이 안 나옴', err instanceof T.TossAuthError && !err.message.includes('wrong-secret-zzzzzz') && !err.message.includes(SECRET), err && err.message);
  m.srv.close();

  console.log('[4] 조회 전용 · 비밀값 가림');
  c = new T.TossClient({ clientId: ID, clientSecret: SECRET, baseUrl: 'http://127.0.0.1:1', fetchImpl: () => { throw new Error('호출되면 안 됨'); } });
  for (const p of ['/api/v1/conditional-orders', '/api/v1/orders/abc/cancel', '/api/v1/orders/abc/modify', '/api/v1/sellable-quantity']) {
    err = null; try { await c.get(p); } catch (e) { err = e; }
    check('막힌 경로 ' + p + ' 는 요청 자체를 만들지 않음', err instanceof T.ReadOnlyError, err && err.message);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'toss.js'), 'utf8');
  check('코드 안의 POST는 토큰 발급과 가계부 업로드 2곳뿐(주문 코드 없음)', (src.match(/method:\s*'POST'/g) || []).length === 2 && !/side:\s*'BUY'|\/orders['"]\s*,\s*\{\s*method:\s*'POST'/.test(src));
  check('get()은 GET만 보냄', /method: 'GET'/.test(src) && !/method: (?:'PUT'|'DELETE'|'PATCH')/.test(src));
  const logs = []; const ol = console.log, oe = console.error; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  T.registerSecret(SKEY);
  T.log('키', SECRET, 'Bearer tok-1-zzzzzzzzzz', SKEY, ID); T.warn('client_secret=' + SECRET + '&x=1');
  console.log = ol; console.error = oe;
  const joined = logs.join('\n');
  check('로그에서 client_secret·client_id·토큰·가계부 키가 전부 ***', !joined.includes(SECRET) && !joined.includes(ID) && !joined.includes('tok-1-zzzzzzzzzz') && !joined.includes(SKEY) && (joined.match(/\*\*\*/g) || []).length >= 5, joined);

  console.log('[5] 가계부 서버 업로드 · .env 읽기');
  let got = null;
  const up = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { got = JSON.parse(b); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, saved: true, historyCount: 3 })); }); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const r = await T.uploadSnapshot({ url: 'http://127.0.0.1:' + up.address().port + '/exec', key: SKEY, snapshot: s });
  check('업로드: action=saveStockSnapshot, 키는 본문에, 스냅샷 그대로', got.action === 'saveStockSnapshot' && got.k === SKEY && got.snapshot.totals.value.krwTotal === s.totals.value.krwTotal && r.historyCount === 3);
  check('업로드 본문에 토스 키가 들어가지 않음', !JSON.stringify(got).includes(SECRET) && !JSON.stringify(got).includes(ID));
  up.close();
  err = null; try { await T.uploadSnapshot({ url: '', key: '', snapshot: s }); } catch (e) { err = e; }
  check('가계부 서버 설정이 없으면 친절한 오류', err && /GAEGYEBU_SERVER_URL/.test(err.message));
  const envf = path.join(os.tmpdir(), 'toss_test.env');
  fs.writeFileSync(envf, '# 주석\r\nTOSS_CLIENT_ID="abc def"\r\nTOSS_CLIENT_SECRET=\'s3cr3t=xyz\'\r\n\r\nGAEGYEBU_SERVER_URL=https://script.google.com/x/exec\r\n');
  const e = T.loadEnv(envf);
  check('.env: 따옴표·= 포함 값·주석·윈도우 줄바꿈 처리', e.TOSS_CLIENT_ID === 'abc def' && e.TOSS_CLIENT_SECRET === 's3cr3t=xyz' && e.GAEGYEBU_SERVER_URL === 'https://script.google.com/x/exec', e);
  fs.unlinkSync(envf);
  console.log('[대기 프로그램] 폰 🔄 요청 → 동기화');
  const { createAgent } = require('../agent');
  const mA = await mockToss(), cA = new T.TossClient({ clientId: ID, clientSecret: SECRET, baseUrl: mA.base, sleep: async () => {} });
  // 가짜 가계부 서버: pollTossSync(요청 상태) · saveStockSnapshot(저장하면 요청 처리됨)
  const gs = { req: null, saved: null, polls: [], saves: 0, err: undefined };
  const gfetch = async (u, o) => { const b = o && o.body ? JSON.parse(o.body) : {}; let out;
    if (u.includes('ipify')) out = { ip: '1.2.3.4' };
    else if (b.action === 'pollTossSync') { gs.polls.push(b); if ('error' in b) gs.err = b.error; out = { ok: true, pending: !!gs.req && (!gs.saved || gs.req > gs.saved), requestedAt: gs.req }; }
    else if (b.action === 'saveStockSnapshot') { gs.saves++; gs.saved = new Date(Date.now() + gs.saves).toISOString(); gs.last = b.snapshot; out = { ok: true, saved: true, historyCount: 1 }; }
    return { status: 200, json: async () => out }; };
  const envA = { GAEGYEBU_SERVER_URL: 'https://example.invalid/exec', GAEGYEBU_SERVER_KEY: SKEY };
  let clock = 1e12; const alogs = [];
  const ag = createAgent({ env: envA, client: cA, fetchImpl: gfetch, now: () => clock, log: m => alogs.push(m) });
  check('요청 없으면 아무것도 안 함', await ag.tick() === 'idle' && gs.saves === 0 && mA.st.calls.length === 0);
  gs.req = new Date(Date.now()).toISOString();
  check('요청 있으면 토스 조회 → 가계부 서버 저장', await ag.tick() === 'synced' && gs.saves === 1 && gs.last.totals.value.krwTotal > 0);
  check('토스 쪽은 조회(GET)·토큰만 호출', mA.st.calls.every(c => /^GET |^POST \/oauth2\/token$/.test(c)), mA.st.calls);
  check('다음 확인 때 성공()을 서버에 알림 · 요청은 처리됨', await ag.tick() === 'idle' && gs.err === '');
  check('확인 요청 본문에 토스 키 없음', !JSON.stringify(gs.polls).includes(SECRET) && !JSON.stringify(gs.polls).includes(ID));
  gs.req = new Date(Date.now() + 100).toISOString();
  check('1분 안의 새 요청은 기다림', await ag.tick() === 'wait' && gs.saves === 1);
  clock += 61000;
  check('1분 지나면 처리', await ag.tick() === 'synced' && gs.saves === 2);
  mA.srv.close();
  const mI = await mockToss({ mode: 'ip' }), cI = new T.TossClient({ clientId: ID, clientSecret: SECRET, baseUrl: mI.base, sleep: async () => {} });
  const gi = createAgent({ env: envA, client: cI, fetchImpl: gfetch, now: () => clock, log: m => alogs.push(m) });
  gs.req = new Date(Date.now() + 200).toISOString(); gs.saved = null;
  check('허용 IP가 아니면 실패로 끝내고', await gi.tick() === 'error' && gs.saves === 2);
  check('다음 확인 때 이유(지금 IP)를 서버에 알림 · 같은 요청은 다시 안 함', await gi.tick() === 'idle' && /허용 IP/.test(gs.err) && /1\.2\.3\.4/.test(gs.err), gs.err);
  check('기록에 토스 키 없음', !alogs.join(' ').includes(SECRET));
  mI.srv.close();
  console.log(`결과: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 중단:', e); process.exit(1); });
