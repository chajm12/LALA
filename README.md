# DDP PARK SAJANG

날짜, 장소, 상황, 성별, 키, 몸무게를 자연어로 입력하면 트렌드와 날씨를 분석하고, 개인 체형과 상황에 맞는 최종 룩북 2안을 생성하는 AgentKit 기반 퍼스널 스타일링 에이전트입니다.

## 핵심 기능

- 자연어 입력 기반 스타일링 요청 처리
- 날짜/장소/상황을 바탕으로 트렌드와 날씨/계절감 분석
- 성별이 없으면 남성 코디를 기본값으로 사용
- 키와 몸무게가 있으면 이미지 생성 시 현실적인 체형 인상 반영
- 5개 착장 후보 생성
- 통합 계획 API에서 후보별 1차 평가 → 실패 원인 분석 → 수정 → 재평가
- 재평가 점수 기준 최종 룩북 2안 선정
- 재평가 화면에서 1차 평가 대비 순위 상승/하강/유지 표시
- 최종 룩북 이미지 생성 및 Vision 검증
- 룩북 결과를 먼저 보여주고, 착용 아이템별 유사 상품 링크는 버튼을 눌렀을 때 검색
- 이전 검색 기록, 걸린 시간, AgentKit Trace 패널 제공

## 기술 스택

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- OpenAI API
- AgentKit-style API tool orchestration

## OpenAI 모델 설정

모델 상수는 `src/lib/openai.ts`에서 관리합니다.

```ts
TEXT_MODEL = "gpt-5.4-mini"
VISION_MODEL = "gpt-5.4-nano"
TREND_MODEL = "gpt-5.6-luna"
PLAN_MODEL = "gpt-5.6-luna"
IMAGE_MODEL = "gpt-image-2"
OPENAI_SERVICE_TIER = "priority"
```

## 실행 방법

```bash
cp .env.example .env
npm install
npm run dev
```

`.env`에는 다음 키가 필요합니다.

```bash
OPENAI_API_KEY=
```

로컬 실행 주소:

```text
http://localhost:3000
```

## 사용 예시

```text
이번 주말 성수동 카페 데이트, 175cm 70kg 남성
```

```text
5월 30일 삼성역 결혼식, 168cm 62kg, 베이지 계열은 피하고 신발 추천도 자세히
```

## 파이프라인

현재 시스템은 기존 API 라우트를 유지하면서 `src/lib/agentkit.ts`의 tool manifest로 묶어 AgentKit 스타일로 오케스트레이션합니다. UI는 이 manifest의 endpoint를 호출하고, 오른쪽 패널은 동일한 manifest 기반 trace를 보여줍니다.

1. 트렌드·날씨 분석
   - 사용자의 자연어 입력에서 날짜, 장소, 상황, 성별, 키, 몸무게, 추가 요구사항을 해석합니다.
   - 웹검색을 활용해 장소/상황 무드, 계절감, 트렌드 단서를 분석합니다.

2. 통합 스타일링 계획
   - 서로 다른 무드, 핏, 색감, 소재, 아이템 조합을 가진 착장 후보 5개를 생성합니다.
   - `outfitItems`에는 실제 착용한 제품을 카테고리와 함께 기록합니다.
   - 날씨, 장소, 체형/핏, 트렌드, 실용성 기준으로 후보를 평가합니다.
   - 실패 원인을 바탕으로 모든 후보를 수정한 뒤 재평가합니다.
   - 1차 평가에는 선택/탈락을 표시하지 않고, 재평가 이후에만 최종 선택/탈락을 확정합니다.
   - 재평가 화면에는 1차 평가 대비 순위 상승/하강/유지를 표시합니다.
   - 최종 2안을 선택하고 선택/탈락 이유를 한국어로 설명합니다.
   - 기존 `후보 생성 → 평가 → 수정 → 재평가 → 최종 선택`의 여러 호출을 `/api/plan` 한 번으로 통합해 실행 시간을 줄였습니다.

