#!/usr/bin/env node
// SNS 자동 발행 파이프라인 — 시크릿은 코드에 없음(env로만 주입).
// env: GEMINI_API_KEY, IG_TOK, TH_TOK  |  flags: --dry-run, --slot=N
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DRY = process.argv.includes('--dry-run');
const SLOT = (process.argv.find(a => a.startsWith('--slot=')) || '--slot=0').split('=')[1];
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const REPO = 'Guhyeon-Kim/sns-assets';
const CHROME = process.env.CHROME_BIN || 'google-chrome';

// ---- 0. 컴플라이언스 필터 (광범위 트렌드에 섞이는 민감주제 차단) ----
const BANNED = /(사망|숨져|숨진|사고|참사|화재|지진|폭행|성폭|살인|마약|자살|극단|정치|대통령|여당|야당|선거|국회|파업|시위|전쟁|北|북한|미사일|테러|주가조작|투자자문|도박|베팅|성인|음란|확진|사기|고소|고발|논란|열애|이혼|폭로)/;
const okKeyword = (t) => !BANNED.test(t);

// ---- 1. 구글 트렌드 KR 전일 급상승 ----
async function fetchTrends() {
  const res = await fetch('https://trends.google.com/trending/rss?geo=KR', { headers: { 'user-agent': 'Mozilla/5.0' } });
  const xml = await res.text();
  const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)]
    .map(m => m[1].trim()).filter(t => t && t !== 'Daily Search Trends');
  return titles;
}

// ---- 2. Gemini 공통 헬퍼 (재시도·모델폴백·JSON) ----
async function geminiJSON(prompt, temperature = 0.9) {
  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  let j, lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const model = models[Math.min(attempt, models.length - 1)];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature, responseMimeType: 'application/json' } })
      });
      j = await res.json();
      if (res.ok && j.candidates) break;
      lastErr = 'Gemini ' + res.status + ' ' + JSON.stringify(j).slice(0, 160);
      if (res.ok || ![429, 500, 503].includes(res.status)) throw new Error(lastErr);
    } catch (e) { lastErr = e.message; }
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  if (!j?.candidates) throw new Error('Gemini 최종실패: ' + lastErr);
  const txt = (j.candidates[0]?.content?.parts?.[0]?.text || '').replace(/^```json\s*|\s*```$/g, '').trim();
  return JSON.parse(txt);
}

// ---- 2-a. AI 안전 게이트 (fail-closed) ----
async function safetyGate(keyword) {
  const prompt = `너는 SNS 자동발행 안전 심사관이다. 키워드 "${keyword}"로 일반 공개 계정에 정보성 카드뉴스를 자동 게시하려 한다.
아래 중 하나라도 해당하면 위험(unsafe): 특정 실존 인물(연예인·정치인·운동선수 등 개인 이름)·정치/선거·성/성적지향/성인·사망/사고/재난/범죄·질병/의료 논란·종교 갈등·혐오/차별·투자권유·논란/스캔들·상표/브랜드 분쟁.
정보성으로 안전한 일반 주제(생활·경제일반·기술·과학·스포츠 일반·문화·상식·제품/서비스 일반)만 안전(safe).
JSON만: {"safe": true|false, "category": "분류", "reason": "10자내외"}`;
  try { return await geminiJSON(prompt, 0.1); }
  catch (e) { return { safe: false, category: 'error', reason: '심사실패' }; }
}

// 트렌드가 모두 걸러졌을 때 쓰는 안전 주제풀 (매 회차 반드시 발행 보장)
const SAFE_TOPICS = ['생활 속 절세 팁', '초보 재테크 기초', '스마트폰 배터리 오래 쓰는 법', '집중력 높이는 습관',
  '냉장고 정리의 기술', '수면의 질 높이는 법', '엑셀 단축키 모음', '전기요금 아끼는 법',
  '알아두면 쓸모있는 생활 법률', '커피 맛있게 내리는 법', '운동 초보 루틴', '시간관리 기법'];

// ---- 2-b. 카피 생성 ----
async function genCopy(keyword) {
  const prompt = `너는 한국어 SNS 콘텐츠 작가다. 키워드 "${keyword}"로 인스타 카드뉴스 + 스레드 글을 만든다.
독자가 "몰랐던 사실/맥락"을 알게 되는 정보성 콘텐츠. 과장·허위·투자권유·정치·자극 금지. 반드시 아래 JSON만 출력(마크다운·설명 금지):
{
 "topic": "이 키워드를 다루는 구체 앵글 한 줄",
 "threads_text": "500자 이내. 후킹 첫 줄 + 핵심 2~3문단 + 마지막 답글 유도 질문. 이모지 최소.",
 "ig_caption": "후킹 1줄 + 요약 3~4문장 + '프로필 링크에서 더 보기' CTA + 해시태그 8개(#포함, 공백구분)",
 "cards": [
   {"type":"cover","kicker":"","title":"표지 대제목(≤14자, 강한후킹)","body":"부제(≤30자)"},
   {"type":"body","kicker":"소제목(≤10자)","title":"대제목(≤14자)","body":"본문(≤45자)"},
   {"type":"body","kicker":"","title":"","body":""},
   {"type":"body","kicker":"","title":"","body":""},
   {"type":"body","kicker":"","title":"","body":""},
   {"type":"body","kicker":"","title":"","body":""},
   {"type":"body","kicker":"","title":"","body":""},
   {"type":"cta","kicker":"","title":"저장 유도 대제목(≤14자)","body":"팔로우+저장 유도 한 줄"}
 ]
}
정확히 8장. 2~7번은 내용으로 채운다.`;
  return geminiJSON(prompt, 0.9);
}

