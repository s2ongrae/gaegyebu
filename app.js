/* ============================================================================
   가계부 웹앱 — 코드 구조 (모듈별 구획)
   ============================================================================ */

/* ── 1. 상수/카테고리/키 정의 ── */

/* ============================================================================
   2. 유틸리티 함수
   ============================================================================ */
var UTILS = (function(){
  function safeParse(raw,fallback){try{var v=JSON.parse(raw);return(v===undefined||v===null)?fallback:v;}catch(e){return fallback;}}
  function isPlainObj(v){return !!v&&typeof v==='object'&&!Array.isArray(v);}
  function readObjKey(key){var v=safeParse(localStorage.getItem(key),null);return isPlainObj(v)?v:{};}
  function readArrKey(key){var v=safeParse(localStorage.getItem(key),null);return Array.isArray(v)?v:[];}
  function mkId(){return'msh'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);}
  function ff(n){var s=Math.abs(n||0).toString();return s.replace(/(\d)(?=(\d{3})+$)/g,'$1,');}
  function f(n){return ff(n);}
  function escHtml(s){return String(s).replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>').replace(/"/g,'"');}
  function escCatHtml(s){return String(s).replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>').replace(/"/g,'"');}
  function isValidYMD(s){return/^\d{4}-\d{2}-\d{2}$/.test(s)&&!isNaN(Date.parse(s));}
  function localYMD(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  function addMonthsYM(ym,n){var p=ym.split('-');var y=+p[0],m=+p[1]+n;return(y+Math.floor((m-1)/12))+'-'+String(((m-1)%12)+1).padStart(2,'0');}
  function curYM(){return localYMD(new Date());}
  function gYM(){return curYM();}
  function showToast(msg,ms){var t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.classList.add('show');},10);setTimeout(function(){t.classList.remove('show');setTimeout(function(){t.remove();},300);},ms||2500);}
  function showToastAction(msg,label,fn){
    var t=document.createElement('div');t.className='toast-act';
    var sp=document.createElement('span');sp.textContent=msg;t.appendChild(sp);
    var b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=function(){t.remove();fn();};t.appendChild(b);
    document.body.appendChild(t);setTimeout(function(){t.remove();},6000);
  }
  function formatAmt(n){return ff(n);}
  function formatAmtSigned(n){return(n>=0?'+':'')+ff(n);}
  function addMonthsToYm(ym,n){return addMonthsYM(ym,n);}
  function getAllMonths(){var all=loadDBRO().txs||[];var m={};all.forEach(function(t){if(t.date)m[t.date.slice(0,7)]=true;});return Object.keys(m).sort();}
  return {safeParse,isPlainObj,readObjKey,readArrKey,mkId,ff,f,escHtml,escCatHtml,isValidYMD,localYMD,addMonthsYM,curYM,gYM,showToast,showToastAction,formatAmt,formatAmtSigned,addMonthsToYm,getAllMonths};
})();

/* ============================================================================
   2. 설정/상수 모듈
   ============================================================================ */
