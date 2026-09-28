# DDP PARK SAJANG

날짜, 장소, 상황, 성별, 키, 몸무게를 자연어로 입력하면 실시간 패션 레퍼런스·장소 무드·날씨를 분석하고, 사용자와 대화하며 선택한 후보를 룩북으로 생성하는 AgentKit 기반 퍼스널 스타일링 에이전트입니다.

## 핵심 기능

- 자연어 입력 기반 스타일링 요청 처리
- 사용자 요구사항 추출 Agent가 명시적 요구·회피 요소·추가 질문 항목을 구조화
- 날씨 → 장소 무드 → 핏 → 소재·레이어링 순서의 대화형 스타일 상담
- 날짜/장소/상황을 바탕으로 트렌드와 날씨/계절감 분석
- 최신 패션 기사·룩북·편집숍 레퍼런스 웹 리서치
- 도시·동네·상권별 장소 컨텍스트와 패션 무드 반영
- 성별이 없으면 남성 코디를 기본값으로 사용
- 키와 몸무게가 있으면 이미지 생성 시 현실적인 체형 인상 반영
- 5개 착장 후보 생성
- 분리된 Tool 호출로 후보 생성 → 1차 평가 → 실패 원인 기반 수정 → 재평가
- 코드 기반 `weather_fit`, `color_harmony`, `diversity` Verifier
- 로컬 휴리스틱 기반 장소·상황(`occasion_fit`) 평가
- 재평가 점수 기준 5개 후보 정렬 및 사용자가 선택한 n개 룩북 생성
- 재평가 화면에서 1차 평가 대비 순위 상승/하강/유지 표시
- 최종 룩북 이미지 생성 및 Vision 검증
- 룩북 결과를 먼저 보여주고, 착용 아이템별 유사 상품 링크는 버튼을 눌렀을 때 검색
- 이전 검색 기록, 대화 요약, 별도 AgentKit Trace 패널 제공

## 기술 스택

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- NVIDIA NIM API (입력 해석, 스타일 계획, 평가, Vision 검증)
- Open-Meteo Geocoding/Forecast API (날씨 Tool)
- OpenAI Image API (현재 룩북 이미지 생성)
- 공식 `nvidia-nat` Python Workflow (동일한 Next.js API를 NAT Tool로 등록)
- 기본 UI도 `/api/agent`를 통과하는 Agent Orchestrator 기반 API tool orchestration

## NVIDIA 모델 설정

NVIDIA 모델 상수는 `src/lib/nvidia.ts`에서 관리합니다. 모델 ID는 `build.nvidia.com`에서 발급한 API 키와 함께 NVIDIA의 OpenAI 호환 엔드포인트로 호출됩니다.

```ts
NVIDIA_TEXT_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
NVIDIA_PLAN_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
NVIDIA_AGENT_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
NVIDIA_VISION_MODEL = "moonshotai/kimi-k3"
NVIDIA_FAST_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
```

## 실행 방법

```bash
cp .env.example .env
npm install
npm run dev
```

`.env`에는 다음 키가 필요합니다.

```bash
NVIDIA_API_KEY=
OPENAI_API_KEY=
NVIDIA_TEXT_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
NVIDIA_PLAN_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
NVIDIA_AGENT_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
NVIDIA_FAST_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
NVIDIA_VISION_MODEL=moonshotai/kimi-k3
NAT_WORKFLOW_URL=
```

`NVIDIA_API_KEY`는 `build.nvidia.com`에서 발급합니다. NVIDIA 텍스트/에이전트 호출은 `chat.completions` 방식으로 실행됩니다. 현재 이미지 생성은 OpenAI API, 패션·장소 웹 리서치는 OpenAI Web Search, 날씨는 Open-Meteo를 사용하며, 이 경계를 발표 자료에도 명시합니다.

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

현재 UI는 대화형 세션에서 필요한 Tool을 단계별로 호출하지만, 모든 핵심 요청은 `/api/agent`를 통과합니다. `prepare`, `consult`, `plan`, `lookbook`, `refine`, `shopping` Action을 Agent Orchestrator가 각 Tool로 라우팅하고, Tool Call/Result trace를 별도 토글 창에 표시합니다. 핵심 판단은 NVIDIA NIM, 패션 레퍼런스와 장소 보완 리서치는 OpenAI Web Search, 날씨 조회는 Open-Meteo Tool, 이미지 생성은 OpenAI API가 담당합니다. `nemo_agent/`를 설치하면 동일한 Tool 계약을 공식 NeMo Agent Toolkit Workflow로 실행할 수 있습니다.

