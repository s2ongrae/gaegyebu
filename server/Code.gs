// ══════════════════════════════════════════════════════════════
// 가계부 서버 (Google Apps Script)
//  - 모든 요청에 비밀 키(SECRET_KEY)가 필요합니다. 키가 없거나 틀리면 아무 데이터도 주지 않아요.
//  - 저장은 "개정번호(rev)"를 확인해서, 다른 기기가 먼저 저장했으면 덮어쓰지 않고 충돌로 돌려보내요.
//  - 저장하기 전에 하루에 한 번 이전 파일을 백업 폴더에 남겨요(14일 보관).
//  - 토스증권 보유 현황은 노트북 tools/toss-sync 가 스냅샷으로 저장하고, 앱은 읽기만 해요(토스 키는 여기 없음). 앱 🔄 → 노트북 대기 프로그램이 받아 올려요.
//  - 매일 아침 보유 종목 최신 뉴스와 공모주 관련 기사 링크를 구글 뉴스 RSS 로 모아 둬요(setupNewsTrigger 로 예약). 앱 🔄 로 30분에 한 번 다시 모을 수 있어요.
// ══════════════════════════════════════════════════════════════

const FOLDER_NAME = '가계부';
const FILE_NAME = '가계부_데이터.json';
const BACKUP_PREFIX = '가계부_데이터_백업_';
const BACKUP_KEEP_DAYS = 14;
const SHRINK_MIN_TXS = 50;    // 서버 거래가 이 개수 이상일 때만
const SHRINK_RATIO = 0.5;     // 들어온 거래 수가 서버의 절반보다 적으면 "실수일 수 있다"며 멈춤
const MAX_DATA_CHARS = 8 * 1024 * 1024;

