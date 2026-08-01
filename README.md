# DDP PARK SAJANG

날짜, 장소, 상황, 성별, 키, 몸무게를 자연어로 입력하면 트렌드와 날씨를 분석하고, 개인 체형과 상황에 맞는 최종 룩북 2안을 생성하는 퍼스널 스타일링 에이전트입니다.

## 핵심 기능

- 자연어 입력 기반 스타일링 요청 처리
- 날짜/장소/상황을 바탕으로 트렌드와 날씨/계절감 분석
- 성별이 없으면 남성 코디를 기본값으로 사용
- 키와 몸무게가 있으면 이미지 생성 시 현실적인 체형 인상 반영
- 5개 착장 후보 생성
- 후보별 1차 평가 → 실패 원인 분석 → 수정 → 재평가
- 재평가 점수 기준 최종 룩북 2안 선정
- 최종 룩북 이미지 생성 및 Vision 검증
- 룩북에 포함된 착용 아이템별 유사 상품 링크 제공
- 이전 검색 기록, 걸린 시간, Agent Trace 패널 제공

## 기술 스택

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- OpenAI API

## OpenAI 모델 설정

모델 상수는 `src/lib/openai.ts`에서 관리합니다.

```ts
TEXT_MODEL = "gpt-5.4-mini"
VISION_MODEL = "gpt-5.4-nano"
TREND_MODEL = "gpt-5.6-luna"
IMAGE_MODEL = "gpt-image-2"
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
8월 10일 성수동 카페 데이트, 남성, 175cm 70kg, 너무 포멀하지 않게
```

```text
5월 30일 삼성역 결혼식, 168cm 62kg, 베이지 계열은 피하고 신발 추천도 자세히
```

## 파이프라인

1. 트렌드·날씨 분석
   - 사용자의 자연어 입력에서 날짜, 장소, 상황, 성별, 키, 몸무게, 추가 요구사항을 해석합니다.
   - 웹검색을 활용해 장소/상황 무드, 계절감, 트렌드 단서를 분석합니다.

2. 후보 생성
   - 서로 다른 무드, 핏, 색감, 소재, 아이템 조합을 가진 착장 후보 5개를 생성합니다.
   - `outfitItems`에는 실제 착용한 제품을 카테고리와 함께 기록합니다.

3. 평가·수정·재평가
   - 날씨, 장소, 체형/핏, 트렌드, 실용성 기준으로 후보를 평가합니다.
   - 실패 원인을 바탕으로 모든 후보를 수정한 뒤 재평가합니다.
   - 최종 2안을 선택하고 선택/탈락 이유를 한국어로 설명합니다.

4. 룩북 생성
   - 최종 2안에 대해서만 룩북 이미지를 생성합니다.
   - 키와 몸무게가 입력된 경우 이미지 프롬프트에 현실적인 체형 설명을 포함합니다.
   - Vision 모델로 색상, 무드, 타겟 모델 정합성을 검증하고 필요 시 1회 재생성합니다.

5. 쇼핑 링크 검색
   - 최종 룩북의 모든 착용 아이템에 대해 유사 상품 링크를 찾습니다.
   - 가능한 경우 직접 상품 상세 링크를 우선 사용합니다.
   - 직접 상품 링크가 부족하면 색감, 핏, 소재, 디자인을 포함한 정교한 검색 결과 링크로 보완합니다.
   - 사용자가 특정 제품군을 요청하면 해당 카테고리 링크를 최상단에 배치합니다.

## 주요 파일

```text
src/app/page.tsx              # 메인 UI와 프론트 파이프라인
src/app/globals.css           # 전체 디자인 스타일
src/components/LoadingScreen.tsx

src/app/api/trend/route.ts    # 트렌드/날씨/장소 분석
src/app/api/concept/route.ts  # 착장 후보 5개 생성
src/app/api/evaluate/route.ts # 평가, 수정, 재평가, 최종 2안 선정
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