// ---- 3. 카드 렌더 ----
function cardHtml(cards) {
  return `<!doctype html><html lang=ko><head><meta charset=utf-8>
<style>@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
*{margin:0;padding:0;box-sizing:border-box}html,body{background:#0b1020}
.slide{width:1080px;height:1350px;position:relative;overflow:hidden;font-family:'Pretendard',sans-serif;color:#fff;display:flex;flex-direction:column;padding:96px 90px;
background:radial-gradient(1200px 700px at 80% -10%,rgba(124,92,255,.35),transparent 60%),radial-gradient(900px 600px at -10% 110%,rgba(64,196,255,.22),transparent 55%),linear-gradient(160deg,#0b1020,#121a35)}
.badge{display:inline-flex;align-items:center;gap:14px;font-size:30px;font-weight:700;color:#b9c2ff}.dot{width:14px;height:14px;border-radius:50%;background:#7c5cff;box-shadow:0 0 24px #7c5cff}
.sp{flex:1}.kicker{font-size:36px;font-weight:600;color:#8ea0ff;margin-bottom:24px}
h1{font-size:100px;font-weight:800;line-height:1.1;letter-spacing:-2px}.hl{color:#9d86ff}
h2{font-size:78px;font-weight:800;line-height:1.14;letter-spacing:-1.5px}
.body{font-size:46px;font-weight:500;line-height:1.5;color:#c7cfe6;margin-top:34px;max-width:840px}
.tag{margin-top:40px;font-size:46px;color:#c7cfe6;font-weight:600;line-height:1.4}
.foot{display:flex;justify-content:space-between;align-items:center;font-size:30px;color:#8b95b5;font-weight:600}.num{color:#7c5cff;font-weight:800}
.cta-btn{margin-top:52px;display:inline-flex;background:#7c5cff;color:#fff;font-size:46px;font-weight:800;padding:32px 54px;border-radius:999px;box-shadow:0 20px 60px rgba(124,92,255,.5)}
.emoji{font-size:120px}</style></head><body>
<div class=slide id=s><div class=badge><span class=dot></span>@gu__planner</div><div class=sp></div><div id=m></div><div class=sp></div>
<div class=foot><span id=fl></span><span class=num id=fr></span></div></div>
<script>const C=${JSON.stringify(cards)};const q=new URLSearchParams(location.search);const i=Math.max(0,Math.min(C.length-1,parseInt(q.get('s')||'0')));const c=C[i];
let h='';if(c.type==='cover'){h='<div class=emoji>🔎</div><h1>'+c.title+'</h1>'+(c.body?'<div class=tag>'+c.body+'</div>':'');}
else if(c.type==='cta'){h='<div class=emoji>📌</div><h2>'+c.title+'</h2>'+(c.body?'<div class=body>'+c.body+'</div>':'')+'<div class=cta-btn>팔로우 + 저장하기 🔖</div>';}
else{h=(c.kicker?'<div class=kicker>'+c.kicker+'</div>':'')+'<h2>'+c.title+'</h2>'+(c.body?'<div class=body>'+c.body+'</div>':'');}
document.getElementById('m').innerHTML=h;document.getElementById('fr').textContent=(i+1)+' / '+C.length;document.getElementById('fl').textContent=i===0?'SWIPE →':'@gu__planner';</script></body></html>`;
}

async function renderCards(cards, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'index.html');
  await fs.writeFile(htmlPath, cardHtml(cards));
  const files = [];
  for (let i = 0; i < cards.length; i++) {
    const out = path.join(outDir, `card-${i + 1}.png`);
    // file:// 직접 렌더 — 서버 불필요(동기 execFileSync가 이벤트루프를 막는 데드락 회피)
    execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=1080,1350', `--screenshot=${out}`, `file://${htmlPath}?s=${i}`],
      { stdio: 'ignore', timeout: 30000 });
    const st = await fs.stat(out).catch(() => null);
    if (!st || st.size < 1000) throw new Error(`card-${i + 1} 렌더 실패(빈 파일)`);
    files.push(out);
  }
  return files;
}