// ── 진입점 ─────────────────────────────────────────────────────
// GET은 데이터를 주지 않습니다(주소만 알아서는 아무것도 볼 수 없게).
function doGet(e) {
  return jsonOut({ ok: false, error: 'POST로만 사용할 수 있어요.' });
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || '';
    let body;
    try { body = JSON.parse(raw); } catch (_) { return jsonOut({ ok: false, error: 'bad_request' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonOut({ ok: false, error: 'bad_request' });

    const authError = checkKey_(body.k);
    if (authError) {
      Utilities.sleep(300); // 키를 마구 대입해 보는 시도를 느리게
      return jsonOut({ ok: false, error: authError });
    }

    switch (body.action) {
      case 'ping': return jsonOut({ ok: true });
      case 'meta': return handleMeta_();
      case 'load': return handleLoad_();
      case 'save': return handleSave_(body);
      case 'saveStockSnapshot': return handleSaveStockSnapshot_(body);
      case 'requestTossSync': return handleRequestTossSync_();
      case 'pollTossSync': return handlePollTossSync_(body);
      case 'loadStockSnapshot': return handleLoadStockSnapshot_();
      case 'loadStockNews': return handleLoadStockNews_();
      case 'requestNewsRefresh': return handleRequestNewsRefresh_();
      case 'getCalendarEvents': return handleGetCalendarEvents(body);
      case 'aiSearchParse': return handleAiSearchParse(body);
      default: return jsonOut({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message || err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── 인증 ───────────────────────────────────────────────────────
// 반환: '' (통과) | 'no_key_configured' | 'unauthorized'
function checkKey_(k) {
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET_KEY');
  if (!secret || secret.length < 16) return 'no_key_configured'; // 키를 아직 안 만들었으면 전부 거절(안전한 쪽으로)
  if (typeof k !== 'string' || k.length !== secret.length) return 'unauthorized';
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ k.charCodeAt(i);
  return diff === 0 ? '' : 'unauthorized';
}

// 한 번만 실행하세요: 길고 무작위인 비밀 키를 만들어 스크립트 속성에 저장하고, 실행 로그에 보여줍니다.
function createSecretKey() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SECRET_KEY')) {
    Logger.log('이미 비밀 키가 있어요. 새로 바꾸려면 rotateSecretKey()를 실행하세요.');
    return;
  }
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty('SECRET_KEY', key);
  Logger.log('비밀 키(앱 ⚙️ 서버 설정에 입력): ' + key);
}

// 키가 새어나갔을 때: 새 키로 바꿉니다. 바꾼 뒤엔 모든 기기에서 새 키를 다시 입력해야 해요.
function rotateSecretKey() {
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('SECRET_KEY', key);
  Logger.log('새 비밀 키(앱 ⚙️ 서버 설정에 입력): ' + key);
}

// ── 데이터 파일 ─────────────────────────────────────────────────
function getFolder_() {
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
}

function getOrCreateFile() {
  const folder = getFolder_();
  const files = folder.getFilesByName(FILE_NAME);
  if (files.hasNext()) return files.next();
  return folder.createFile(FILE_NAME, JSON.stringify({ txs: [], assets: {}, budgets: {} }), MimeType.PLAIN_TEXT);
}

function parseData_(text) {
  try {
    const d = JSON.parse(text);
    if (d && typeof d === 'object' && !Array.isArray(d)) return d;
  } catch (_) {}
  return { txs: [], assets: {}, budgets: {} };
}

function readData_() {
  return parseData_(getOrCreateFile().getBlob().getDataAsString());
}

function handleMeta_() {
  const d = readData_();
  return jsonOut({ ok: true, rev: Number(d.__rev) || 0, txCount: (d.txs || []).length });
}

function handleLoad_() {
  const d = readData_();
  return jsonOut({ ok: true, rev: Number(d.__rev) || 0, data: d });
}

// 저장: 내가 마지막으로 본 개정번호(baseRev)가 서버와 같을 때만 덮어씁니다.
function handleSave_(body) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return jsonOut({ ok: false, error: 'busy' });
  try {
    const p = body.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p) || !Array.isArray(p.txs)
        || !p.assets || typeof p.assets !== 'object' || !p.budgets || typeof p.budgets !== 'object') {
      return jsonOut({ ok: false, error: 'bad_payload' });
    }
    const file = getOrCreateFile();
    const cur = parseData_(file.getBlob().getDataAsString());
    const curRev = Number(cur.__rev) || 0;

    // 다른 기기가 먼저 저장했거나, 이 기기가 서버 상태를 아직 모르면: 덮어쓰지 않고 서버 데이터를 돌려줌(앱이 합쳐서 다시 보냄)
    if (body.baseRev === null || body.baseRev === undefined || Number(body.baseRev) !== curRev) {
      return jsonOut({ ok: false, conflict: true, rev: curRev, data: cur });
    }
    // 거래가 서버의 절반 아래로 줄어드는 저장은 실수일 가능성이 커서 멈춤(복원·가져오기처럼 의도한 경우만 force)
    const curN = (cur.txs || []).length;
    if (!body.force && curN >= SHRINK_MIN_TXS && p.txs.length < curN * SHRINK_RATIO) {
      return jsonOut({ ok: false, error: 'shrink', serverCount: curN, incomingCount: p.txs.length });
    }

    p.__rev = curRev + 1;
    const text = JSON.stringify(p);
    if (text.length > MAX_DATA_CHARS) return jsonOut({ ok: false, error: 'too_large' });

    backupIfNeeded_(file);
    file.setContent(text);
    return jsonOut({ ok: true, success: true, rev: curRev + 1, savedAt: new Date().toLocaleString('ko-KR') });
  } finally {
    lock.releaseLock();
  }
}

// 하루에 한 번, 덮어쓰기 직전의 파일을 백업 폴더에 남기고 오래된 백업은 휴지통으로 보냅니다.
function backupIfNeeded_(file) {
  try {
    const tz = 'Asia/Seoul';
    const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    const folder = getFolder_();
    const name = BACKUP_PREFIX + today + '.json';
    if (!folder.getFilesByName(name).hasNext()) {
      folder.createFile(name, file.getBlob().getDataAsString(), MimeType.PLAIN_TEXT);
    }
    const cutoff = Utilities.formatDate(new Date(Date.now() - BACKUP_KEEP_DAYS * 86400000), tz, 'yyyy-MM-dd');
    const it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      const n = f.getName();
      if (n.indexOf(BACKUP_PREFIX) !== 0) continue;
      const d = n.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) f.setTrashed(true);
    }
  } catch (err) {
    Logger.log('백업 실패(저장은 계속): ' + err.message); // 백업이 실패해도 저장 자체를 막지는 않음
  }
}

