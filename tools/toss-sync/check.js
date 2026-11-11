// 연결 확인(조회만): 토큰 → 계좌 → 보유 종목·예수금을 표로 보여 준다. 가계부 서버에는 아무것도 보내지 않는다.
// 사용: node check.js        → 출력 숫자를 토스증권 앱 화면과 눈으로 대조하세요.
'use strict';
const T = require('./toss');
(async () => {
  const env = T.loadEnv();
  T.log('설정 파일:', env.__file);
  const c = new T.TossClient({ clientId: env.TOSS_CLIENT_ID, clientSecret: env.TOSS_CLIENT_SECRET });
  const s = await T.collect(c, { accountSeq: env.TOSS_ACCOUNT_SEQ || null });
  T.log('\n계좌:', s.accounts.map(a => a.no + ' (seq ' + a.seq + ')').join(', '));
  T.log('기준 시각:', s.at, s.fx ? '· 환율 1달러=' + s.fx.usdkrw + '원(매매기준율)' : '');
  T.log('\n종목'.padEnd(18), '수량'.padStart(8), '평가금액'.padStart(14), '손익'.padStart(14), '수익률'.padStart(8), '비중'.padStart(6));
  for (const it of s.items) T.log(it.name.slice(0, 14).padEnd(16), String(it.qty).padStart(8), T.won(it.valueKRW).padStart(14), T.won(it.plKRW).padStart(14), T.pct(it.plRate).padStart(8), ((it.weight * 100).toFixed(1) + '%').padStart(6));
  T.log('\n총 평가금액', T.won(s.totals.value.krwTotal), '· 투자원금', T.won(s.totals.purchase.krwTotal), '· 손익', T.won(s.totals.pl.krwTotal), T.pct(s.totals.plRate));
  T.log('오늘 손익', T.won(s.totals.daily.krwTotal), '· 예수금(현금 매수 가능)', T.won(s.cash.krwTotal), '· 최근 31일 체결', s.orders.length + '건');
  T.log('\n✔ 위 숫자가 토스증권 앱과 같은지 확인해 주세요. 같으면 `node sync.js` 로 가계부에 저장할 수 있어요.');
})().catch(async e => {
  T.warn('\n✗ ' + e.message);
  if (e instanceof T.TossIpError) { const ip = await T.publicIp(); T.warn('  지금 이 컴퓨터의 공인 IP: ' + (ip || '(확인 실패 — 터미널에서 curl ifconfig.me)')); }
  process.exit(1);
});