var CONFIG = (function(){
  var CATS={
    '식비':{'p':'지출','s':['외식','배달','식자재','커피']},
    '생활':{'p':'지출','s':['생활서비스','생활용품','가구/가전','기타생활비']},
    '꾸밈':{'p':'지출','s':['의류','화장품','미용실','기타꾸밈비']},
    '교통':{'p':'지출','s':['대중교통','택시','철도','기타교통비']},
    '자동차':{'p':'지출','s':['주유','주차/통행료','유지비 등','자동차 세금','자동차 보험','자동차 할부','자동차 벌금']},
    '주거':{'p':'지출','s':['관리비','가스비','전기요금','대출이자','월세']},
    '통신':{'p':'지출','s':['휴대폰','인터넷/TV','기타통신비']},
    '건강':{'p':'지출','s':['병원','약국','건강식품','운동','기타건강관리']},
    '금융지출':{'p':'지출','s':['보험료','투자손실','기타금융지출','이자/대출']},
    '문화여가':{'p':'지출','s':['영화관람','풋살','런닝','구독료','기타문화비']},
    '교육':{'p':'지출','s':['학원/강의','교육투자','기타교육비']},
    '유흥':{'p':'지출','s':['음주','대리비','기타유흥']},
    '데이트':{'p':'지출','s':['식비','여행','선물','교통비']},
    '반려동물':{'p':'지출','s':['펫보험/병원','메리용품','메리사료/간식','반려동물 기타']},
    '경조선물':{'p':'지출','s':['경조사','선물','엄마적금','엄마보험','기타경조사']},
    '여행':{'p':'지출','s':['항공권','숙박비','기타여행비']},
    '업무지출':{'p':'지출','s':['교통비','기타업무지출','중고업무지출','보험업무지출']},
    '수입':{'p':'수입','s':['레드윗 급여','AZ 급여','투자수입','돌보미수입','보험금수입','중고거래수입','기타수입']},
    '저축':{'p':'저축','s':['주택청약','ISA','IRP','연금저축펀드','종신(KDB)','종신(라이나)','대출상환']}
  };
  var CATS_DEFAULT=JSON.parse(JSON.stringify(CATS));
  var SUB_ICON={
    '외식':'🍽️','배달':'🛵','식자재':'🛒','커피':'☕','식비':'🍽️',
    '생활서비스':'🔧','생활용품':'📦','가구/가전':'🛋️','기타생활비':'🏠',
    '의류':'👔','화장품':'💄','미용실':'✂️','기타꾸밈비':'🪞',
    '대중교통':'🚌','택시':'🚕','철도':'🚆','기타교통비':'🚗',
    '주유':'⛽','주차/통행료':'🅿️','유지비 등':'🔩','자동차 세금':'📋','자동차 보험':'🛡️','자동차 할부':'💳','자동차 벌금':'🚨',
    '관리비':'🏢','가스비':'🔥','전기요금':'⚡','대출이자':'🏦','월세':'🏠',
    '휴대폰':'📱','인터넷/TV':'📡','기타통신비':'📞',
    '병원':'🏥','약국':'💊','건강식품':'🥗','운동':'💪','기타건강관리':'🩺',
    '보험료':'🛡️','투자손실':'📉','기타금융지출':'💰','이자/대출':'📉','투자':'📈',
    '영화관람':'🎬','풋살':'⚽','런닝':'🏃','구독료':'📺','기타문화비':'🎨',
    '학원/강의':'📚','교육투자':'🎓','기타교육비':'✏️',
    '음주':'🍻','대리비':'🚗','기타유흥':'🎉',
    '식비':'🍽️','여행':'✈️','선물':'🎁','교통비':'🚌',
    '펫보험/병원':'🏥','메리용품':'🐕','메리사료/간식':'🍖','반려동물 기타':'🐾',
    '경조사':'🎌','선물':'🎁','엄마적금':'🏦','엄마보험':'🛡️','기타경조사':'🎌',
    '항공권':'✈️','숙박비':'🏨','기타여행비':'🧳',
    '교통비':'🚌','기타업무지출':'💼','중고업무지출':'💼','보험업무지출':'🛡️',
    '레드윗 급여':'💼','AZ 급여':'💼','투자수입':'📈','돌보미수입':'👶','보험금수입':'🛡️','중고거래수입':'🔄','기타수입':'💰',
    '주택청약':'🏠','ISA':'📊','IRP':'🏦','연금저축펀드':'📈','종신(KDB)':'🛡️','종신(라이나)':'🛡️','대출상환':'💳'
  };
  var PAYS=['현금','하나카드(신)','신한카드(신)','롯데카드(신)','토스카드(체)','농협카드'];
  var MC={
    '식비':'#06b6d4','생활':'#94a3b8','꾸밈':'#ec4899','교통':'#f97316','자동차':'#64748b',
    '주거':'#84cc16','통신':'#22d3ee','건강':'#f43f5e','금융지출':'#a78bfa','문화여가':'#fbbf24',
    '교육':'#34d399','유흥':'#ef4444','데이트':'#f472b6','반려동물':'#fb923c','경조선물':'#e879f9',
    '여행':'#38bdf8','업무지출':'#6366f1','수입':'#10b981','저축':'#3b82f6'
  };
  var CE={
    '식비':'🍱','생활':'🏠','꾸밈':'👔','교통':'🚌','자동차':'🚗','주거':'🏡','통신':'📱',
    '건강':'💊','금융지출':'💳','문화여가':'🎬','교육':'📚','유흥':'🍻','데이트':'💑',
    '반려동물':'🐱','경조선물':'🎁','여행':'✈️','업무지출':'💼','수입':'💰','저축':'🏦'
  };
  var USER_CATS_KEY='gaegyebu_user_cats';
  var EXTRA_SUBS_KEY='gaegyebu_extra_subs';
  var FX=[
    {type:'지출',mid:'자동차',sub:'자동차 보험',memo:'',amt:0,pay:'현금',eval:'소비'},
    {type:'지출',mid:'자동차',sub:'자동차 세금',memo:'',amt:0,pay:'현금',eval:'소비'},
    {type:'저축',mid:'저축',sub:'대출상환',memo:'',amt:0,pay:'현금',eval:'저축'}
  ];
  var DEFAULT_AI=[
    {n:'현금',d:'',c:0,o:''},
    {n:'예금',d:'',c:0,o:''},
    {n:'적금',d:'',c:0,o:''},
    {n:'ISA',d:'',c:0,o:''},
    {n:'IRP',d:'',c:0,o:''},
    {n:'연금저축펀드',d:'',c:0,o:''},
    {n:'종신(KDB)',d:'',c:0,o:''},
    {n:'종신(라이나)',d:'',c:0,o:''},
    {n:'주식',d:'',c:0,o:''},
    {n:'비상금',d:'',c:0,o:''}
  ];
  var AI_DELETED_KEY='gaegyebu_deleted_assets';
  var astReorder=false;
  var DB_KEY='gaegyebu';
  var SERVER_URL_KEY='gaegyebu_server_url';
  var SERVER_KEY_KEY='gaegyebu_server_key';
  var BT_KEY='gaegyebu_budget_template';
  var BT=[];
  var GOALS_KEY='gaegyebu_goals';
  var GOALS=[];
  var ANNUAL_INCOME_GOALS=[];
  var ANNUAL_SAVING_GOALS=[];
  var AUTO_MT_PREFIX='auto-mt-';
  var AUTO_MT_OFF_KEY='gaegyebu_auto_mt_off';
  var AUTO_MT_SKIP_KEY='gaegyebu_auto_mt_skip';
  var AUTO_MT_FIRST_FLAG='gaegyebu_auto_mt_first_done_v1';
  var LEGACY_CARD_NAME='신용카드 미결제';
  var LEGACY_CARD_NEW=['하나카드 결제금액','신한카드 결제금액','롯데카드 결제금액'];
  var LEGACY_CAR_NAME='자동차 할부 잔액';
  var LEGACY_CAR_INSTALLMENT='G80 자동차 할부';
  var FIXED_INCOME_SUBS=['레드윗 급여'];
  var LOTTO_FIX_IDS=['msh8lr6v4dom','msh8lr6vdp5f','msh8mcq78frj','msh8mcq74nyh'];
  var KNOWN_TX_FIXES=[
    {mid:'식비',sub:'커피',memo:'스타벅스',payment:'신한카드(신)',eval:'소비'},
    {mid:'교통',sub:'택시',memo:'',payment:'신한카드(신)',eval:'소비'}
  ];
  var PROTECTED_SUBS={
    '금융지출|투자손실':'투자 손익 계산에 쓰이는 항목이라',
    '수입|투자수입':'투자 손익 계산에 쓰이는 항목이라',
    '저축|대출상환':'마통 자동 저축·대출 상환 통계에 쓰이는 항목이라'
  };
  var PROTECTED_MIDS={
    '수입':'기본 구조라',
    '저축':'기본 구조라'
  };
  var CAT_DELETED_KEY='gaegyebu_deleted_cats';
  var COFFEE_RENAME_CLEANUP_FLAG_V2='gaegyebu_coffee_rename_cleanup_v2';
  var FIX_INVEST_FIXED_FLAG='gaegyebu_fix_invest_fixed_v1';
  var LAST_BACKUP_KEY='gaegyebu_last_backup_ok';
  var DRIVE_BACKUP_KEY='gaegyebu_drive_backup';
  var PAYS_CUSTOM_KEY='gaegyebu_pays_custom';
  return {
    CATS,CATS_DEFAULT,SUB_ICON,PAYS,MC,CE,USER_CATS_KEY,EXTRA_SUBS_KEY,FX,DEFAULT_AI,AI_DELETED_KEY,
    astReorder,DB_KEY,SERVER_URL_KEY,SERVER_KEY_KEY,BT_KEY,BT,GOALS_KEY,GOALS,
    ANNUAL_INCOME_GOALS,ANNUAL_SAVING_GOALS,AUTO_MT_PREFIX,AUTO_MT_OFF_KEY,
    AUTO_MT_SKIP_KEY,AUTO_MT_FIRST_FLAG,LEGACY_CARD_NAME,LEGACY_CARD_NEW,
    LEGACY_CAR_NAME,LEGACY_CAR_INSTALLMENT,FIXED_INCOME_SUBS,LOTTO_FIX_IDS,
    KNOWN_TX_FIXES,PROTECTED_SUBS,PROTECTED_MIDS,CAT_DELETED_KEY,
    COFFEE_RENAME_CLEANUP_FLAG_V2,FIX_INVEST_FIXED_FLAG,LAST_BACKUP_KEY,
    DRIVE_BACKUP_KEY,PAYS_CUSTOM_KEY
  };
})();

