// 토스증권 Open API → 가계부 동기화 라이브러리 (조회 전용 · 외부 패키지 없음 · Node 18+)
// 근거: 토스증권 공식 OpenAPI 명세 v1.2.14 (openapi.tossinvest.com)
//  · 토큰: POST /oauth2/token (client_credentials, form-urlencoded) → { access_token, token_type, expires_in }
//  · 성공 응답은 { result: ... }, 오류는 { error: { requestId, code, message, data } }
//  · 계좌·자산·주문 API는 X-Tossinvest-Account: {accountSeq} 헤더 필요
//  · 허용 IP에 없는 곳에서 부르면 403 (토큰 발급은 OAuth2 형식 { error:'access_denied', error_description:'IP address not allowed' })
//  · 호출 한도(초당): ACCOUNT 1 · ASSET 5 · ORDER_HISTORY 5 · ORDER_INFO 6 · MARKET_INFO 3 — 429면 Retry-After 만큼 대기
'use strict';
const fs = require('fs'), path = require('path');

// ── 1. 설정(.env) ───────────────────────────────────────────────
// 비밀값은 저장소 밖 ../../../gaegyebu-data/.env (저장소 폴더 옆). 다른 곳이면 TOSS_ENV_FILE 로 지정.
const DEFAULT_ENV = path.resolve(__dirname, '..', '..', '..', 'gaegyebu-data', '.env');
function loadEnv(file = process.env.TOSS_ENV_FILE || DEFAULT_ENV) {
  const env = {};
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim(); if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('='); if (i < 1) continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[line.slice(0, i).trim()] = v;
    }
  }
  for (const k of ['TOSS_CLIENT_ID', 'TOSS_CLIENT_SECRET', 'TOSS_ACCOUNT_SEQ', 'GAEGYEBU_SERVER_URL', 'GAEGYEBU_SERVER_KEY']) if (process.env[k]) env[k] = process.env[k];
  env.__file = file; return env;
}

// ── 2. 비밀값 가리기: 화면·로그·오류 메시지에 절대 나오지 않게 ──────────
const SECRETS = new Set();
function registerSecret(s) { if (s && String(s).length >= 6) SECRETS.add(String(s)); }
function mask(text) {
  let t = String(text);
  for (const s of SECRETS) t = t.split(s).join('***');
  return t.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, '$1***').replace(/(client_secret=)[^&\s]+/g, '$1***');
}
const log = (...a) => console.log(mask(a.join(' ')));
const warn = (...a) => console.error(mask(a.join(' ')));
const maskAccountNo = no => { const s = String(no || ''); return s.length > 4 ? '****' + s.slice(-4) : s; };

// ── 3. 오류 종류 ────────────────────────────────────────────────
class TossError extends Error { constructor(msg, extra = {}) { super(mask(msg)); Object.assign(this, extra); } }
class TossIpError extends TossError {}       // 허용 IP 아님(403)
class TossAuthError extends TossError {}     // 키가 틀림 등 토큰 발급 실패
class TossApiError extends TossError {}      // API 오류 봉투
class ReadOnlyError extends TossError {}     // 조회 전용 위반(주문 등)