3. 룩북 생성
   - 최종 2안에 대해서만 룩북 이미지를 생성합니다.
   - 키와 몸무게가 입력된 경우 이미지 프롬프트에 현실적인 체형 설명을 포함합니다.
   - Vision 모델로 색상, 무드, 타겟 모델 정합성을 검증하고 필요 시 1회 재생성합니다.

4. 쇼핑 링크 검색
   - 룩북 이미지와 설명을 먼저 표시한 뒤, 사용자가 `비슷한 상품 찾기` 버튼을 누르면 상품 링크를 검색합니다.
   - 최종 룩북의 모든 착용 아이템에 대해 유사 상품 링크를 찾습니다.
   - 가능한 경우 직접 상품 상세 링크를 우선 사용합니다.
   - 추천 링크는 실제 페이지 접근과 빈 결과/품절/없는 상품 문구를 검사한 뒤 유효한 링크만 남깁니다.
   - 직접 상품 링크가 부족하면 색감, 핏, 소재, 디자인을 포함한 정교한 검색 결과 링크로 보완합니다.
   - 사용자가 특정 제품군을 요청하면 해당 카테고리 링크를 최상단에 배치합니다.

## 속도 최적화

- 후보 생성, 1차 평가, 후보 수정, 재평가, 최종 선택을 `/api/plan`으로 통합했습니다.
- 쇼핑 링크 웹검색은 자동 실행하지 않고, 사용자가 버튼을 누른 룩에 대해서만 실행합니다.
- `trend`, `plan`, `shopping` Responses API 호출에는 `OPENAI_SERVICE_TIER = "priority"`를 적용합니다.
- 이미지 2장은 병렬 생성합니다.
- 추가 속도 개선이 필요하면 Vision 검증/이미지 재생성을 버튼형으로 바꾸거나, 쇼핑 검색을 핵심 아이템 3개만 검색하도록 줄일 수 있습니다.

## AgentKit Tool 구성

```text
trend    -> /api/trend     # 입력 해석, 날씨·계절, 트렌드 컨텍스트
plan     -> /api/plan      # 후보 생성, 평가, 수정, 재평가, 최종 2안
lookbook -> /api/lookbook  # 최종 룩북 이미지 생성 및 Vision 검증
shopping -> /api/shopping  # 사용자가 요청한 룩의 유사 상품 링크 검색
```

`/api/agentkit`에서 현재 AgentKit tool manifest와 trace step을 확인할 수 있습니다.

## 주요 파일

```text
src/app/page.tsx              # 메인 UI와 프론트 파이프라인
src/app/globals.css           # 전체 디자인 스타일
src/components/LoadingScreen.tsx

src/lib/agentkit.ts           # AgentKit tool manifest와 trace step 정의
src/app/api/agentkit/route.ts # AgentKit manifest 확인 API
src/app/api/trend/route.ts    # 트렌드/날씨/장소 분석
src/app/api/plan/route.ts     # 후보 5개 생성, 평가, 수정, 재평가, 최종 2안 선정
src/app/api/concept/route.ts  # 이전 후보 생성 라우트
src/app/api/evaluate/route.ts # 이전 평가 라우트
src/app/api/lookbook/route.ts # 룩북 이미지 생성 및 Vision 검증
src/app/api/shopping/route.ts # 유사 상품 링크 웹검색

src/lib/openai.ts             # OpenAI 클라이언트와 모델 상수
src/lib/log.ts                # Agent Trace용 서버 로그
```

## 검증 명령어

```bash
npx tsc --noEmit
npm run lint
npm run build
```

## 현재 범위

- 실제 사용자 사진 업로드 기반 얼굴 반영은 제외했습니다.
- 3D 아바타는 제외하고 2D 룩북 이미지 생성에 집중합니다.
- 쇼핑 링크는 웹검색 기반 추천이므로 실제 재고, 가격, 판매 상태는 쇼핑몰에서 최종 확인해야 합니다.