> 아래 단계의 `/api/intent`, `/api/trend`, `/api/consult`, `/api/plan`, `/api/lookbook`은 개별 Tool 경로입니다. 브라우저 UI는 이 경로들을 직접 호출하지 않고 `/api/agent` Action을 통해 실행합니다.

1. Agent Orchestrator 진입
   - 검색 Enter 후 `/api/intent`와 `/api/trend`를 병렬 호출합니다. 요구사항 Agent는 반드시 지킬 조건과 질문이 필요한 정보를 구조화하고, trend Tool은 날짜·장소·날씨·트렌드 컨텍스트를 준비합니다.
   - 각 단계의 사용자 피드백은 `/api/consult`가 NVIDIA NIM으로 다시 해석해 다음 추천에 반영합니다. 상담 Tool이 지연되면 기본 전략으로 대체합니다.
   - 구조화된 사용자 요구사항과 대화 피드백을 포함해 `/api/plan`이 후보 생성 → 1차 평가 → 실패 원인 수정 → 재평가를 실행합니다.
   - 사용자가 선택한 후보만 `/api/lookbook`으로 병렬 생성합니다.
   - 각 Tool Call과 Tool Result는 별도 Agent Trace 창에 실시간 표시됩니다.

2. 트렌드·날씨 분석
   - 사용자의 자연어 입력에서 날짜, 장소, 상황, 성별, 키, 몸무게, 추가 요구사항을 해석합니다.
   - 로컬 파서가 자연어에서 날짜·장소 힌트를 먼저 추출해 `get_weather` Tool에 전달합니다.
   - `2주 뒤 주말`, 도시·구·동·역·상권 표현을 보존해 Open-Meteo Geocoding/Forecast로 위치와 날짜의 날씨를 확인합니다.
   - 날씨, NVIDIA 컨텍스트, 현재 시즌 패션 웹 리서치, 상세 지역 리서치를 병렬 실행한 뒤 합칩니다.
   - 좌표가 서울 기준으로 보완되어도 장소 무드는 사용자가 입력한 동네·상권 이름을 기준으로 별도 유지합니다.

3. Agentic 스타일링 Loop
   - 요구사항 Agent의 결과는 공유된 사용자 의도 계약으로 전달되어, 후보 생성·상담·수정 단계에서 직접 요구가 레퍼런스보다 우선하도록 합니다.
   - 웹에서 조사한 시즌 실루엣·비율·표면감·패턴·스타일 언어를 바탕으로 서로 다른 착장 후보 5개를 생성합니다.
   - 오래된 기본 코디 템플릿을 피하고, 후보마다 구체적인 비율 변화·소재·패턴·레이어링 디테일을 요구합니다.
   - `outfitItems`에는 실제 착용한 제품을 카테고리와 함께 기록합니다.
   - 1차 평가는 로컬 휴리스틱과 Objective Verifier가 즉시 계산하고, NVIDIA 호출을 추가하지 않습니다.
   - `weather_fit`은 Open-Meteo 결과와 옷의 보온·방수 요소를 코드로 비교합니다.
   - `color_harmony`는 색상군 수와 중성색·포인트색 균형을 코드로 계산합니다.
   - `diversity`는 후보 간 아이템·색감·무드 유사도를 코드로 계산합니다.
   - 실패 원인을 바탕으로 `repair_and_re_evaluate`가 모든 후보를 수정하고 같은 응답에서 재평가합니다.
   - 사용자 요구 준수는 품질 가중치가 아니라 하드 게이트로 처리합니다. 요구를 모두 충족한 후보는 사용자 요구 100점으로 통과시키고, 미충족 후보만 100점 아래로 내려 순위에서 우선 제외합니다. 통과 후보의 총점은 장소·상황 28%, 날씨 22%, 체형·핏 18%, 트렌드·소재 14%, 색 조화 12%, 실용성 6%로 비교하며, 후보 다양성은 최종 2안 선택 시 유사도 패널티로만 반영합니다.
   - 1차 평가에는 선택/탈락을 표시하지 않고, 재평가 이후에만 최종 선택/탈락을 확정합니다.
   - 재평가 화면에는 1차 평가 대비 순위 상승/하강/유지를 표시합니다.
   - 재평가 순위를 사용자에게 보여주고 사용자가 원하는 n개를 직접 선택합니다.
   - `/api/plan`은 외부에서는 하나의 endpoint지만 내부에서는 후보 생성, 평가, 수정, 재평가를 각각 별도 NVIDIA 호출로 실행합니다.