// ── 4. 조회 전용 클라이언트 ─────────────────────────────────────────
// 허용 목록 밖(주문 생성·정정·취소·조건주문 등)은 요청 자체를 만들지 않는다.
const READ_ONLY = new Set(['/api/v1/accounts', '/api/v1/holdings', '/api/v1/buying-power', '/api/v1/orders', '/api/v1/exchange-rate', '/api/v1/market-calendar/KR', '/api/v1/prices']);
class TossClient {
  constructor({ clientId, clientSecret, baseUrl = 'https://openapi.tossinvest.com', fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(), maxRetry = 3 } = {}) {
    if (!clientId || !clientSecret) throw new TossAuthError('TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았어요(.env 확인).');
    registerSecret(clientId); registerSecret(clientSecret);
    Object.assign(this, { clientId, clientSecret, baseUrl: baseUrl.replace(/\/$/, ''), fetchImpl, sleep, now, maxRetry });
    this._tok = null; this._exp = 0; this.calls = [];
  }
  async token(force = false) {
    if (!force && this._tok && this.now() < this._exp - 60000) return this._tok; // 만료 60초 전까지 재사용
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret }).toString();
    const res = await this.fetchImpl(this.baseUrl + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    const j = await res.json().catch(() => ({}));
    if (res.status === 403 && /ip/i.test(String(j.error_description || j.error || ''))) throw new TossIpError('허용 IP가 아닌 곳에서 호출했어요(403). 토스증권 웹 → 설정 → Open API → 허용 IP 관리에 지금 공인 IP를 등록하세요.', { status: 403 });
    if (!res.ok || !j.access_token) throw new TossAuthError('토큰 발급 실패(' + res.status + ' ' + (j.error || '') + ' ' + (j.error_description || '') + '). 키를 확인하세요.', { status: res.status });
    registerSecret(j.access_token);
    this._tok = j.access_token; this._exp = this.now() + (Number(j.expires_in) || 600) * 1000;
    return this._tok;
  }
  async get(p, { query = {}, account = null } = {}) {
    if (!READ_ONLY.has(p)) throw new ReadOnlyError('조회 전용 도구라 이 호출은 막혀 있어요: GET ' + p);
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    const url = this.baseUrl + p + (qs ? '?' + qs : '');
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: 'Bearer ' + await this.token(), Accept: 'application/json' };
      if (account != null) headers['X-Tossinvest-Account'] = String(account);
      this.calls.push(p);
      const res = await this.fetchImpl(url, { method: 'GET', headers });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j && 'result' in j) return j.result;
      const err = (j && j.error) || {};
      if (res.status === 401 && !refreshed) { refreshed = true; await this.token(true); continue; } // 토큰 만료 등 → 1회 재발급
      if (res.status === 403 && /ip/i.test(String(err.message || err.code || ''))) throw new TossIpError('허용 IP가 아닌 곳에서 호출했어요(403).', { status: 403 });
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetry) {
        const ra = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
        await this.sleep(res.status === 429 ? ((isFinite(ra) && ra > 0 ? ra : 1) * 1000) : 500 * (attempt + 1)); continue;
      }
      throw new TossApiError('토스 API 오류 ' + res.status + ' ' + (err.code || '') + ' ' + (err.message || ''), { status: res.status, code: err.code, requestId: err.requestId });
    }
  }
  accounts() { return this.get('/api/v1/accounts'); }
  holdings(seq) { return this.get('/api/v1/holdings', { account: seq }); }
  buyingPower(seq, currency) { return this.get('/api/v1/buying-power', { account: seq, query: { currency } }); }
  exchangeRate(base = 'USD', quote = 'KRW') { return this.get('/api/v1/exchange-rate', { query: { baseCurrency: base, quoteCurrency: quote } }); }
  async closedOrders(seq, from, to, maxPages = 10) { // 체결·취소 완료 주문(최근 기간), 커서로 이어 받기
    const out = []; let cursor = null;
    for (let i = 0; i < maxPages; i++) {
      const r = await this.get('/api/v1/orders', { account: seq, query: { status: 'CLOSED', from, to, cursor, limit: 100 } });
      out.push(...((r && r.orders) || []));
      if (!r || !r.hasNext || !r.nextCursor) break; cursor = r.nextCursor;
    }
    return out;
  }
}