// ---- 4. 호스팅 (git push → jsDelivr) ----
function hostImages(srcDir, folder) {
  const dest = path.join(ROOT, folder);
  execFileSync('bash', ['-c', `mkdir -p "${dest}" && cp "${srcDir}"/card-*.png "${dest}/"`]);
  execFileSync('git', ['-C', ROOT, 'add', '-A']);
  execFileSync('git', ['-C', ROOT, 'commit', '-m', `auto: ${folder}`], { stdio: 'ignore' });
  execFileSync('git', ['-C', ROOT, 'push', '-q', 'origin', 'main']);
  return `https://cdn.jsdelivr.net/gh/${REPO}@main/${folder}`;
}

// ---- 5. 발행 ----
async function fapi(base, ep, params, tok) {
  const body = new URLSearchParams({ ...params, access_token: tok });
  const res = await fetch(`${base}/${ep}`, { method: 'POST', body });
  return res.json();
}
async function publishThreads(text, tok) {
  const b = 'https://graph.threads.net/v1.0';
  const c = await fapi(b, 'me/threads', { media_type: 'TEXT', text }, tok);
  if (!c.id) throw new Error('threads container ' + JSON.stringify(c));
  await new Promise(r => setTimeout(r, 2000));
  const p = await fapi(b, 'me/threads_publish', { creation_id: c.id }, tok);
  if (!p.id) throw new Error('threads publish ' + JSON.stringify(p));
  return p.id;
}
async function publishIG(caption, urls, tok) {
  const b = 'https://graph.instagram.com/v21.0';
  const kids = [];
  for (const u of urls) {
    const c = await fapi(b, 'me/media', { is_carousel_item: 'true', image_url: u }, tok);
    if (!c.id) throw new Error('ig child ' + JSON.stringify(c));
    kids.push(c.id);
  }
  const par = await fapi(b, 'me/media', { media_type: 'CAROUSEL', children: kids.join(','), caption }, tok);
  if (!par.id) throw new Error('ig carousel ' + JSON.stringify(par));
  await new Promise(r => setTimeout(r, 3000));
  const pub = await fapi(b, 'me/media_publish', { creation_id: par.id }, tok);
  if (!pub.id) throw new Error('ig publish ' + JSON.stringify(pub));
  return pub.id;
}

// ---- main ----
const log = (...a) => console.log('[pipe]', ...a);
(async () => {
  log(DRY ? 'DRY-RUN' : 'LIVE', 'slot=' + SLOT);
  const trends = await fetchTrends();
  log('trends:', trends.slice(0, 8).join(' | '));
  const safe = trends.filter(okKeyword);
  const skipped = trends.filter(t => !okKeyword(t));
  log('필터 통과:', safe.slice(0, 6).join(' | '));
  log('컴플라이언스 스킵:', skipped.slice(0, 6).join(' | ') || '(없음)');
  // AI 안전 게이트: 통과 키워드만 수집 → slot-번째 선택, 부족하면 안전 주제풀 폴백
  const slot = Number(SLOT);
  const passers = [], gateLog = [];
  for (const cand of safe.slice(0, 10)) {
    const g = await safetyGate(cand);
    gateLog.push(`${cand}→${g.safe ? '✅' : '⛔'}(${g.reason})`);
    if (g.safe) passers.push(cand);
    if (passers.length > slot) break;
  }
  log('AI게이트:', gateLog.join(' | '));
  let keyword = passers[slot];
  if (!keyword) {
    const idx = (Number((process.env.RUN_DATE || '0').replaceAll('-', '')) + slot) % SAFE_TOPICS.length;
    keyword = SAFE_TOPICS[idx];
    log('트렌드 안전 키워드 부족 → 안전 주제풀 폴백:', keyword);
  }
  log('선택 키워드:', keyword);

  const copy = await genCopy(keyword);
  log('앵글:', copy.topic);
  log('카드수:', copy.cards?.length, '| 스레드길이:', copy.threads_text?.length);

  const slug = keyword.replace(/[^가-힣a-zA-Z0-9]/g, '').slice(0, 20) || 'kw';
  const folder = `auto/${process.env.RUN_DATE || 'dryrun'}-${slug}${DRY ? '-dry' : ''}`;
  const tmp = path.join(ROOT, '.render');
  await renderCards(copy.cards, tmp);
  log('카드 렌더 완료:', copy.cards.length, '장');

  const base = hostImages(tmp, folder);
  const urls = copy.cards.map((_, i) => `${base}/card-${i + 1}.png`);
  log('호스팅:', base);

  await fs.writeFile(path.join(ROOT, '.render', 'copy.json'), JSON.stringify(copy, null, 2));

  if (DRY) { log('DRY-RUN 종료 — 발행 안 함. 카피/이미지 준비까지 성공.'); log('THREADS 미리보기:\n' + copy.threads_text); log('CAPTION 미리보기:\n' + copy.ig_caption); return; }

  const tid = await publishThreads(copy.threads_text, process.env.TH_TOK);
  log('THREADS 발행:', tid);
  const iid = await publishIG(copy.ig_caption, urls, process.env.IG_TOK);
  log('INSTAGRAM 발행:', iid);
})().catch(e => { console.error('[pipe][ERROR]', e.message); process.exit(1); });
