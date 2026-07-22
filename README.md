# sns-assets

SNS 발행용 이미지 에셋 저장소 (인스타/스레드 카드뉴스 등). jsDelivr CDN으로 서빙.

## Blogger 초안 발행

원고는 YAML frontmatter에 `kind: post|page`, `title`, 선택적으로 `labels: 라벨1,라벨2`(post만)를 지정합니다. 필요한 `BLOGGER_CLIENT_ID`, `BLOGGER_CLIENT_SECRET`, `BLOGGER_REFRESH_TOKEN`, `BLOGGER_BLOG_ID`는 환경변수로만 주입한 뒤 실행합니다.

```bash
node blogger-publish.mjs --draft --out=blogger-result.jsonl /안전한/외부/경로/article.md
```

GitHub Actions에서는 **Blogger 초안 발행** 워크플로를 수동 실행하고 `files`에 저장소 체크아웃에서 접근 가능한 md 경로를 입력합니다. 결과는 `blogger-result` 아티팩트의 JSONL로 확인합니다. 공개 발행은 수동 워크플로에서 `is_draft=false`를 명시한 경우에만 `--no-draft`와 `PUBLISH_LIVE=yes`가 함께 설정되는 이중 잠금 방식입니다.

로컬에서 네트워크 호출 없이 변환기와 차단 규칙을 검증할 수 있습니다.

```bash
node --test blogger-publish.test.mjs
```

> **경고:** 이 저장소는 PUBLIC입니다. 실제 원고와 초안은 절대 커밋하지 마세요. 특히 `content/drafts/`는 로컬 보관 편의를 위한 무시 경로일 뿐이며, Actions 검증용 원고도 민감 정보가 없는 별도 스모크 파일만 사용하세요.