// ── 토스증권 보유 현황 스냅샷 ───────────────────────────────────────
// 노트북의 tools/toss-sync 가 토스증권 Open API로 받은 보유 현황을 여기에 저장한다(토스 키는 서버로 오지 않음).
// 가계부 데이터 파일과 "별도 파일"에 둔다 — 같은 파일에 넣으면 앱의 동기화(3-way 병합)가 모르는 칸이라 지워질 수 있다.
const STOCK_FILE_NAME = '가계부_주식스냅샷.json';
const STOCK_HISTORY_MAX = 1500;     // 날짜별 요약 최대 보관(약 4년)
const STOCK_SNAPSHOT_MAX_CHARS = 600000;

function getStockFile_() {
  const folder = getFolder_();
  const files = folder.getFilesByName(STOCK_FILE_NAME);
  if (files.hasNext()) return files.next();
  return folder.createFile(STOCK_FILE_NAME, JSON.stringify({ latest: null, history: [] }), MimeType.PLAIN_TEXT);
}
function readStock_(file) {
  try { const d = JSON.parse(file.getBlob().getDataAsString()); if (d && typeof d === 'object') return { latest: d.latest || null, history: Array.isArray(d.history) ? d.history : [] }; } catch (_) {}
  return { latest: null, history: [] };
}
const finiteOrNull_ = v => (typeof v === 'number' && isFinite(v)) ? v : null;
// 스냅샷 모양 검사: 숫자 칸이 숫자인지, 날짜 형식, 크기. 통과 못 하면 저장하지 않는다.
function validateStockSnapshot_(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'snapshot 이 없어요';
  if (s.v !== 1) return '지원하지 않는 스냅샷 버전';
  if (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return 'date 형식(YYYY-MM-DD)';
  if (!s.totals || !s.totals.value || finiteOrNull_(s.totals.value.krwTotal) === null) return 'totals.value.krwTotal 이 숫자가 아니에요';
  if (!Array.isArray(s.items) || s.items.length > 1000) return 'items 가 배열이 아니거나 너무 많아요';
  for (const it of s.items) { if (!it || typeof it !== 'object' || typeof it.symbol !== 'string' || finiteOrNull_(it.valueKRW) === null) return '종목 항목 형식'; }
  if (s.orders && (!Array.isArray(s.orders) || s.orders.length > 500)) return 'orders 형식';
  if (JSON.stringify(s).length > STOCK_SNAPSHOT_MAX_CHARS) return '스냅샷이 너무 커요';
  return '';
}
function stockSummary_(s) {
  const t = s.totals || {}, g = k => finiteOrNull_(t[k] && t[k].krwTotal);
  return { date: s.date, at: String(s.at || ''), value: g('value'), purchase: g('purchase'), pl: g('pl'), valueAfterCost: g('valueAfterCost'), daily: g('daily'),
           cash: finiteOrNull_(s.cash && s.cash.krwTotal), n: s.items.length };
}
function handleSaveStockSnapshot_(body) {
  const bad = validateStockSnapshot_(body.snapshot);
  if (bad) return jsonOut({ ok: false, error: 'bad_snapshot', detail: bad });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return jsonOut({ ok: false, error: 'busy' });
  try {
    const file = getStockFile_(), d = readStock_(file), snap = body.snapshot;
    const sum = stockSummary_(snap);
    const hist = d.history.filter(h => h && h.date !== sum.date); // 같은 날짜는 마지막 것으로 교체
    hist.push(sum); hist.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    while (hist.length > STOCK_HISTORY_MAX) hist.shift();
    file.setContent(JSON.stringify({ latest: snap, history: hist }));
    const pr = PropertiesService.getScriptProperties();
    pr.setProperty('STOCK_SYNC_SAVED', new Date().toISOString()); pr.setProperty('STOCK_AGENT_ERR', ''); // 폰 🔄 요청은 이걸로 처리됨
    return jsonOut({ ok: true, saved: true, date: sum.date, historyCount: hist.length });
  } finally { lock.releaseLock(); }
}
// ── 폰 🔄 → 노트북 대기 프로그램(tools/toss-sync/agent.js)이 토스 현황을 받아 올림 ─────────
// 앱은 requestTossSync 로 '받아 와 줘' 표시만 남기고, 노트북이 pollTossSync 로 20초마다 확인하다가 표시가 있으면 동기화(saveStockSnapshot)한다.
// 노트북이 확인할 때마다 시각을 남겨 앱이 '노트북이 켜져 있는지' 알려 줄 수 있게 한다. 토스 키는 여전히 노트북에만 있다.
const STOCK_REQ_GAP_MS = 60 * 1000; // 처리 안 된 요청이 있으면 1분 동안은 새로 만들지 않음
function tossSyncState_() {
  const p = PropertiesService.getScriptProperties();
  return { requestedAt: p.getProperty('STOCK_SYNC_REQ') || null, savedAt: p.getProperty('STOCK_SYNC_SAVED') || null, agentSeenAt: p.getProperty('STOCK_AGENT_SEEN') || null, agentError: p.getProperty('STOCK_AGENT_ERR') || null };
}
function tossSyncPending_(st) { return !!st.requestedAt && (!st.savedAt || st.requestedAt > st.savedAt); }
function handleRequestTossSync_() {
  const st = tossSyncState_();
  if (tossSyncPending_(st) && Date.now() - Date.parse(st.requestedAt) < STOCK_REQ_GAP_MS) return jsonOut(Object.assign({ ok: true, requested: false, skipped: 'pending' }, st));
  st.requestedAt = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty('STOCK_SYNC_REQ', st.requestedAt);
  return jsonOut(Object.assign({ ok: true, requested: true }, st));
}
// 노트북: 확인할 때마다 시각을 남기고, 지난번 동기화 결과(error: 문구 / '' 성공)가 있으면 남김
function handlePollTossSync_(body) {
  const p = PropertiesService.getScriptProperties();
  p.setProperty('STOCK_AGENT_SEEN', new Date().toISOString());
  if (typeof body.error === 'string') p.setProperty('STOCK_AGENT_ERR', body.error.slice(0, 300));
  const st = tossSyncState_();
  return jsonOut({ ok: true, pending: tossSyncPending_(st), requestedAt: st.requestedAt });
}
function handleLoadStockSnapshot_() {
  const folder = getFolder_(), files = folder.getFilesByName(STOCK_FILE_NAME);
  if (!files.hasNext()) return jsonOut({ ok: true, latest: null, history: [] });
  const d = readStock_(files.next());
  return jsonOut({ ok: true, latest: d.latest, history: d.history });
}

// ── 아침 브리핑: 보유 종목 최신 뉴스 링크 + 공모주 관련 기사 (구글 뉴스 RSS · 무료 · 키 없음) ─────────────
// 매일 아침(setupNewsTrigger 로 예약) 최신 토스 스냅샷의 평가금액 상위 종목마다 구글 뉴스 검색 RSS 를 읽어 제목·링크만 모아 둔다.
// 구글 뉴스 RSS 는 "개인용 피드 리더에서 개인적·비상업적 사용"만 허용 → 이 가계부(개인용)에서 링크 목록으로만 보여 준다.
// (Gemini 검색 요약은 무료 등급에서 막혀서(2026-10 실제 응답 429) 쓰지 않음)
const NEWS_FILE_NAME = '가계부_주식뉴스.json';
const NEWS_TOP_N = 20;
const NEWS_PER_STOCK = 5;
const NEWS_IPO_MAX = 10;
const NEWS_TIME_BUDGET_MS = 270000;              // 한 번 실행은 6분 제한 → 4분 30초가 넘으면 저장하고 1분 뒤 이어서
const NEWS_MAX_FAILS = 3;                        // 연달아 이만큼 실패하면(접속 차단 등) 그날은 멈춤
const NEWS_MANUAL_GAP_MS = 30 * 60 * 1000;       // 앱 🔄 로 다시 모으기는 마지막으로 모은 뒤 30분이 지나야(구글 뉴스에 헛호출하지 않게)
const NEWS_STUCK_MS = 10 * 60 * 1000;            // '모으는 중'이 10분 넘게 그대로면 멈춘 것으로 봄
const IPO_BROKERS = ['미래에셋증권', '삼성증권', 'NH투자증권', '한국투자증권'];
const EARN_RE = /실적|어닝|잠정|영업이익|매출액|earnings|quarter|guidance|Q[1-4]\b/i;
const OPTION_QUOTE_RE = /\([A-Z]{1,6}\d{6}[CP]\d{3,8}\)|Stock Options( Chain)?\b/i;

function getNewsFile_() {
  const folder = getFolder_(), files = folder.getFilesByName(NEWS_FILE_NAME);
  return files.hasNext() ? files.next() : folder.createFile(NEWS_FILE_NAME, JSON.stringify({}), MimeType.PLAIN_TEXT);
}
function readNews_(file) {
  try { const d = JSON.parse(file.getBlob().getDataAsString()); if (d && typeof d === 'object' && !Array.isArray(d)) return d; } catch (_) {}
  return {};
}
// 최신 스냅샷에서 평가금액 큰 순으로 NEWS_TOP_N 종목
function newsTargets_() {
  const files = getFolder_().getFilesByName(STOCK_FILE_NAME);
  if (!files.hasNext()) return null;
  const s = readStock_(files.next()).latest;
  if (!s || !Array.isArray(s.items)) return null;
  const items = s.items.filter(x => x && (finiteOrNull_(x.valueKRW) || 0) > 0)
    .sort((a, b) => b.valueKRW - a.valueKRW).slice(0, NEWS_TOP_N)
    .map(x => ({ symbol: String(x.symbol), name: String(x.name || x.symbol), country: String(x.country || (x.currency === 'USD' ? 'US' : 'KR')), weight: finiteOrNull_(x.weight) }));
  return { date: s.date, items };
}
// 국내 종목은 한국어 판에서 이름으로, 해외 종목은 영어 판에서 종목코드로(토스 이름이 한국어라 해외 기사에 안 걸림)
function stockNewsQuery_(t) {
  // 국내 이름이 흔한 낱말(예: 풍산·고영)이면 지명·인명 기사가 섞여서 주식 관련 낱말을 함께 건다
  return t.country === 'KR' ? { q: '"' + t.name + '" (주가 OR 주식 OR 실적 OR 공시 OR 종목) when:7d', lang: 'ko' } : { q: '"' + t.symbol + '" stock when:7d', lang: 'en' };
}
function ipoNewsQuery_() {
  return { q: '공모주 청약 (' + IPO_BROKERS.join(' OR ') + ') when:7d', lang: 'ko' };
}
function xmlText_(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
// 구글 뉴스 검색 RSS → [{ title, link, source, date, earn }] (최신순, 최대 max개)
function fetchNewsRss_(query, max) {
  const ed = query.lang === 'ko' ? 'hl=ko&gl=KR&ceid=KR:ko' : 'hl=en-US&gl=US&ceid=US:en';
  const res = UrlFetchApp.fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(query.q) + '&' + ed, { muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('구글 뉴스 응답 ' + code);
  const xml = res.getContentText(), out = [];
  const tag = (block, name) => { const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>')); return m ? xmlText_(m[1]) : ''; };
  (xml.match(/<item>[\s\S]*?<\/item>/g) || []).forEach(b => {
    const link = tag(b, 'link'), source = tag(b, 'source');
    let title = tag(b, 'title');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)); // 제목 끝의 " - 언론사" 는 따로 보여 줌
    const t = Date.parse(tag(b, 'pubDate'));
    if (OPTION_QUOTE_RE.test(title)) return; // 옵션 시세 페이지(예: "AMD Oct 2026 425.000 call (AMD261026C00425000)")는 기사가 아니라 뺌
    if (title && /^https:\/\//.test(link)) out.push({ title: title.slice(0, 300), link, source: source.slice(0, 60), date: isFinite(t) ? new Date(t).toISOString() : null, earn: EARN_RE.test(title) });
  });
  out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return out.slice(0, max);
}
function safeNews_(query, max) {
  try { return { news: fetchNewsRss_(query, max), query: query.q }; }
  catch (e) { return { news: [], query: query.q, error: String(e && e.message || e).slice(0, 300) }; }
}
// 예약 실행 본체. 오늘 처음이거나 이미 끝난 날 다시 부르면 새로 시작, 시간이 모자라 멈췄던 날이면 이어서.
function refreshStockNews() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'busy';
  try {
    clearNewsContinue_();
    const t0 = Date.now(), today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'), file = getNewsFile_();
    let d = readNews_(file);
    if (!d.run || d.run.day !== today || d.status !== 'running') {
      const tg = newsTargets_();
      d = { v: 2, source: 'google-news-rss', day: today, startedAt: new Date().toISOString(), updatedAt: null, snapshotDate: tg ? tg.date : null, brokers: IPO_BROKERS, status: 'running', error: null, items: [], ipo: null,
        run: { day: today, fails: 0, targets: tg ? tg.items : [], queue: (tg ? tg.items.map(x => x.symbol) : []).concat(['__ipo__']) } };
      if (!tg) d.error = '토스 보유 현황 스냅샷이 없어서 종목 뉴스는 건너뛰었어요(노트북에서 npm run sync 먼저).';
    }
    while (d.run.queue.length) {
      if (Date.now() - t0 > NEWS_TIME_BUDGET_MS) { file.setContent(JSON.stringify(d)); ScriptApp.newTrigger('continueStockNews').timeBased().after(60 * 1000).create(); return 'continue'; }
      const sym = d.run.queue[0];
      let r;
      if (sym === '__ipo__') { r = safeNews_(ipoNewsQuery_(), NEWS_IPO_MAX); d.ipo = Object.assign({ at: new Date().toISOString() }, r); }
      else {
        const t = d.run.targets.find(x => x.symbol === sym);
        r = t ? safeNews_(stockNewsQuery_(t), NEWS_PER_STOCK) : { error: '대상 없음' };
        if (t) d.items.push(Object.assign({}, t, { at: new Date().toISOString() }, r));
      }
      d.run.queue.shift();
      d.run.fails = r.error ? d.run.fails + 1 : 0;
      if (d.run.fails >= NEWS_MAX_FAILS) { d.status = 'error'; d.error = '연달아 ' + NEWS_MAX_FAILS + '번 실패해서 멈췄어요: ' + r.error; break; }
      file.setContent(JSON.stringify(d)); // 하나 끝날 때마다 저장(중간에 멈춰도 거기까지는 남음)
    }
    if (d.status === 'running') d.status = 'done';
    d.updatedAt = new Date().toISOString();
    d.run = { day: today, queue: [] };
    file.setContent(JSON.stringify(d));
    return d.status;
  } finally {
    lock.releaseLock();
  }
}
// 시간이 모자라 멈췄을 때 1분 뒤 한 번 불리는 이어하기(매일 예약과 구분하려고 함수 이름을 따로 둠)
function continueStockNews() { return refreshStockNews(); }
function clearNewsContinue_() {
  ScriptApp.getProjectTriggers().forEach(tr => { if (tr.getHandlerFunction() === 'continueStockNews') ScriptApp.deleteTrigger(tr); });
}
// 앱 🔄: 바로 모으지 않고 1초 뒤 한 번 실행을 예약하고 곧장 돌려줌(모으는 데 1분쯤 걸려서 앱 요청이 기다리지 않게)
function handleRequestNewsRefresh_() {
  const files = getFolder_().getFilesByName(NEWS_FILE_NAME), d = files.hasNext() ? readNews_(files.next()) : {};
  const last = Date.parse(d.updatedAt || d.startedAt || ''), now = Date.now();
  const queued = ScriptApp.getProjectTriggers().some(tr => { const h = tr.getHandlerFunction(); return h === 'runStockNewsNow' || h === 'continueStockNews'; });
  if (queued || (d.status === 'running' && isFinite(last) && now - last < NEWS_STUCK_MS)) return jsonOut({ ok: true, started: false, skipped: 'running' });
  if (d.status !== 'running' && isFinite(last) && now - last < NEWS_MANUAL_GAP_MS) return jsonOut({ ok: true, started: false, skipped: 'recent', updatedAt: d.updatedAt || d.startedAt, nextAt: new Date(last + NEWS_MANUAL_GAP_MS).toISOString() });
  ScriptApp.newTrigger('runStockNewsNow').timeBased().after(1000).create();
  return jsonOut({ ok: true, started: true });
}
function runStockNewsNow() {
  ScriptApp.getProjectTriggers().forEach(tr => { if (tr.getHandlerFunction() === 'runStockNewsNow') ScriptApp.deleteTrigger(tr); });
  const file = getNewsFile_(), d = readNews_(file);
  if (d.status === 'running') { d.status = 'stale'; file.setContent(JSON.stringify(d)); } // 멈춘 실행은 이어가지 않고 새로 시작
  return refreshStockNews();
}
// 한 번만 실행하세요: 매일 아침 7시 20분 무렵(±15분) 자동 실행을 예약합니다. 다시 실행하면 예약을 새로 바꿔요.
// (Apps Script 예약은 정확한 분을 보장하지 않아서, 이어하기까지 끝나도 8시 전에 준비되도록 일찍 잡음)
function setupNewsTrigger() {
  ScriptApp.getProjectTriggers().forEach(tr => { const h = tr.getHandlerFunction(); if (h === 'refreshStockNews' || h === 'continueStockNews') ScriptApp.deleteTrigger(tr); });
  ScriptApp.newTrigger('refreshStockNews').timeBased().everyDays(1).atHour(7).nearMinute(20).inTimezone('Asia/Seoul').create();
  Logger.log('매일 아침 7시 20분 무렵 뉴스·공모주 기사 모으기를 예약했어요.');
}
function handleLoadStockNews_() {
  const files = getFolder_().getFilesByName(NEWS_FILE_NAME);
  if (!files.hasNext()) return jsonOut({ ok: true, data: null });
  const d = readNews_(files.next());
  if (d.run) d.run = { day: d.run.day, left: (d.run.queue || []).length };
  return jsonOut({ ok: true, data: d });
}

// ── 구글 캘린더 (읽기 전용) ─────────────────────────────────────
function handleGetCalendarEvents(body) {
  try {
    var ym = body.ym; // 'YYYY-MM'
    if (!ym || !/^\d{4}-\d{2}$/.test(ym)) throw new Error('ym이 필요해요.');
    var parts = ym.split('-');
    var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    var start = new Date(y, m - 1, 1);
    var end = new Date(y, m, 1); // 다음달 1일 (exclusive)

    var cal = CalendarApp.getDefaultCalendar();
    var events = cal.getEvents(start, end);

    var byDate = {};
    events.forEach(function(e) {
      var allDay = e.isAllDayEvent();
      var s = e.getStartTime();
      var eEnd = e.getEndTime();
      var cursor = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      var endDay = new Date(eEnd.getFullYear(), eEnd.getMonth(), eEnd.getDate());
      if (allDay) endDay.setDate(endDay.getDate() - 1); // 종일 일정의 종료일은 다음날 0시로 반환됨

      while (cursor <= endDay) {
        var key = Utilities.formatDate(cursor, Session.getScriptTimeZone(), 'yyyy-MM-dd');
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push({
          title: e.getTitle(),
          allDay: allDay,
          time: allDay ? '' : Utilities.formatDate(s, Session.getScriptTimeZone(), 'HH:mm')
        });
        cursor.setDate(cursor.getDate() + 1);
      }
    });

    return jsonOut({ ok: true, events: byDate });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

// 캘린더 권한을 처음 허용할 때 한 번 실행하는 함수
function testCalendarAuth() {
  var cal = CalendarApp.getDefaultCalendar();
  Logger.log('캘린더 연결 OK: ' + cal.getName());
}

// ── AI 검색: Gemini API로 자연어 검색어를 필터 조건으로 변환 ─────────
// Gemini API 키는 코드가 아니라 [프로젝트 설정 → 스크립트 속성]의 GEMINI_API_KEY에 저장합니다.
function handleAiSearchParse(body) {
  try {
    const query = String(body.query || '').slice(0, 300);
    const today = (typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today))
      ? body.today : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const categories = Array.isArray(body.categories) ? body.categories.slice(0, 60).map(String) : [];
    if (!query.trim()) throw new Error('검색어가 비어있어요.');

    const filters = callGeminiForSearchFilter(query, today, categories);
    return jsonOut({ ok: true, filters: filters });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

function callGeminiForSearchFilter(query, today, categories) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Gemini API 키가 설정되지 않았어요. (스크립트 속성에 GEMINI_API_KEY 필요)');

  const prompt =
    '너는 가계부 앱의 검색창에 입력된 자연어를, 아래 스키마의 JSON 필터로 변환하는 도구야.\n' +
    '오늘 날짜: ' + today + '\n' +
    '사용 가능한 대분류 목록: ' + categories.join(', ') + '\n' +
    '\n' +
    '변환 규칙:\n' +
    '- type: "수입" | "지출" | "저축" 중 하나, 언급 없으면 빈 문자열\n' +
    '- mid: 위 대분류 목록 중 정확히 일치하는 이름 하나, 없으면 빈 문자열 (목록에 없는 이름을 지어내지 말 것)\n' +
    '- eval: "소비" | "낭비" | "투자" | "저축" 중 하나, 언급 없으면 빈 문자열\n' +
    '- fixed: "fixed"(고정) | "variable"(변동), 언급 없으면 빈 문자열\n' +
    '- dateScope: 기간 관련 의도를 아래 세 가지 중 하나로 분류해줘\n' +
    '  · "all" : "전체", "전체기간", "모든 기간", "처음부터", "지금까지 다" 등 기간 제한 없이 전부 찾아달라는 의도가 명확할 때\n' +
    '  · "range" : "지난달", "작년 여름", "이번주"처럼 구체적인 기간을 특정했을 때 (이때만 dateFrom/dateTo를 채움)\n' +
    '  · "unspecified" : 기간에 대한 언급이 아예 없을 때 (지금 화면에 설정된 기간을 그대로 쓰겠다는 뜻)\n' +
    '- dateFrom, dateTo: dateScope가 "range"일 때만 "YYYY-MM-DD" 형식으로 채움. 그 외(all/unspecified)엔 항상 빈 문자열\n' +
    '- keyword: 위 조건들로 표현 안 되는 나머지 검색어(예: 특정 가게 이름, 메모). 없으면 빈 문자열\n' +
    '\n' +
    '반드시 아래 JSON 형식으로만 답해. 다른 설명이나 마크다운 코드블록 없이 순수 JSON만 출력해:\n' +
    '{"type":"","mid":"","eval":"","fixed":"","dateScope":"unspecified","dateFrom":"","dateTo":"","keyword":""}\n' +
    '\n' +
    '사용자 검색어: "' + query + '"';

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + apiKey;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText());
  if (code !== 200) {
    throw new Error('Gemini 호출 실패: ' + (data.error && data.error.message || code));
  }
  const text = data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
  if (!text) throw new Error('Gemini 응답이 비어있어요.');

  let parsedFilter;
  try {
    parsedFilter = JSON.parse(text);
  } catch (e) {
    throw new Error('Gemini 응답을 JSON으로 해석하지 못했어요: ' + text.slice(0, 200));
  }
  return {
    type: parsedFilter.type || '',
    mid: parsedFilter.mid || '',
    eval: parsedFilter.eval || '',
    fixed: parsedFilter.fixed || '',
    dateScope: parsedFilter.dateScope || 'unspecified',
    dateFrom: parsedFilter.dateFrom || '',
    dateTo: parsedFilter.dateTo || '',
    keyword: parsedFilter.keyword || ''
  };
}
