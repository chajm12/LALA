# Fashion Planning Agent

한 줄의 아이디어/키워드만으로 시장 트렌드 조사 → 컨셉 기획 → 아바타 룩북 생성 → 제작 원가 산출까지 자동으로 수행하는 자율 에이전트입니다.

## 스택

- Next.js (App Router, TypeScript) — 프론트엔드 + API 라우트 통합
- OpenAI
  - `gpt-4o` + 내장 web search 툴: 트렌드 조사, 컨셉 기획, 원가 산출
  - DALL-E 3 (`images.generate`): 아바타 룩북 이미지 생성

## 시작하기

```bash
cp .env.example .env
# .env에 OPENAI_API_KEY 채워넣기
npm install
npm run dev
```

http://localhost:3000 에서 확인.

## 파이프라인

1. **Trend** — 키워드 기반 시장 트렌드 조사 (web search)
2. **Concept** — 트렌드를 바탕으로 컨셉 기획
3. **Lookbook** — 컨셉 기반 아바타 룩북 이미지 생성
4. **Cost** — 컨셉/룩북 기반 제작 원가 산출
