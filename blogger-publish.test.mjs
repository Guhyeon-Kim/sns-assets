import assert from 'node:assert/strict';
import test from 'node:test';
import { livePublishingAllowed, markdownToHtml, parseFrontmatter } from './blogger-publish.mjs';

test('post frontmatter와 지원 마크다운을 Blogger HTML로 변환한다', () => {
  const source = `---\nkind: post\ntitle: 테스트 글\nlabels: 청약, 주거\n---\n\n## 핵심\n\n**중요**한 [공식 링크](https://example.com)입니다.\n\n| 항목 | 값 |\n|---|---|\n| 상태 | 초안 |\n`;
  const item = parseFrontmatter(source, 'ok.md');
  assert.deepEqual(item.labels, ['청약', '주거']);
  assert.match(item.content, /<h2>핵심<\/h2>/);
  assert.match(item.content, /<strong>중요<\/strong>/);
  assert.match(item.content, /<table>/);
});

test('page에 labels가 있으면 발행 전에 차단한다', () => {
  const source = `---\nkind: page\ntitle: 소개\nlabels: 금지\n---\n본문`;
  assert.throws(() => parseFrontmatter(source, 'bad.md'), /page에는 labels를 사용할 수 없습니다/);
});

test('원문 HTML은 이스케이프해 스크립트 삽입을 막는다', () => {
  const html = markdownToHtml('본문 <script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('공개 발행은 플래그와 환경 이중 잠금이 모두 필요하다', () => {
  assert.equal(livePublishingAllowed(['--no-draft'], {}), false);
  assert.equal(livePublishingAllowed([], { PUBLISH_LIVE: 'yes' }), false);
  assert.equal(livePublishingAllowed(['--no-draft'], { PUBLISH_LIVE: 'yes' }), true);
});