// ── 5. 스냅샷(가계부에 저장할 모양) ─────────────────────────────────────
const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
const n0 = v => num(v) || 0;
const kstDate = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const kstIso = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().replace('Z', '+09:00');
// 계좌들의 보유 현황·현금·주문을 합쳐 하나의 스냅샷으로. 원화 환산은 매매기준율(midRate) 기준.
function buildSnapshot({ accounts = [], perAccount = [], fx = null, now = Date.now() }) {
  const usd = fx ? (num(fx.midRate) || num(fx.rate)) : null;
  const toKRW = (krw, us) => n0(krw) + (us != null && usd ? n0(us) * usd : 0);
  const items = [], tot = { purchase: [0, 0], value: [0, 0], valueAfterCost: [0, 0], pl: [0, 0], plAfterCost: [0, 0], daily: [0, 0] };
  const cash = { krw: 0, usd: 0 }; let hasUsd = false;
  for (const a of perAccount) {
    const h = a.holdings || {};
    const add = (key, o) => { if (!o) return; tot[key][0] += n0(o.krw); if (o.usd != null) { tot[key][1] += n0(o.usd); hasUsd = true; } };
    add('purchase', h.totalPurchaseAmount); add('value', h.marketValue && h.marketValue.amount); add('valueAfterCost', h.marketValue && h.marketValue.amountAfterCost);
    add('pl', h.profitLoss && h.profitLoss.amount); add('plAfterCost', h.profitLoss && h.profitLoss.amountAfterCost); add('daily', h.dailyProfitLoss && h.dailyProfitLoss.amount);
    if (a.cashKRW != null) cash.krw += n0(a.cashKRW);
    if (a.cashUSD != null) { cash.usd += n0(a.cashUSD); if (n0(a.cashUSD)) hasUsd = true; }
    for (const it of (h.items || [])) {
      const cur = it.currency || (it.marketCountry === 'US' ? 'USD' : 'KRW'), mv = it.marketValue || {}, pl = it.profitLoss || {}, dl = it.dailyProfitLoss || {}, cost = it.cost || {};
      const rate = cur === 'USD' ? (usd || 0) : 1;
      items.push({ account: a.seq, symbol: String(it.symbol || ''), name: String(it.name || it.symbol || ''), country: it.marketCountry || (cur === 'USD' ? 'US' : 'KR'), currency: cur,
        qty: num(it.quantity), last: num(it.lastPrice), avg: num(it.averagePurchasePrice),
        purchase: num(mv.purchaseAmount), value: num(mv.amount), valueAfterCost: num(mv.amountAfterCost),
        pl: num(pl.amount), plRate: num(pl.rate), plAfterCost: num(pl.amountAfterCost), plRateAfterCost: num(pl.rateAfterCost),
        daily: num(dl.amount), dailyRate: num(dl.rate), commission: num(cost.commission), tax: num(cost.tax),
        valueKRW: Math.round(n0(mv.amount) * rate), purchaseKRW: Math.round(n0(mv.purchaseAmount) * rate), plKRW: Math.round(n0(pl.amount) * rate), dailyKRW: Math.round(n0(dl.amount) * rate) });
    }
  }
  const T = k => ({ krw: tot[k][0], usd: hasUsd ? tot[k][1] : null, krwTotal: Math.round(toKRW(tot[k][0], hasUsd ? tot[k][1] : null)) });
  const totals = { purchase: T('purchase'), value: T('value'), valueAfterCost: T('valueAfterCost'), pl: T('pl'), plAfterCost: T('plAfterCost'), daily: T('daily') };
  totals.plRate = totals.purchase.krwTotal ? totals.pl.krwTotal / totals.purchase.krwTotal : null;
  totals.dailyRate = (totals.value.krwTotal - totals.daily.krwTotal) ? totals.daily.krwTotal / (totals.value.krwTotal - totals.daily.krwTotal) : null;
  const valueKRW = totals.value.krwTotal || 0;
  items.forEach(it => { it.weight = valueKRW ? it.valueKRW / valueKRW : 0; });
  items.sort((x, y) => y.valueKRW - x.valueKRW);
  const cashKRW = Math.round(cash.krw + (hasUsd && usd ? cash.usd * usd : 0));
  const orders = [];
  for (const a of perAccount) for (const o of (a.orders || [])) {
    const ex = o.execution || {}; if (!(n0(ex.filledQuantity) > 0)) continue;
    const nameOf = (items.find(i => i.symbol === o.symbol) || {}).name || o.symbol;
    orders.push({ account: a.seq, id: String(o.orderId || ''), symbol: o.symbol, name: nameOf, side: o.side, currency: o.currency, qty: num(ex.filledQuantity), price: num(ex.averageFilledPrice), amount: num(ex.filledAmount), commission: num(ex.commission), tax: num(ex.tax), filledAt: ex.filledAt || o.orderedAt || null });
  }
  orders.sort((x, y) => String(y.filledAt).localeCompare(String(x.filledAt)));
  return { v: 1, source: 'tossinvest-openapi', at: kstIso(now), date: kstDate(now),
    accounts: accounts.map(a => ({ seq: a.accountSeq, type: a.accountType, no: maskAccountNo(a.accountNo) })),
    fx: usd ? { usdkrw: usd, rate: num(fx.rate), validFrom: fx.validFrom || null } : null,
    cash: { krw: cash.krw, usd: hasUsd ? cash.usd : null, krwTotal: cashKRW },
    totals, items, orders: orders.slice(0, 200) };
}