/* ============================================================================
   전역 변수 공개 (기존 코드 호환용)
   ============================================================================ */
var CATS=CONFIG.CATS,CATS_DEFAULT=CONFIG.CATS_DEFAULT,SUB_ICON=CONFIG.SUB_ICON,PAYS=CONFIG.PAYS,MC=CONFIG.MC,CE=CONFIG.CE;
var USER_CATS_KEY=CONFIG.USER_CATS_KEY,EXTRA_SUBS_KEY=CONFIG.EXTRA_SUBS_KEY,FX=CONFIG.FX,DEFAULT_AI=CONFIG.DEFAULT_AI,AI_DELETED_KEY=CONFIG.AI_DELETED_KEY;
var astReorder=CONFIG.astReorder,DB_KEY=CONFIG.DB_KEY,SERVER_URL_KEY=CONFIG.SERVER_URL_KEY,SERVER_KEY_KEY=CONFIG.SERVER_KEY_KEY;
var BT_KEY=CONFIG.BT_KEY,BT=CONFIG.BT,GOALS_KEY=CONFIG.GOALS_KEY,GOALS=CONFIG.GOALS;
var ANNUAL_INCOME_GOALS=CONFIG.ANNUAL_INCOME_GOALS,ANNUAL_SAVING_GOALS=CONFIG.ANNUAL_SAVING_GOALS;
var AUTO_MT_PREFIX=CONFIG.AUTO_MT_PREFIX,AUTO_MT_OFF_KEY=CONFIG.AUTO_MT_OFF_KEY,AUTO_MT_SKIP_KEY=CONFIG.AUTO_MT_SKIP_KEY,AUTO_MT_FIRST_FLAG=CONFIG.AUTO_MT_FIRST_FLAG;
var LEGACY_CARD_NAME=CONFIG.LEGACY_CARD_NAME,LEGACY_CARD_NEW=CONFIG.LEGACY_CARD_NEW;
var LEGACY_CAR_NAME=CONFIG.LEGACY_CAR_NAME,LEGACY_CAR_INSTALLMENT=CONFIG.LEGACY_CAR_INSTALLMENT;
var FIXED_INCOME_SUBS=CONFIG.FIXED_INCOME_SUBS,LOTTO_FIX_IDS=CONFIG.LOTTO_FIX_IDS;
var KNOWN_TX_FIXES=CONFIG.KNOWN_TX_FIXES,PROTECTED_SUBS=CONFIG.PROTECTED_SUBS,PROTECTED_MIDS=CONFIG.PROTECTED_MIDS;
var CAT_DELETED_KEY=CONFIG.CAT_DELETED_KEY,COFFEE_RENAME_CLEANUP_FLAG_V2=CONFIG.COFFEE_RENAME_CLEANUP_FLAG_V2,FIX_INVEST_FIXED_FLAG=CONFIG.FIX_INVEST_FIXED_FLAG;
var LAST_BACKUP_KEY=CONFIG.LAST_BACKUP_KEY,DRIVE_BACKUP_KEY=CONFIG.DRIVE_BACKUP_KEY,PAYS_CUSTOM_KEY=CONFIG.PAYS_CUSTOM_KEY;
var safeParse=UTILS.safeParse,isPlainObj=UTILS.isPlainObj,readObjKey=UTILS.readObjKey,readArrKey=UTILS.readArrKey,mkId=UTILS.mkId,ff=UTILS.ff,f=UTILS.f,escHtml=UTILS.escHtml,escCatHtml=UTILS.escCatHtml;
var isValidYMD=UTILS.isValidYMD,localYMD=UTILS.localYMD,addMonthsYM=UTILS.addMonthsYM,curYM=UTILS.curYM,gYM=UTILS.gYM;
var showToast=UTILS.showToast,showToastAction=UTILS.showToastAction,formatAmt=UTILS.formatAmt,formatAmtSigned=UTILS.formatAmtSigned;
var addMonthsToYm=UTILS.addMonthsToYm,getAllMonths=UTILS.getAllMonths;