4. 룩북 생성
   - 사용자가 선택한 n안에 대해서만 룩북 이미지를 병렬 생성합니다.
   - 키와 몸무게가 입력된 경우 이미지 프롬프트에 현실적인 체형 설명을 포함합니다.
   - 최종 재평가의 날씨·장소/상황·체형·색 조화 점수와 Verifier 이슈를 이미지 프롬프트에 전달합니다.
   - NVIDIA 멀티모달 NIM으로 착용 아이템, 색상, 실루엣, 전신 노출, 체형, 상황 적합성을 1회 검증합니다.
   - 검증에서 불일치가 발견되어도 자동 이미지 재생성은 하지 않고 결과와 불일치 내용을 함께 반환합니다.

5. 쇼핑 링크 검색
   - 룩북 이미지와 설명을 먼저 표시한 뒤, 사용자가 `비슷한 상품 찾기` 버튼을 누르면 상품 링크를 검색합니다.
   - 최종 룩북의 모든 착용 아이템에 대해 유사 상품 링크를 찾습니다.
   - 가능한 경우 직접 상품 상세 링크를 우선 사용합니다.
   - 추천 링크는 실제 페이지 접근과 빈 결과/품절/없는 상품 문구를 검사한 뒤 유효한 링크만 남깁니다.
   - 직접 상품 링크가 부족하면 색감, 핏, 소재, 디자인을 포함한 정교한 검색 결과 링크로 보완합니다.
   - 사용자가 특정 제품군을 요청하면 해당 카테고리 링크를 최상단에 배치합니다.

6. NeMo Agent Toolkit 실행
   - `nemo_agent/pyproject.toml`이 공식 `nvidia-nat` 플러그인과 DDP API Tool을 등록합니다.
   - `nemo_agent/configs/config.yml`은 Nemotron NIM을 메인 모델로 사용하고, `/api/trend`, `/api/consult`, `/api/plan`, `/api/lookbook`을 Tool-calling Agent에 연결합니다.
   - `NAT_WORKFLOW_URL`은 `/api/agent`의 `full` Workflow 요청에서 NAT 서버를 우선 사용하도록 설정합니다. 단계별 UI Action은 응답 계약을 유지하기 위해 Next.js Agent Orchestrator가 실행합니다.

## 제출용 재현 실행

Next.js와 NeMo Agent Toolkit을 각각 실행하면 동일한 Tool 계약을 로컬 Agent Orchestrator와 공식 NAT Workflow에서 재현할 수 있습니다.

```bash
# 터미널 1
npm run dev

# 터미널 2
NVIDIA_API_KEY=... DDP_APP_URL=http://localhost:3000 ./scripts/run-nat.sh
```

NAT 서버는 기본적으로 `http://localhost:8000`에서 실행되며, 전체 Workflow는 다음처럼 직접 확인할 수 있습니다.

```bash
source .venv/bin/activate
nat run --config_file nemo_agent/configs/config.yml \
  --input '{"keyword":"다음주 주말 을지로 데이트, 175cm 70kg 남성"}'
```

반복 가능한 Agent 평가 데이터와 설정은 `nemo_agent/eval/`에 있습니다.

```bash
nat eval --config_file nemo_agent/configs/eval_config.yml
```

NVIDIA API가 없는 환경에서도 TypeScript 앱의 fallback은 동작하지만, 대회 제출 데모에서는 NVIDIA NIM 키와 NAT 실행 로그를 함께 준비해야 합니다.

## 속도 참고