// ── 6. 한 번에: 토스에서 받아 스냅샷 만들기 ─────────────────────────────
async function collect(client, { accountSeq = null, orderDays = 31, now = Date.now(), sleep } = {}) {
  const pause = sleep || client.sleep;
  const accs = (await client.accounts()) || [];
  const targets = accs.filter(a => a.accountType === 'BROKERAGE' && (!accountSeq || String(a.accountSeq) === String(accountSeq)));
  if (!targets.length) throw new TossError('종합매매(BROKERAGE) 계좌를 찾지 못했어요.' + (accountSeq ? ' TOSS_ACCOUNT_SEQ=' + accountSeq + ' 확인' : ''));
  const perAccount = [];
  for (const a of targets) {
    const holdings = await client.holdings(a.accountSeq);
    let cashKRW = null, cashUSD = null, orders = [];
    try { cashKRW = (await client.buyingPower(a.accountSeq, 'KRW') || {}).cashBuyingPower; } catch (e) { warn('  (예수금 KRW 조회 실패: ' + e.message + ')'); }
    if ((holdings.items || []).some(i => i.currency === 'USD')) { try { cashUSD = (await client.buyingPower(a.accountSeq, 'USD') || {}).cashBuyingPower; } catch (e) { warn('  (예수금 USD 조회 실패: ' + e.message + ')'); } }
    try { orders = await client.closedOrders(a.accountSeq, kstDate(now - orderDays * 86400e3), kstDate(now)); } catch (e) { warn('  (체결 내역 조회 실패: ' + e.message + ')'); }
    perAccount.push({ seq: a.accountSeq, holdings, cashKRW, cashUSD, orders });
    await pause(250);
  }
  let fx = null;
  if (perAccount.some(p => (p.holdings.items || []).some(i => i.currency === 'USD')) || perAccount.some(p => n0(p.cashUSD))) {
    try { fx = await client.exchangeRate('USD', 'KRW'); } catch (e) { warn('  (환율 조회 실패: ' + e.message + ' — 해외 종목은 원화 환산 없이 저장)'); }
  }
  return buildSnapshot({ accounts: targets, perAccount, fx, now });
}

// ── 7. 가계부 서버(Apps Script)에 저장 ─────────────────────────────────
async function uploadSnapshot({ url, key, snapshot, fetchImpl = globalThis.fetch }) {
  if (!url || !key) throw new TossError('GAEGYEBU_SERVER_URL / GAEGYEBU_SERVER_KEY 가 설정되지 않았어요(.env 확인).');
  registerSecret(key);
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ k: key, action: 'saveStockSnapshot', snapshot }), redirect: 'follow' });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new TossError('가계부 서버 저장 실패: ' + (j.error || res.status));
  return j;
}

// 허용 IP 오류일 때 지금 공인 IP를 알려 준다(다시 등록할 수 있게)
async function publicIp(fetchImpl = globalThis.fetch) {
  try { const r = await fetchImpl('https://api.ipify.org?format=json'); const j = await r.json(); return j.ip || null; } catch (e) { return null; }
}

const won = v => (v == null ? '-' : Math.round(v).toLocaleString('ko-KR') + '원');
const pct = v => (v == null ? '-' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%');
module.exports = { loadEnv, mask, log, warn, registerSecret, maskAccountNo, TossClient, TossError, TossIpError, TossAuthError, TossApiError, ReadOnlyError, READ_ONLY, buildSnapshot, collect, uploadSnapshot, publicIp, kstDate, won, pct };