/* ============================================================================
   3. 데이터베이스 모듈
   ============================================================================ */
var DB = (function(){
  var _dbROraw=null,_dbROobj=null;
  function sanitizeDB(db){if(!db)db={};if(!db.txs)db.txs=[];if(!db.budgets)db.budgets={};if(!db.assets)db.assets={};return db;}
  function loadDB(){return sanitizeDB(safeParse(localStorage.getItem(DB_KEY),{}));}
  function loadDBRO(){var raw=localStorage.getItem(DB_KEY);if(raw===_dbROraw)return _dbROobj;_dbROraw=raw;_dbROobj=sanitizeDB(safeParse(raw,{}));return _dbROobj;}
  function saveDB(db){localStorage.setItem(DB_KEY,JSON.stringify(sanitizeDB(db)));scheduleSync();}
  function getTxs(ym){var all=loadDBRO().txs||[];return ym?all.filter(function(t){return t.date&&t.date.indexOf(ym)===0;}):all.slice();}
  function getTxsByDate(date){var db=loadDB();return(db.txs||[]).filter(function(t){return t.date===date;});}
  function addTx(tx){var db=loadDB();if(!db.txs)db.txs=[];tx.id=mkId();tx.fixed=tx.fixed||false;var rgd=readCatDeleted();if(rgd['sub:'+tx.mid+'|'+tx.sub]||rgd['mid:'+tx.mid]){var rr=resolveCatRedirect(tx.mid,tx.sub,rgd);tx.mid=rr.mid;tx.sub=rr.sub;}db.txs.push(tx);saveDB(db);}
  function updateTx(id,upd){var db=loadDB();var idx=-1;(db.txs||[]).forEach(function(t,i){if(t.id===id)idx=i;});if(idx>=0){db.txs[idx]=Object.assign({},db.txs[idx],upd);if(db.txs[idx].auto)db.txs[idx].auto=false;}saveDB(db);}
  function deleteTx(id){if(String(id).indexOf('auto-mt-')===0){var sk=readAutoMtSkip();sk[String(id).slice(8)]=true;saveAutoMtSkip(sk);}var db=loadDB();db.txs=(db.txs||[]).filter(function(t){return t.id!==id;});saveDB(db);}
  function getBudget(ym){var db=loadDBRO();return(db.budgets&&db.budgets[ym])||{};}
  function saveBudgetItem(ym,mid,sub,amt){var db=loadDB();if(!db.budgets)db.budgets={};if(!db.budgets[ym])db.budgets[ym]={};if(!db.budgets[ym][mid])db.budgets[ym][mid]={};db.budgets[ym][mid][sub]=amt;saveDB(db);}
  function clearBudgetItem(ym,mid,sub){var db=loadDB();if(db.budgets&&db.budgets[ym]&&db.budgets[ym][mid])delete db.budgets[ym][mid][sub];saveDB(db);}
  function getAssets(ym){var db=loadDB();return(db.assets&&db.assets[ym])||{};}
  function saveAssetItem(ym,name,amt){var db=loadDB();if(!db.assets)db.assets={};if(!db.assets[ym])db.assets[ym]={};db.assets[ym][name]=amt;saveDB(db);syncAutoMarTongSavings();}
  function loadFX(){var arr=readArrKey('gaegyebu_fx');FX.length=0;arr.forEach(function(f){FX.push(f);});}
  function saveFX(){localStorage.setItem('gaegyebu_fx',JSON.stringify(FX));scheduleSync();}
  function loadAI(){var arr=readArrKey('gaegyebu_ai');AI.length=0;arr.forEach(function(a){AI.push(a);});}
  function saveAI(){localStorage.setItem('gaegyebu_ai',JSON.stringify(AI));scheduleSync();}
  function loadGoals(){var arr=readArrKey(GOALS_KEY);GOALS.length=0;arr.forEach(function(g){GOALS.push(g);});}
  function saveGoals(){localStorage.setItem(GOALS_KEY,JSON.stringify(GOALS));scheduleSync();}
  function loadBT(){var arr=readArrKey(BT_KEY);BT.length=0;arr.forEach(function(b){BT.push(b);});}
  function saveBT(){localStorage.setItem(BT_KEY,JSON.stringify(BT));scheduleSync();}
  return {loadDB,loadDBRO,saveDB,getTxs,getTxsByDate,addTx,updateTx,deleteTx,getBudget,saveBudgetItem,clearBudgetItem,getAssets,saveAssetItem,loadFX,saveFX,loadAI,saveAI,loadGoals,saveGoals,loadBT,saveBT};
})();

/* ============================================================================
   전역 함수 공개
   ============================================================================ */
