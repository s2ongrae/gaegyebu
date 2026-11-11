#!/usr/bin/env node
// privacy-guard: 공개 저장소에 개인정보·비밀값이 올라가지 않게 막는 검사 도구 (외부 패키지 없음)
// 사용법
//   node tools/privacy-guard.js            # git에 올라가 있는(추적 중인) 파일 전체 검사
//   node tools/privacy-guard.js --staged   # 커밋하려고 올린(staged) 파일만 검사 (pre-commit 훅이 사용)
//   node tools/privacy-guard.js --all      # git 없이 폴더 전체 검사
// 걸리면 종료 코드 1. 정말 괜찮은 줄이면 그 줄 끝에 주석으로  privacy-guard: allow  를 붙이세요.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const SELF = path.relative(ROOT, __filename).split(path.sep).join('/');
const SKIP_DIRS = /(^|\/)(\.git|node_modules|vendor|tests)(\/|$)/;
const BIN_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mp3|wasm)$/i;
const MAX_BYTES = 5 * 1024 * 1024;

// 1) 파일 자체가 올라가면 안 되는 것
const BAD_FILES = [
  { re: /(^|\/)\.env(\..*)?$/i, ok: /\.env\.example$|(^|\/)env\.example$/i, why: '.env 파일(키가 들어 있음)' },
  { re: /(백업|backup)[^/]*\.json$/i, why: '백업 JSON(실제 데이터)' },
  { re: /(^|\/)(gaegyebu-data|data)\//i, why: '실제 데이터 폴더' },
];

// 2) 내용 검사 (줄 단위)
const RULES = [
  { id: 'apps-script-url', why: '실제 Apps Script 서버 주소',
    re: /script\.google(?:usercontent)?\.com\/macros\/s\/(AKfyc[\w-]{20,})/g,
    skip: m => /1234\/?$/.test(m[1]) },
  { id: 'google-api-key', why: '구글 API 키', re: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'sheet-drive-url', why: '구글 시트·문서·드라이브 주소',
    re: /(docs\.google\.com\/(?:spreadsheets|document|presentation)\/d\/[\w-]{25,}|drive\.google\.com\/(?:file\/d\/|drive\/folders\/|open\?id=)[\w-]{20,})/g },
  { id: 'hex-secret', why: '32·64자리 비밀 키 모양', re: /(?<![0-9a-fA-F])(?:[0-9a-f]{64}|[0-9a-f]{32})(?![0-9a-fA-F])/g },
  { id: 'rrn', why: '주민등록번호 모양', re: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-?[1-4]\d{6}(?!\d)/g },
  { id: 'phone', why: '휴대전화 번호', re: /(?<!\d)01[016789]-\d{3,4}-\d{4}(?!\d)/g,
    skip: m => /^010-0000-0000$/.test(m[0]) },
  { id: 'email', why: '이메일 주소', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    skip: m => /@(example\.(com|org)|users\.noreply\.github\.com|test\.com)$/i.test(m[0]) || /\.(png|jpe?g|svg|webp|js|css)$/i.test(m[0]) || /^[\w.-]+@\d/.test(m[0]) },
  { id: 'account-no', why: '계좌번호 모양', re: /(?<![\d.-])\d{3,6}-\d{2,6}-\d{3,7}(?:-\d{1,3})?(?![\d.-])/g,
    skip: m => /^0+(-0+)+$/.test(m[0]) || /^(19|20)\d\d-/.test(m[0]) || /^01[016789]-\d{3,4}-\d{4}$/.test(m[0]) },
  { id: 'hardcoded-pin', why: '코드에 박힌 PIN',
    re: /\b\w*(?:pin|PIN|Pin)(?![a-jl-zA-JL-Z])\w*\s*[:=]\s*['"`](\d{4,8})['"`]/g,
    skip: m => /^(0000|1234)$/.test(m[1]) },
  { id: 'hardcoded-password', why: '코드에 박힌 비밀번호',
    re: /\b\w*(?:passw(?:or)?d|PASSWORD|비밀번호)\w*\s*[:=]\s*['"`]([^'"`\s]{6,})['"`]/g,
    skip: m => /^(\*+|x+|placeholder|password)$/i.test(m[1]) },
];

// 3) 파일 단위: 이름이 든 고객·계약 기록 묶음 (한 파일에 사람 이름 칸이 5개 이상)
// 키는 사람 칸(p·c·name·계약자 등)만, 값은 한국 성씨로 시작하는 2~4글자만 (보험상품명 '종신'·'암진단' 등은 제외)
const NAME_FIELD = /["']?(?:name|p|c|owner|person|이름|계약자|피보험자|고객명?|가입자)["']?\s*:\s*["']([김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용][가-힣]{1,3})["']/g;
const NAME_LIMIT = 10; // 카테고리 이름(고정지출 등) 몇 개는 통과, 고객 명단 묶음은 차단

function listFiles(mode) {
  if (mode !== 'all') {
    try {
      const cmd = mode === 'staged' ? 'git diff --cached --name-only --diff-filter=ACMR -z' : 'git ls-files -z';
      return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
    } catch (_) { /* git 없음 → 폴더 전체 */ }
  }
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? dir + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.test(rel + '/')) walk(rel); } else out.push(rel);
    }
  })('');
  return out;
}

function readStaged(rel) {
  try { return execSync('git show :' + JSON.stringify(rel).slice(1, -1), { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BYTES * 2, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (_) { return null; }
}

function main() {
  const mode = process.argv.includes('--staged') ? 'staged' : process.argv.includes('--all') ? 'all' : 'tracked';
  const files = listFiles(mode);
  const hits = [];
  for (const rel of files) {
    if (rel === SELF || rel.endsWith('/privacy-guard.js')) continue;
    for (const b of BAD_FILES) if (b.re.test(rel) && !(b.ok && b.ok.test(rel))) hits.push(`${rel}  ←  ${b.why}`);
    if (SKIP_DIRS.test(rel) || BIN_EXT.test(rel)) continue;
    let text = mode === 'staged' ? readStaged(rel) : null;
    if (text === null) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).size > MAX_BYTES) continue;
      text = fs.readFileSync(abs, 'utf8');
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes('privacy-guard: allow')) return;
      for (const r of RULES) {
        r.re.lastIndex = 0;
        let m;
        while ((m = r.re.exec(line))) {
          if (r.skip && r.skip(m)) continue;
          const shown = m[0].length > 14 ? m[0].slice(0, 6) + '…' + m[0].slice(-4) : m[0].replace(/\d(?=\d{2})/g, '•');
          hits.push(`${rel}:${i + 1}  ←  ${r.why} (${shown})`);
        }
      }
    });
    const names = new Set();
    let nm; NAME_FIELD.lastIndex = 0;
    while ((nm = NAME_FIELD.exec(text))) names.add(nm[1]);
    if (names.size >= NAME_LIMIT) hits.push(`${rel}  ←  사람 이름이 든 기록 ${names.size}개 (고객·계약 자료로 보임)`);
  }
  if (hits.length) {
    console.error('\n⛔ privacy-guard: 공개 저장소에 올리면 안 되는 내용이 있어요 (' + hits.length + '건)\n');
    hits.forEach(h => console.error('  - ' + h));
    console.error('\n고친 뒤 다시 실행하세요. 정말 괜찮은 줄이면 그 줄에  privacy-guard: allow  주석을 붙이세요.\n');
    process.exit(1);
  }
  console.log('✅ privacy-guard: 통과 (' + files.length + '개 파일 검사)');
}
main();
