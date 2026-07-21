#!/usr/bin/env node
// 성과 실측 — posts.jsonl의 최근 게시물별 인사이트(도달·저장·조회 등) 수집 → metrics.jsonl 누적.
// env: IG_TOK, TH_TOK, RUN_DATE
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const IG_TOK = process.env.IG_TOK, TH_TOK = process.env.TH_TOK;
const DATE = process.env.RUN_DATE || '';

const jget = async (u) => { try { const r = await fetch(u); return await r.json(); } catch { return {}; } };
function parseInsights(j) {
  const o = {};
  for (const d of (j.data || [])) o[d.name] = d.values ? d.values[0]?.value : d.total_value?.value;
  return o;
}

const raw = await fs.readFile(path.join(ROOT, 'posts.jsonl'), 'utf8').catch(() => '');
const posts = raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (!posts.length) { console.log('[metrics] posts.jsonl 비어있음 — 수집할 게시물 없음'); process.exit(0); }
const recent = posts.slice(-24); // 최근 ~8일(하루 3건)

const out = [];
for (const p of recent) {
  const ig = p.ig_id ? parseInsights(await jget(`https://graph.instagram.com/v21.0/${p.ig_id}/insights?metric=reach,likes,saved,shares,total_interactions&access_token=${IG_TOK}`)) : {};
  const th = p.th_id ? parseInsights(await jget(`https://graph.threads.net/v1.0/${p.th_id}/insights?metric=views,likes,replies,reposts,quotes&access_token=${TH_TOK}`)) : {};
  out.push({ post_date: p.date, slot: p.slot, keyword: p.keyword, ig, th });
  console.log(`[metrics] ${p.date}-s${p.slot} ${p.keyword} | IG 도달=${ig.reach ?? '-'} 저장=${ig.saved ?? '-'} 공유=${ig.shares ?? '-'} | TH 조회=${th.views ?? '-'} 좋아요=${th.likes ?? '-'} 답글=${th.replies ?? '-'}`);
}

const acc = await jget(`https://graph.instagram.com/v21.0/me?fields=followers_count,media_count&access_token=${IG_TOK}`);
const snapshot = { collected: DATE, ig_followers: acc.followers_count ?? null, ig_media: acc.media_count ?? null, posts: out };
await fs.appendFile(path.join(ROOT, 'metrics.jsonl'), JSON.stringify(snapshot) + '\n');
console.log(`[metrics] 팔로워=${acc.followers_count ?? '-'} 총게시물=${acc.media_count ?? '-'} · ${out.length}건 스냅샷 저장`);

try {
  execFileSync('git', ['-C', ROOT, 'add', 'metrics.jsonl']);
  execFileSync('git', ['-C', ROOT, 'commit', '-m', `metrics ${DATE}`], { stdio: 'ignore' });
  execFileSync('git', ['-C', ROOT, 'push', '-q', 'origin', 'main']);
} catch { /* non-fatal */ }