var loadDB=DB.loadDB,loadDBRO=DB.loadDBRO,saveDB=DB.saveDB,getTxs=DB.getTxs,getTxsByDate=DB.getTxsByDate,addTx=DB.addTx,updateTx=DB.updateTx,deleteTx=DB.deleteTx;
var getBudget=DB.getBudget,saveBudgetItem=DB.saveBudgetItem,clearBudgetItem=DB.clearBudgetItem,getAssets=DB.getAssets,saveAssetItem=DB.saveAssetItem;
var loadFX=DB.loadFX,saveFX=DB.saveFX,loadAI=DB.loadAI,saveAI=DB.saveAI,loadGoals=DB.loadGoals,saveGoals=DB.saveGoals,loadBT=DB.loadBT,saveBT=DB.saveBT;

/* ============================================================================
   4. 서버 동기화 모듈
   ============================================================================ */
var SYNC = (function(){
  var syncTimer=null,lastSyncTime='',syncStatus='idle',_syncMute=0;
  function getServerURL(){return localStorage.getItem(SERVER_URL_KEY)||'';}
  function getServerKey(){return localStorage.getItem(SERVER_KEY_KEY)||'';}
  function serverReady(){return !!(getServerURL()&&getServerKey());}
  function serverCall(obj){var url=getServerURL(),key=getServerKey();if(!url||!key)return Promise.reject('서버 주소·키가 설정돼 있지 않아요.');return fetch(url+'/api/'+obj.cmd,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({key:key},obj))}).then(function(r){return r.json().then(function(d){if(!r.ok)return Promise.reject(d);return d;}).catch(function(){return Promise.reject('서버 응답 오류');});}).catch(function(e){return Promise.reject(e);});}
  function isAuthError(res){return !!(res&&(res.error==='unauthorized'||res.error==='no_key_configured'));}  function onServerAuthFail(res){showToast('⚠️ 서버 인증 실패: 키가 올바르지 않아요.');}
  function lastBackupAgo(){var b=readDriveBackup();if(!b)return'';if(b.error)return' · ⚠️ 드라이브 백업 실패';return b.last?' · 드라이브 백업 '+b.last.slice(5).replace('-','/'):'';}
  function readDriveBackup(){var b=safeParse(localStorage.getItem(DRIVE_BACKUP_KEY),null);return isPlainObj(b)?b:null;}
  function noteDriveBackup(b){localStorage.setItem(DRIVE_BACKUP_KEY,JSON.stringify(b));}
  function driveBackupText(){var b=readDriveBackup();if(!b)return'';if(b.error)return' · ⚠️ 드라이브 백업 실패';return b.last?' · 드라이브 백업 '+b.last.slice(5).replace('-','/'):'';}
  function setSyncStatus(s,msg){syncStatus=s;var el=document.getElementById('sync-status');if(el)el.textContent=msg||'';}
  function scheduleSync(){if(_syncMute>0)return;if(syncTimer)clearTimeout(syncTimer);syncTimer=setTimeout(function(){syncNow();},1000);}
  function syncNow(){if(!serverReady()){syncTimer=setTimeout(syncNow,5000);return;}setSyncStatus('syncing','동기화 중...');var localDB=loadDB(),lastRev=lastSyncTime;serverCall({cmd:'pull',rev:lastRev}).then(function(res){if(!lastRev||res.rev){mergePayloads(res.data||{},false);lastSyncTime=res.rev||curYM();setSyncStatus('idle','동기화 완료');}else{setSyncStatus('idle','서버와 일치');}syncTimer=setTimeout(syncNow,30000);}).catch(function(e){if(String(e).indexOf('auth')>=0)onServerAuthFail();setSyncStatus('idle','동기화 실패: '+e);syncTimer=setTimeout(syncNow,30000);});}
  function pullFromServer(){if(!serverReady())return Promise.reject('서버 주소·키가 설정돼 있지 않아요.');var localDB=loadDB(),lastRev=lastSyncTime;return serverCall({cmd:'pull',rev:lastRev}).then(function(res){mergePayloads(res.data||{},true);lastSyncTime=res.rev||curYM();return res;});}
  function pushToServer(force){if(!serverReady())return Promise.reject('서버 주소·키가 설정돼 있지 않아요.');var localDB=loadDB();return serverCall(Object.assign({cmd:'push',data:localDB},{force:force?true:false})).then(function(res){if(res.rev){lastSyncTime=res.rev;return res;}return Promise.reject('서버 응답');});}
  function mergePayloads(serverData,force){var localDB=loadDB(),merged={},changed=0;merged.txs=localDB.txs||[];merged.budgets=Object.assign({},serverData.budgets||{},localDB.budgets||{});merged.assets=Object.assign({},serverData.assets||{},localDB.assets||{});merged.ais=Object.assign({},serverData.ais||{},localDB.assets||{});if(localDB.txs){(serverData.txs||[]).forEach(function(st){var li=(localDB.txs||[]).findIndex(function(lt){return lt.id===st.id;});if(li>=0){if(st.rev&&(localDB.txs[li].rev||0)<st.rev){merged.txs[li]=st;changed++;}}else{merged.txs.push(st);changed++;}});}if(changed){saveDB(merged);if(force)showToast('🔄 동기화 병합 완료 ('+changed+'개 변경)');}}
  return {syncNow,pullFromServer,pushToServer,mergePayloads,scheduleSync,setSyncStatus,getServerURL,getServerKey,serverReady};
})();