- Agentic Loop의 실제 분리 호출로 인해 후보 계획 단계는 단일 호출보다 길어질 수 있습니다.
- 쇼핑 링크 웹검색은 자동 실행하지 않고, 사용자가 버튼을 누른 룩에 대해서만 실행합니다.
- NVIDIA NIM 텍스트 호출은 `chat.completions` 방식으로 실행합니다.
- `trend`는 NVIDIA Tool Calling과 Open-Meteo 조회를 결합합니다.
- 선택한 이미지는 병렬 생성합니다.
- Verifier는 코드 기반으로 실행되어 별도 LLM 호출을 추가하지 않습니다.
- Vision 검증은 1회만 수행하고 자동 이미지 재생성은 생략해 응답 시간을 제한합니다.
- 이미지 생성 품질은 현재 `medium`으로 유지하며, 속도 측정 후 마지막 단계에서 조정합니다.
- NVIDIA 계획 호출이 제한시간을 넘으면 로컬 후보·평가·수정 fallback으로 전체 파이프라인을 계속 진행합니다.

## NeMo Agent Toolkit 실행

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e nemo_agent
nat run --config_file nemo_agent/configs/config.yml \
  --input '{"keyword":"다음주 주말 을지로 데이트, 175cm 70kg 남성"}'
```

HTTP Workflow 서버가 필요하면 `nat serve --config_file nemo_agent/configs/config.yml`을 사용합니다. NAT 환경에서 Next.js 주소가 `localhost:3000`이 아니면 `DDP_APP_URL`을 지정합니다.

## AgentKit Tool 구성

```text
intent   -> /api/intent    # 명시적 요구, 회피 요소, 무드·핏·소재, 부족 정보 추출
trend    -> /api/trend     # 입력 해석, 날씨·계절, 트렌드 컨텍스트
consult  -> /api/consult   # 장소 무드, 핏, 소재·레이어링에 대한 대화형 조정
plan     -> /api/plan      # 후보 생성, 평가, 수정, 재평가, 사용자 선택 대기
lookbook -> /api/lookbook  # 최종 룩북 이미지 생성 및 Vision 검증
shopping -> /api/shopping  # 사용자가 요청한 룩의 유사 상품 링크 검색
agent    -> /api/agent     # 위 Tool의 실행 순서를 선택하는 NVIDIA Agent Orchestrator
```

`/api/agentkit`에서 현재 AgentKit tool manifest와 trace step을 확인할 수 있습니다.

## 주요 파일

```text
src/app/page.tsx              # 검색·대화·후보 선택·최종 룩북 UI와 Tool 호출
src/app/globals.css           # 전체 디자인 스타일
src/components/LoadingScreen.tsx

src/lib/agentkit.ts           # AgentKit tool manifest와 trace step 정의
src/app/api/agent/route.ts    # Agent Orchestrator, SSE trace, Tool 상태 제어
src/app/api/agentkit/route.ts # AgentKit manifest 확인 API
src/app/api/intent/route.ts   # 사용자 요구사항 추출 Agent와 로컬 fallback
src/app/api/trend/route.ts    # 트렌드/날씨/장소/실시간 패션 레퍼런스 분석
src/app/api/consult/route.ts  # 단계별 사용자 피드백을 반영하는 NVIDIA 스타일 상담
src/app/api/plan/route.ts     # 후보 5개 생성, 평가, 수정, 재평가, 사용자 선택용 결과
src/app/api/concept/route.ts  # 이전 후보 생성 라우트
src/app/api/evaluate/route.ts # 이전 평가 라우트
src/app/api/lookbook/route.ts # 룩북 이미지 생성 및 Vision 검증
src/app/api/refine/route.ts   # 선택한 룩의 대화형 수정·이미지 재생성
src/app/api/shopping/route.ts # 유사 상품 링크 웹검색

src/lib/nvidia.ts             # NVIDIA NIM 클라이언트와 모델 상수
src/lib/weather.ts            # Open-Meteo Geocoding/Forecast Tool
src/lib/verifiers.ts          # 날씨·색 조화·후보 다양성 Objective Verifier
src/lib/openai.ts             # 현재 이미지 생성 및 쇼핑 검색용 OpenAI 클라이언트
src/lib/log.ts                # Agent Trace용 서버 로그
nemo_agent/                   # 공식 NeMo Agent Toolkit Python Workflow
nemo_agent/configs/config.yml
nemo_agent/src/ddp_nemo_agent/register.py
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
