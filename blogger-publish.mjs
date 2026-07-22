#!/usr/bin/env node
// Blogger 초안 발행기 — 인증 정보는 반드시 env로만 주입한다.
// 지원 마크다운: h2/h3, 표, 굵게, 링크, 목록, 인용, 구분선.
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED_ENV = ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN', 'BLOGGER_BLOG_ID'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function inlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>'); // 굵게 처리 후 남은 단일 * 만 기울임
  return text;
}

function splitTableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

export function markdownToHtml(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const html = [];
  let paragraph = [];
  let list = null;

  const closeParagraph = () => {
    if (paragraph.length) html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] || '';
    if (/^\s*\|?.+\|.+\|?\s*$/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      closeParagraph(); closeList();
      const heads = splitTableRow(line);
      html.push('<table><thead><tr>' + heads.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitTableRow(lines[i]);
        html.push('<tr>' + cells.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('') + '</tr>');
        i++;
      }
      html.push('</tbody></table>');
      i--;
      continue;
    }
    if (!line.trim()) { closeParagraph(); closeList(); continue; }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) { closeParagraph(); closeList(); html.push('<hr>'); continue; }
    const heading = line.match(/^(##|###)\s+(.+)$/);
    if (heading) { closeParagraph(); closeList(); const level = heading[1].length; html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { closeParagraph(); closeList(); html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); continue; }
    const item = line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/);
    if (item) {
      closeParagraph();
      const wanted = item[2] ? 'ol' : 'ul';
      if (list !== wanted) { closeList(); list = wanted; html.push(`<${list}>`); }
      html.push(`<li>${inlineMarkdown(item[3])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  closeParagraph(); closeList();
  return html.join('\n');
}

export function parseFrontmatter(source, file) {
  const normalized = source.replaceAll('\r\n', '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`${file}: frontmatter가 없습니다`);
  const meta = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!field) throw new Error(`${file}: frontmatter 형식 오류`);
    meta[field[1]] = field[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!['post', 'page'].includes(meta.kind)) throw new Error(`${file}: kind는 post 또는 page여야 합니다`);
  if (!meta.title) throw new Error(`${file}: title이 없습니다`);
  if (meta.kind === 'page' && meta.labels) throw new Error(`${file}: page에는 labels를 사용할 수 없습니다`);
  const labels = meta.labels ? meta.labels.split(',').map((label) => label.trim()).filter(Boolean) : [];
  return { kind: meta.kind, title: meta.title, labels, content: markdownToHtml(match[2]) };
}

async function responseError(response) {
  let message = '';
  try { message = (await response.json())?.error?.message || ''; } catch { /* 본문이 JSON이 아닐 수 있다. */ }
  return `HTTP ${response.status}${message ? `: ${message}` : ''}`;
}

async function requestWithRetry(url, options, label, retryAll = false) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      lastError = new Error(await responseError(response));
      if (!retryAll && response.status !== 429 && response.status < 500) break;
    } catch (error) { lastError = error; }
    if (attempt < 3) await sleep(1000 * (2 ** (attempt - 1)));
  }
  throw new Error(`${label} 실패: ${lastError?.message || '알 수 없는 오류'}`);
}

async function refreshAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.BLOGGER_CLIENT_ID,
    client_secret: process.env.BLOGGER_CLIENT_SECRET,
    refresh_token: process.env.BLOGGER_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  try {
    const response = await requestWithRetry('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
    }, 'OAuth 토큰 갱신', true);
    const token = (await response.json()).access_token;
    if (!token) throw new Error('응답에 access_token이 없습니다');
    return token;
  } catch (error) {
    throw new Error(`${error.message}. refresh token이 만료되거나 취소됐다면 재인증이 필요합니다`);
  }
}

async function deleteUnexpected(kind, id, token) {
  const endpoint = kind === 'post' ? 'posts' : 'pages';
  const url = `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(process.env.BLOGGER_BLOG_ID)}/${endpoint}/${encodeURIComponent(id)}`;
  const response = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`비초안 삭제 실패: ${await responseError(response)}`);
}

async function publishDraft(item, token) {
  const endpoint = item.kind === 'post' ? 'posts' : 'pages';
  const url = `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(process.env.BLOGGER_BLOG_ID)}/${endpoint}?isDraft=true`;
  const payload = { kind: `blogger#${item.kind}`, title: item.title, content: item.content };
  if (item.kind === 'post' && item.labels.length) payload.labels = item.labels;
  const response = await requestWithRetry(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }, `${item.kind} 초안 업로드`);
  const result = await response.json();
  if (result.status !== 'DRAFT') {
    if (!result.id) throw new Error(`응답 status=${result.status || '없음'}, 삭제할 id도 없음`);
    await deleteUnexpected(item.kind, result.id, token);
    throw new Error(`응답 status=${result.status || '없음'}: 비초안 항목을 즉시 삭제했습니다`);
  }
  return { kind: item.kind, title: item.title, id: result.id, url: result.url, status: result.status, ok: true };
}

export async function main(args = process.argv.slice(2)) {
  const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missingEnv.length) throw new Error(`필수 환경변수 누락: ${missingEnv.join(', ')}`);

  const outArg = args.find((arg) => arg.startsWith('--out='));
  const outPath = outArg?.slice('--out='.length) || 'blogger-result.jsonl';
  const files = args.filter((arg) => !arg.startsWith('--'));
  const requestedLive = args.includes('--no-draft');
  if (requestedLive) {
    const lock = process.env.PUBLISH_LIVE === 'yes' ? '이중 잠금이 설정됐지만 현재 정책상' : 'PUBLISH_LIVE=yes 이중 잠금이 없어';
    console.error(`[blogger][WARN] ${lock} 공개 발행은 금지됩니다. 초안으로 강제합니다.`);
  }
  if (!files.length) throw new Error('사용법: node blogger-publish.mjs [--draft] [--out=경로] <file.md ...>');

  await fs.writeFile(outPath, '');
  const token = await refreshAccessToken();
  let failed = false;
  for (const file of files) {
    let record;
    let item;
    try {
      const source = await fs.readFile(file, 'utf8');
      item = parseFrontmatter(source, file);
      record = await publishDraft(item, token);
    } catch (error) {
      failed = true;
      record = { kind: item?.kind || null, title: item?.title || file, id: null, url: null, status: 'FAILED', ok: false, error: error.message };
    }
    const line = JSON.stringify(record);
    console.log(line);
    await fs.appendFile(outPath, line + '\n');
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[blogger][ERROR]', error.message);
    process.exit(1);
  });
}