var syncNow=SYNC.syncNow,pullFromServer=SYNC.pullFromServer,pushToServer=SYNC.pushToServer,mergePayloads=SYNC.mergePayloads,scheduleSync=SYNC.scheduleSync,setSyncStatus=SYNC.setSyncStatus;
var getServerURL=SYNC.getServerURL,getServerKey=SYNC.getServerKey,serverReady=SYNC.serverReady;

/* ============================================================================
   5. 카테고리 관리 모듈
   ============================================================================ */
var CAT = (function(){
  function readCatDeleted(){return readObjKey(CAT_DELETED_KEY);}
  function saveCatDeleted(m){localStorage.setItem(CAT_DELETED_KEY,JSON.stringify(m));scheduleSync();}
  function clearCatDeletedFor(mid,sub){var reg=readCatDeleted();delete reg['mid:'+mid];delete reg['sub:'+mid+'|'+sub];saveCatDeleted(reg);}
  function resolveCatRedirect(mid,sub,reg){var key='sub:'+mid+'|'+sub;if(reg[key])return reg[key];var mKey='mid:'+mid;if(reg[mKey])return reg[mKey];return {mid:mid,sub:sub};}
  function buildSearchMidOptions(){var sel=document.getElementById('ti-mid');if(!sel)return;sel.innerHTML='<option value="">-- 선택 --</option>';Object.keys(CATS).forEach(function(mid){var c=CATS[mid];if(c&&(!c.p||c.p==='지출'||c.p==='저축')){sel.innerHTML+='<option value="'+mid+'">'+mid+'</option>';}});}
  function enforceDeletedCats(){var reg=readCatDeleted();if(!reg)return;var txs=loadDBRO().txs||[];txs.forEach(function(t){var dest=resolveCatRedirect(t.mid,t.sub,reg);if(t.mid!==dest.mid||t.sub!==dest.sub){var db=loadDB();var idx=db.txs.findIndex(function(x){return x.id===t.id;});if(idx>=0){db.txs[idx].mid=dest.mid;db.txs[idx].sub=dest.sub;}} });saveDB(loadDB());}
  function rebuildCatsFromStores(){var reg=readCatDeleted();var userCats=loadUserCats();var extraSubs=loadExtraSubs();var txs=loadDBRO().txs||[];}
  function getCatDeleteDestOptions(mid,sub){var opts=[];var reg=readCatDeleted();if(reg['mid:'+mid])opts.push(reg['mid:'+mid]);Object.keys(CATS).forEach(function(rmid){if(rmid!==mid&&CATS[rmid].p===CATS[mid].p){opts.push(rmid);}});return opts;}
  function getCatDeleteBlockReason(mid,sub){var reg=readCatDeleted();var usage=countCatUsage(mid,sub);if(usage<=0){var key='sub:'+mid+'|'+sub;if(reg[key]){var dest=reg[key];return '이 카테고리로 기록된 거래가 '+dest+'로 이미 이동돼 있어서 삭제할 수 없어요.';}return '이 카테고리로 들어간 거래가 없어서 삭제하면 복구가 어려워요.';}return '총 '+usage+'건의 거래가 이 카테고리에 있어서 삭제하면 동시에 옮겨주세요.';}
  function countCatUsage(mid,sub){var txs=loadDBRO().txs||[];return txs.filter(function(t){return t.mid===mid&&t.sub===sub;}).length;}
  function openDeleteCategory(mid,sub,ym){var md=document.createElement('div');md.className='md on';md.id='del-cat-md';var destOpts=getCatDeleteDestOptions(mid,sub);var why=getCatDeleteBlockReason(mid,sub);md.innerHTML='<div class="mdh"><h3>🗑️ 카테고리 삭제</h3><button class="mdc" onclick="document.getElementById(\'del-cat-md\').remove()">✕</button></div><label style="display:flex;gap:6px;align-items:flex-start;cursor:pointer"><input type="radio" name="dcat-mode" value="full" onchange="onDelCatModeChange()"'+(why?' disabled':' checked')+'><span><b>카테고리 완전 삭제</b> — 이 카테고리로 입력된 내역은 다른 카테고리로 옮겨요</span></label><label style="display:flex;gap:6px;align-items:flex-start;cursor:pointer"><input type="radio" name="dcat-mode" value="budget" onchange="onDelCatModeChange()"'+(why?' checked':'')+'><span><b>예산 설정만 삭제</b> — 카테고리는 그대로 두고 예산 금액만 지워요</span></label><div class="al inf" style="font-size:11px;line-height:1.5;margin:8px 0">이 카테고리로 입력돼 있던 <b>'+countCatUsage(mid,sub)+'을(를) 아래 카테고리로 <b>옮겨요</b>. 이 카테고리의 예산 설정은 함께 삭제되고, 앞으로 가져오기 등으로 이 이름이 들어와도 아래 카테고리로 정리돼요.</div><label>옮길 카테고리 <span style="font-weight:400;color:var(--mu)">(같은 종류만 선택 가능)</span></label><select id="del-cat-dest"><option value="">선택</option>'+destOpts.map(function(o){return'<option value="'+o+'">'+o+'</option>';}).join('')+'</select><button class="btn bp bsm mt8" onclick="confirmDeleteCategory(\''+mid+'\',\''+sub+'\')">'+(sub?mid+' > '+sub:mid)+' 삭제</button><div id="del-cat-res" class="mt8" style="font-size:11px"></div>';document.body.appendChild(md);}
  function onDelCatModeChange(){var mode=document.querySelector('input[name="dcat-mode"]:checked').value;var destInput=document.getElementById('del-cat-dest');destInput.disabled=(mode==='budget');if(mode==='budget'){var destRes=document.getElementById('del-cat-res');if(destRes)destRes.textContent='✅ 예산 설정만 삭제합니다. 카테고리는 유지됩니다.';}}
  function confirmDeleteCategory(mid,sub){var mode=document.querySelector('input[name="dcat-mode"]:checked').value;var destMid=document.getElementById('del-cat-dest').value;if(mode==='full'){if(!destMid){showToast('⚠️ 옮길 카테고리를 선택해주세요.');return;}deleteCategoryDeep(mid,sub,destMid);}else{deleteCategoryOnlyBudget(mid,sub);}document.getElementById('del-cat-res').textContent='';}
  function deleteCategoryDeep(mid,sub,destMid){var reg=readCatDeleted();reg['mid:'+mid]=(destMid==='__delete__'?null:{mid:destMid,sub:sub});if(sub)reg['sub:'+mid+'|'+sub]={mid:destMid,sub:sub};saveCatDeleted(reg);var db=loadDB();(db.txs||[]).forEach(function(t){if(t.mid===mid&&(!sub||t.sub===sub)){if(destMid){t.mid=destMid;if(sub)t.sub=sub;}else{db.txs.splice(db.txs.indexOf(t),1);}});if(db.budgets){Object.keys(db.budgets).forEach(function(ym){if(db.budgets[ym][mid]){delete db.budgets[ym][mid];}});}saveDB(db);showToast('✅ 카테고리 삭제 완료');}
  function deleteCategoryOnlyBudget(mid,sub){var db=loadDB();if(db.budgets){Object.keys(db.budgets).forEach(function(ym){if(db.budgets[ym][mid]){delete db.budgets[ym][mid];}});}saveDB(db);showToast('✅ 예산 설정만 삭제했어요.');}
  return {readCatDeleted,saveCatDeleted,clearCatDeletedFor,resolveCatRedirect,buildSearchMidOptions,enforceDeletedCats,rebuildCatsFromStores,getCatDeleteDestOptions,getCatDeleteBlockReason,countCatUsage,openDeleteCategory,onDelCatModeChange,confirmDeleteCategory,deleteCategoryDeep,deleteCategoryOnlyBudget};
})();

var readCatDeleted=CAT.readCatDeleted,saveCatDeleted=CAT.saveCatDeleted,clearCatDeletedFor=CAT.clearCatDeletedFor,resolveCatRedirect=CAT.resolveCatRedirect,buildSearchMidOptions=CAT.buildSearchMidOptions,enforceDeletedCats=CAT.enforceDeletedCats,rebuildCatsFromStores=CAT.rebuildCatsFromStores,getCatDeleteDestOptions=CAT.getCatDeleteDestOptions,getCatDeleteBlockReason=CAT.getCatDeleteBlockReason,countCatUsage=CAT.countCatUsage,openDeleteCategory=CAT.openDeleteCategory,onDelCatModeChange=CAT.onDelCatModeChange,confirmDeleteCategory=CAT.confirmDeleteCategory,deleteCategoryDeep=CAT.deleteCategoryDeep,deleteCategoryOnlyBudget=CAT.deleteCategoryOnlyBudget;

/* ============================================================================
   6. 거래 관리 모듈
   ============================================================================ */
var TX = (function(){
  function isFixed(tx){return tx.fixed||FX_KEYS.indexOf(tx.mid+'|'+tx.sub+'|'+tx.memo)>=0;}
  function isFixedIncome(tx){return FIXED_INCOME_SUBS.indexOf(tx.sub)>=0;}
  function isInvestLossTx(t){return t.mid==='금융지출'&&t.sub==='투자손실';}
  function isIncomeLoss(t){return t.type==='지출'&&isInvestLossTx(t);}
  function incomeAmt(t){if(t.type==='수입')return Number(t.amount)||0;if(isIncomeLoss(t))return -(Number(t.amount)||0);return 0;}
  function isIncomeLike(t){return t.type==='수입'||isIncomeLoss(t);}
  function incomeSubOf(t){return isIncomeLoss(t)?'투자수입':t.sub;}
  function subMedianAmount(mid,sub){var a=(loadDBRO().txs||[]).filter(function(t){return t.mid===mid&&t.sub===sub&&Number(t.amount)>0;}).sort(function(x,y){return x.date<y.date?1:-1;}).slice(0,30).map(function(t){return Number(t.amount);}).sort(function(x,y){return x-y;});return a.length>=3?a[Math.floor(a.length/2)]:0;}
  function txSaveWarnings(tx){var w=[],med=subMedianAmount(tx.mid,tx.sub);if(tx.type==='지출'&&med>0&&tx.amount>=med*5)w.push('💡 이 소분류는 평소 '+ff(med)+' 정도인데 '+ff(tx.amount)+'이에요. 0을 하나 더 치지 않았는지 확인해 주세요.');var dup=(loadDBRO().txs||[]).find(function(t){return t.date===tx.date&&t.type===tx.type&&t.mid===tx.mid&&t.sub===tx.sub&&Number(t.amount)===tx.amount;});if(dup)w.push('⚠️ 같은 날 같은 분류·금액 거래가 이미 있어요'+(dup.memo?'(메모: '+escCatHtml(dup.memo)+')':'')+'.');return w.join('<br>');}
  function budgetLineAmt(t,type,mid,sub){return 0;}
  return {isFixed,isFixedIncome,isInvestLossTx,isIncomeLoss,incomeAmt,isIncomeLike,incomeSubOf,subMedianAmount,txSaveWarnings,budgetLineAmt};
})();

var isFixed=TX.isFixed,isFixedIncome=TX.isFixedIncome,isInvestLossTx=TX.isInvestLossTx,isIncomeLoss=TX.isIncomeLoss,incomeAmt=TX.incomeAmt,isIncomeLike=TX.isIncomeLike,incomeSubOf=TX.incomeSubOf,subMedianAmount=TX.subMedianAmount,txSaveWarnings=TX.txSaveWarnings,budgetLineAmt=TX.budgetLineAmt;

/* ============================================================================
   7. UI 렌더링 모듈
   ============================================================================ */
var UI = (function(){
  var curPage='dash',curYM='',calYM='';
  function go(page,ym){curPage=page;curYM=ym||curYM();document.querySelectorAll('.nav .nb').forEach(function(btn){btn.classList.remove('on');});var el=document.getElementById('nb-'+page);if(el)el.classList.add('on');renderPage(page,ym);}
  function renderPage(page,ym){switch(page){case 'dash':renderDash(ym);break;case 'mon':renderMon(ym);break;case 'inp':renderInp();break;case 'bud':renderBud(ym);break;case 'ast':renderAst(ym);break;case 'stk':renderStk();break;case 'add-fx':openAddFx();break;}}
  function renderDash(ym){}
  function renderMon(ym){}
  function renderInp(){}
  function renderBud(ym){}
  function renderAst(ym){}
  function renderStk(){}
  function openAddFx(){var md=document.createElement('div');md.className='md on';md.id='add-fx-md';md.innerHTML='<div class="mdh"><h3>➕ 고정 거래 추가</h3><button class="mdc" onclick="document.getElementById(\'add-fx-md\').remove()">✕</button></div><div class="fg c2"><div><label>대분류</label><select id="afx-type" onchange="onAfxType()" class="md-input"><option value="수입">수입</option><option value="저축">저축</option><option value="지출" selected>지출</option></select></div><div><label>중분류</label><select id="afx-mid" onchange="onAfxMid()" class="md-input"></select></div></div><div class="fg c2"><div><label>소분류</label><select id="afx-sub" class="md-input"></select></div><div><label>기본금액</label><input type="number" id="afx-amt" min="0" placeholder="0" class="md-input"></div></div><div class="fg c2"><div><label>결제수단</label><select id="afx-pay" class="md-input">'+['현금','하나카드(신)','신한카드(신)','롯데카드(신)','토스카드(체)','농협카드'].map(function(p){return'<option>'+p+'</option>';}).join('')+'</select></div><div><label>지출유형</label><select id="afx-eval" class="md-input"><option value="소비">소비</option><option value="낭비">낭비</option><option value="투자">투자</option><option value="저축">저축</option></select></div></div><div class="fg"><label>메모</label><input type="text" id="afx-memo" placeholder="메모" class="md-input"></div><div class="fx g8 mt8"><button class="btn bp" onclick="confirmAddFx()">💾 추가</button><button class="btn bg2" onclick="document.getElementById(\'add-fx-md\').remove()">취소</button></div></div>';document.body.appendChild(md);onAfxType();}
  function onAfxType(){var type=document.getElementById('afx-type').value;var midSel=document.getElementById('afx-mid');midSel.innerHTML='';Object.keys(CATS).filter(function(m){return CATS[m].p===type;}).forEach(function(m){var o=document.createElement('option');o.value=o.textContent=m;midSel.appendChild(o);});var evalSel=document.getElementById('afx-eval');if(evalSel)evalSel.value=type==='저축'?'저축':'소비';onAfxMid();}
  function onAfxMid(){var m=document.getElementById('afx-mid').value;var ss=document.getElementById('afx-sub');ss.innerHTML='';if(CATS[m])CATS[m].s.forEach(function(s){var o=document.createElement('option');o.value=o.textContent=s;ss.appendChild(o);});}
  function confirmAddFx(){var type=document.getElementById('afx-type').value;var mid=document.getElementById('afx-mid').value;var sub=document.getElementById('afx-sub').value;var amt=Number(document.getElementById('afx-amt').value)||0;var pay=document.getElementById('afx-pay').value;var memo=document.getElementById('afx-memo').value;var eval2=type==='수입'?'':document.getElementById('afx-eval').value;if(!mid||!sub){showToast('⚠️ 카테고리를 선택해주세요.');return;}addFxItem({type:type,mid:mid,sub:sub,memo:memo,amt:amt,pay:pay,eval:eval2});document.getElementById('add-fx-md').remove();buildFixed();showToast('✅ 고정 항목 추가됐어요!');}
  return {go,renderPage,renderDash,renderMon,renderInp,renderBud,renderAst,renderStk,openAddFx,onAfxType,onAfxMid,confirmAddFx};
})();

var go=UI.go,renderPage=UI.renderPage,renderDash=UI.renderDash,renderMon=UI.renderMon,renderInp=UI.renderInp,renderBud=UI.renderBud,renderAst=UI.renderAst,renderStk=UI.renderStk,openAddFx=UI.openAddFx,onAfxType=UI.onAfxType,onAfxMid=UI.onAfxMid,confirmAddFx=UI.confirmAddFx;

/* ============================================================================
   초기화
   ============================================================================ */
function initApp(){
  loadFX();loadAI();loadGoals();loadBT();loadUserCats();loadExtraSubs();
  enforceDeletedCats();
  rebuildCatsFromStores();
  syncNow();
  go('dash',curYM());
}

/* ── 나머지 함수들 (기존 app.js에서 복사해서 붙여넣기) ──
   카테고리 생성/수정/삭제, 입력 폼 자동완성, 내역 렌더링, 예산/자산/목표/주식 탭 등
   (이 부분은 기존 app.js의 나머지 함수들을 그대로 아래에 붙여넣으면 됨)
*/