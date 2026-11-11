// 동기화: 토스증권 보유 현황을 스냅샷으로 만들어 가계부 서버에 저장한다(조회 전용).
// 사용: node sync.js          저장
//       node sync.js --dry    서버에 보내지 않고 요약만 출력
// 매번 ../gaegyebu-data/toss-snapshots/날짜.json 에도 사본을 남긴다(저장소 밖, 개인 기록).
'use strict';
const fs = require('fs'), path = require('path');
const T = require('./toss');
const DRY = process.argv.includes('--dry');
(async () => {
  const env = T.loadEnv();
  const c = new T.TossClient({ clientId: env.TOSS_CLIENT_ID, clientSecret: env.TOSS_CLIENT_SECRET });
  const s = await T.collect(c, { accountSeq: env.TOSS_ACCOUNT_SEQ || null });
  T.log(`[${s.at}] 종목 ${s.items.length}개 · 평가 ${T.won(s.totals.value.krwTotal)} · 손익 ${T.won(s.totals.pl.krwTotal)} (${T.pct(s.totals.plRate)}) · 오늘 ${T.won(s.totals.daily.krwTotal)} · 예수금 ${T.won(s.cash.krwTotal)}`);
  const dir = path.join(path.dirname(env.__file), 'toss-snapshots');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, s.date + '.json'), JSON.stringify(s, null, 2)); } catch (e) { T.warn('  (로컬 사본 저장 실패: ' + e.message + ')'); }
  if (DRY) { T.log('--dry: 서버에는 보내지 않았어요.'); return; }
  const r = await T.uploadSnapshot({ url: env.GAEGYEBU_SERVER_URL, key: env.GAEGYEBU_SERVER_KEY, snapshot: s });
  T.log('✔ 가계부에 저장했어요 · 날짜별 기록', r.historyCount + '일');
  await T.reportStatus({ url: env.GAEGYEBU_SERVER_URL, key: env.GAEGYEBU_SERVER_KEY, error: '' });
  T.writeStatusFile(env.__file, { ok: true, by: 'sync' });
})().catch(async e => {
  // 실패도 가계부 서버·노트북 상태 파일에 남긴다(정해진 시각 실행·피클 실행에서도 앱에 "지난번 실패: 이유"가 보이게)
  const cls = T.classifyError(e);
  let msg = T.errorText(e, cls);
  if (e instanceof T.TossIpError) { const ip = await T.publicIp(); msg = '[IP] 토스 허용 IP가 아닌 곳이에요(지금 ' + (ip || '?') + '). 토스증권 웹 설정 > Open API > 허용 IP 에 등록하세요.'; }
  T.warn('✗ ' + msg);
  let env = {}; try { env = T.loadEnv(); } catch (x) { /* .env 없음 */ }
  await T.reportStatus({ url: env.GAEGYEBU_SERVER_URL, key: env.GAEGYEBU_SERVER_KEY, error: msg });
  if (env.__file) T.writeStatusFile(env.__file, { ok: false, by: 'sync', code: cls.code, error: msg });
  process.exit({ IP: 2, AUTH: 3, API: 4, SERVER: 5, NET: 6 }[cls.code] || 1); // 종료 코드로도 구분(피클·작업 스케줄러가 읽을 수 있게)
});
