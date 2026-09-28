# DDP PARK SAJANG — 패션 이커머스 퍼스널 스타일링 에이전트

> Korea Agentic AI Hackathon (패스트캠퍼스 × NVIDIA) 제출작 · Track: Creative Use-case

"10월 4일 성수동 카페 데이트, 남성, 175cm 70kg, 너무 포멀하지 않게" 한 문장을 입력하면, 에이전트가 날씨·장소·체형·요구 조건을 해석하고, 사용자와 짧게 상담해 방향을 정한 뒤, 착장 후보를 만들어 평가·수정하고, 선택한 룩을 이미지로 렌더링해 착장 명세와 대조하고, 실제 판매처에서 살 수 있는 상품까지 찾아 검증합니다. 결과를 보고 "아우터만 더 가볍게"처럼 이어서 요청하면 그 부분만 다시 작업합니다.

---

## 1. 어떤 문제를 푸는가

패션 이커머스에서 고객은 "이 상황에 뭘 입지"를 묻고, 쇼핑몰은 상품을 팔아야 합니다. 그 사이를 잇는 코디 추천은 지금도 사람이 하거나(스타일리스트·MD), 태그 기반 필터로 뭉뚱그려 제공됩니다. 그 결과 고객은 상황·체형에 맞지 않는 옷을 사서 반품하고, 쇼핑몰은 룩북 촬영과 CS에 비용을 씁니다.

이 프로젝트는 **쇼핑몰이 고객에게 제공하는 AI 스타일리스트**를 목표로 합니다. 고객이 자연어로 상황을 말하면 에이전트가 근거(실제 날씨 수치, 장소 무드, 체형, 명시 요구)를 모아 착장을 설계하고, 그 착장이 실제로 살 수 있는 상품과 연결되는지까지 확인합니다. "예쁜 코디를 보여주는 챗봇"이 아니라 **판단하고, 검증하고, 실제 상품으로 닫는 에이전트**입니다.

## 2. 데모 흐름

1. **입력** — 날짜·장소·상황·성별·키·몸무게·제약을 한 문장으로.
2. **스타일 상담** — 에이전트가 요구사항을 구조화하고 날씨·장소 컨텍스트를 분석한 뒤, 결과를 크게 바꿀 정보만 묻습니다. 선택지는 "제목 + 그 선택이 코디에 주는 변화 한 줄" 카드로 제시되며, 자유 입력도 가능합니다.
3. **후보 평가** — 착장 후보 5개를 생성하고 코드 검증기(날씨 적합·색 조화·다양성·상황 적합)와 사용자 요구 준수 점수로 평가·수정·재평가합니다. 사용자가 룩북으로 볼 후보를 직접 고릅니다.
4. **룩북** — 선택한 룩을 체형을 반영한 전신 이미지로 생성하고, 이미지에서 품목별 색상·무늬·소매를 읽어 착장 명세와 대조합니다.
5. **상품 매칭** — 착용 아이템마다 국내 판매처(무신사·29CM·크림 등 허용 목록) 상세 페이지를 찾아 색상·무늬·종류 불일치를 걸러내고, 룩북과 상품 사진을 비교해 표시합니다.
6. **수정 대화** — "신발만 로퍼로", "재킷 색만 네이비로"처럼 말하면 해당 품목만 바꾸고 나머지는 유지합니다. 되돌리기도 됩니다.

실행 중 모든 도구 호출과 검증 결과는 **Agent Trace** 패널에 기록됩니다.

## 3. 아키텍처

```
사용자 ──▶ Next.js UI ──▶ /api/agent (Agent Orchestrator)
                              │
        ┌─────────────────────┼──────────────────────────────┐
        ▼                     ▼                              ▼
 user_intent_extractor   analyze_context                outfit_planner
 (/api/intent)           (/api/trend)                   (/api/plan)
 Nemotron NIM            Open-Meteo 날씨 + 패션 리서치     Nemotron NIM 생성·수정
                                                        + 코드 검증기(weather_fit,
                                                          color_harmony, diversity,
                                                          occasion_fit, request_fit)
        ▼                     ▼                              ▼
 style_consultation      lookbook_generator            look_refinement / shopping_link_search
 (/api/consult)          (/api/lookbook)               (/api/refine, /api/shopping)
 Nemotron NIM            이미지 생성 + 품목별 사진 검사     Nemotron NIM 부분 수정 /
                                                        판매처 검색·상세 검증·사진 비교

 동일한 도구 세트를 NeMo Agent Toolkit(nemo_agent/)의 tool_calling_agent 워크플로로도 실행 (nat run / serve / eval)
```

### 사용 스택

| 역할 | 구성 |
|---|---|
| 요구 해석 · 상담 · 후보 생성/수정 · 룩 부분 수정 | **NVIDIA Nemotron** (`nvidia/nemotron-3.5-lightning-30b-a3b`) — NVIDIA NIM 호스팅 엔드포인트, OpenAI 호환 API |
| 에이전트 워크플로 · 평가 | **NVIDIA NeMo Agent Toolkit** (`nvidia-nat[langchain]`) — Next.js 라우트를 NAT 도구로 등록, `nat run / serve / eval` |
| 날씨 | Open-Meteo (지오코딩 + 예보/기후) |
| 후보 검증 | 코드 기반 검증기(`src/lib/verifiers.ts`) + 사용자 요구 계약(`/api/plan`) |
| 룩북 이미지 · 이미지 속성 검사 · 판매처 검색 | OpenAI (gpt-image-2, GPT-5.4 mini) — 현재 버전에서 NVIDIA 스택으로 대체하지 못한 부분입니다 (5절 참고) |
| 앱 | Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 |

모델·엔드포인트는 전부 `.env`로 바꿀 수 있어서, 호스팅 NIM에서 자체 NIM 컨테이너(예: L40S)로 옮길 때 `NVIDIA_BASE_URL` 한 줄만 바꾸면 됩니다.

## 4. 에이전트가 하는 판단

**요구사항 계약.** 사용자 원문에서 반드시 지킬 것(mustHave), 피할 것(avoid), 무드·핏·소재 방향, 부족한 정보를 구조화합니다(`/api/intent`). 이 계약은 후보 생성 프롬프트에 들어갈 뿐 아니라 코드로도 검사됩니다. "검정 피해줘", "하의는 데님"을 어긴 후보는 `requestScore`가 깎이고, 명시 요구가 빠진 후보는 경고와 함께 표시됩니다.

**근거 기반 컨텍스트.** 날씨는 검색 요약이 아니라 Open-Meteo의 기온·강수·바람 수치입니다. 예보 범위를 벗어난 날짜는 계절감으로 대체하되 수치를 지어내지 않습니다. 장소는 입력된 지역명을 서울이나 다른 도시로 바꾸지 않습니다.

**생성 → 평가 → 수정 → 재평가.** 후보 5개를 만든 뒤, `weather_fit`(기온·강수·바람 대비 보온·방수 요소), `color_harmony`(색상군 수와 중성색 균형), `diversity`(후보 간 아이템·색·무드 유사도), `occasion_fit`(장소·약속 포멀리티)을 코드로 채점하고, 실패 원인을 근거로 후보를 수정해 다시 채점합니다. 모델 호출이 실패하면 확보한 후보와 평가로 이어가고(`planStatus: partial`), 그 사실을 UI에 그대로 보여줍니다.

**단계별 상담.** 정보가 충분하면 묻지 않고, 부족하면 결과를 가장 크게 바꿀 것 하나만 묻습니다. 선택지는 모델이 상황에 맞춰 만든 구체적 대안 2개와 "추천해줘/이대로 진행"으로 구성되며, 모델 응답이 비면 날씨·격식 맥락에 맞는 기본 세트로 대체됩니다.

**범위가 제한된 수정.** "색만 바꿔"면 그 품목의 색만, "둘 중 하나만"이면 한 품목만 바꿉니다(`src/lib/refinement-scope.ts`). 이미지 생성에 쓴 품목별 색상·무늬·소매·종류 명세가 수정·검색 단계까지 그대로 전달되어, 생성과 검색 사이에서 속성이 유실되지 않습니다.

**상품 검증.** 검색 결과 페이지가 아닌 상세 페이지만 상품으로 인정하고, 페이지 본문에서 읽은 색상·무늬·종류가 착장 명세와 다르면 제외합니다. 룩북과 상품 사진의 시각 비교는 통과/미확인을 구분해 표시하며, 미확인 후보에 일치 표시를 붙이지 않습니다.

## 5. 이번 구현 범위와 확장 방향

이번 버전은 **사용자 요구를 반영한 착장 생성과 실제 상품 검색·검증 흐름을 완성하는 데 우선순위**를 뒀습니다. 개발 중 발견된 오류는 데이터 부족보다 품목별 색상·무늬·소매 정보가 생성과 검색 사이에서 유지되지 않는 문제였기 때문에, 먼저 이 연결 구조(공통 품목 명세)를 고쳤습니다. 자세한 진단은 [`docs/fashion-dataset-evaluation.md`](docs/fashion-dataset-evaluation.md)와 [`docs/visual-matching-fix-2026-09-28.md`](docs/visual-matching-fix-2026-09-28.md)에 있습니다.

이 에이전트의 목표 형태는 **도입 기업의 상품 카탈로그를 꽂아 쓰는 B2B 구조**입니다. 상품 검색이 실시간 웹 검색이 아니라 기업이 실제로 판매하는 상품·색상 옵션·재고에서 이루어져야 추천이 구매로 닫히기 때문입니다. 공개 패션 데이터셋은 속성 인식이나 유사도 검색 실험에는 유용하지만, 그 판매 상품·옵션·재고를 대신하지는 못합니다. 그래서 기업별 상품 데이터 연결은 후속 확장 범위로 두고, 다음 순서로 확장 방향을 검토했습니다.

- **비슷한 실제 상품을 찾기** — 기업 카탈로그(CSV/상품 DB)로 상품 이미지·속성 검색 색인을 구축합니다. 카탈로그 CSV를 임베딩 인덱스로 만들어 착장 아이템을 카탈로그 상품에 매칭하는 경로는 [`nvidia-hackathon` 브랜치](../../tree/nvidia-hackathon)에서 NVIDIA 임베딩 NIM(`nvidia/nemotron-3-embed-1b`)과 공개 데이터셋 샘플 3,000개로 프로토타입을 검증했습니다.
- **개선 효과를 확인하기** — "버건디 무지 긴팔 크루넥 니트가 맞다" 수준의 정답이 있는 평가셋을 만들어 도입 전후를 측정합니다.
- **모델이 속성을 반복해서 잘못 인식하기** — 평가에서 부족함이 확인될 때 학습 가능한 시각 인코더·재순위화 모델의 미세조정을 검토합니다. 데이터 활용이 곧 파인튜닝은 아니므로, 측정 결과에 따라 필요성을 판단합니다.

현재 룩북 이미지 생성과 이미지 속성 검사, 판매처 검색에는 OpenAI 모델을 사용합니다. 같은 브랜치에서 NVIDIA 호스팅 FLUX.1-dev로 룩북을 생성하고 Nemotron VLM으로 검증하는 경로를 확인했으며, 본선에서 자체 서빙 환경이 주어지면 이 경로로 교체해 전 단계를 NVIDIA 스택으로 옮기는 것을 확장 방향으로 검토했습니다.

## 6. 실행 방법

### 요구 사항

- Node.js 20 이상
- NVIDIA API 키 ([build.nvidia.com](https://build.nvidia.com)에서 발급, `nvapi-`로 시작)
- OpenAI API 키 (룩북 이미지·이미지 검사·판매처 검색용)
- (선택) Python 3.11 — NeMo Agent Toolkit 워크플로 실행 시

### 앱 실행

```bash
git clone https://github.com/chajm12/LALA.git
cd LALA
cp .env.example .env      # NVIDIA_API_KEY, OPENAI_API_KEY 입력
npm install
npm run dev               # http://localhost:3000
```

`.env` 주요 항목:

| 변수 | 설명 |
|---|---|
| `NVIDIA_API_KEY` | 필수. Nemotron NIM 호출 |
| `NVIDIA_BASE_URL` | 기본 `https://integrate.api.nvidia.com/v1`. 자체 NIM 컨테이너면 그 주소로 |
| `NVIDIA_TEXT_MODEL` / `NVIDIA_PLAN_MODEL` / `NVIDIA_AGENT_MODEL` / `NVIDIA_FAST_MODEL` | 역할별 모델. 기본 `nvidia/nemotron-3.5-lightning-30b-a3b` |
| `OPENAI_API_KEY` | 필수. 룩북 이미지 생성·이미지 속성 검사·판매처 검색 |
| `NAT_WORKFLOW_URL` | 선택. NAT 서버가 떠 있으면 `/api/agent` 전체 실행을 NAT 워크플로로 위임 |

### NeMo Agent Toolkit 워크플로

Next.js 앱을 띄운 상태에서:

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e nemo_agent

# 한 번 실행
nat run --config_file nemo_agent/configs/config.yml \
  --input '{"keyword":"다음주 주말 을지로 데이트, 175cm 70kg 남성"}'

# HTTP 서버 (기본 http://localhost:8000)
./scripts/run-nat.sh

# 고정 케이스로 도구 호출·결과 품질 평가 (출력: .tmp/nat/ddp_park_sajang/eval)
nat eval --config_file nemo_agent/configs/eval_config.yml
```

`nemo_agent/configs/config.yml`이 Next.js 라우트 5개(`user_intent_extractor`, `analyze_context`, `style_consultation`, `outfit_planner`, `lookbook_generator`)를 NAT 도구로 등록하고, `tool_calling_agent` 워크플로가 Nemotron으로 도구를 선택합니다. 자세한 내용은 [`nemo_agent/README.md`](nemo_agent/README.md).

### 테스트

```bash
npm test          # 수정 범위 제한, 품목 명세, 상품 검증, 복구 로직 등 단위 테스트
npm run lint
npx tsc --noEmit
```

## 7. 알려진 한계

- 호스팅 NIM 무료 엔드포인트는 혼잡 시 응답이 수십 초씩 지연되거나 503을 반환할 수 있습니다. 실패 시 확보한 결과로 이어가도록 설계했지만, 데모 중 대기 시간이 길어질 수 있습니다.
- 판매처 실시간 검색은 판매처 차단·품절·페이지 구조 변경에 따라 일부 품목이 비어 있을 수 있습니다. 사진 비교 "완료"는 색상·무늬·종류의 일치를 뜻하며 동일 SKU·소재·실착 핏까지 보증하지 않습니다.
- 후보 평가의 장소·체형·트렌드 점수는 코드 휴리스틱입니다. 별도 평가 모델을 두는 구성은 `nvidia-hackathon` 브랜치에서 검증했으며 통합은 확장 범위입니다.
- 이미지 속성 검사와 판매처 검색은 OpenAI 모델에 의존합니다(5절).

## 8. 저장소 구조

```
src/app/page.tsx               UI: 상담 → 후보 선택 → 룩북 → 수정 대화, Agent Trace
src/app/api/agent/route.ts     Agent Orchestrator (도구 실행, SSE 스트리밍, NAT 위임)
src/app/api/intent/route.ts    사용자 요구사항 구조화 (Nemotron)
src/app/api/trend/route.ts     날씨(Open-Meteo)·장소·패션 컨텍스트
src/app/api/consult/route.ts   단계별 스타일 상담 + 선택지 카드 (Nemotron)
src/app/api/plan/route.ts      후보 생성·평가·수정·재평가, 사용자 요구 계약 (Nemotron + 검증기)
src/app/api/lookbook/route.ts  룩북 이미지 생성 + 품목별 사진 검사
src/app/api/refine/route.ts    범위 제한 룩 수정 (Nemotron)
src/app/api/shopping/route.ts  판매처 검색·상세 검증·사진 비교
src/lib/verifiers.ts           weather_fit / color_harmony / diversity 코드 검증기
src/lib/plan-recovery.ts       생성·수정 실패 시 복구 흐름
src/lib/refinement-scope.ts    수정 범위 제한
src/lib/garment-specs.ts       품목별 공통 명세 (색상·무늬·소매·종류)
src/lib/shopping-*.ts          판매처 허용 목록, 페이지 증거 읽기, 사진 비교
src/lib/nvidia.ts              NVIDIA NIM 클라이언트·모델 설정
nemo_agent/                    NeMo Agent Toolkit 플러그인·설정·평가 케이스
tests/                         단위·오프라인 브라우저 테스트
docs/                          데이터셋 평가, 정합성 수정 기록
```

## 9. 팀

LALA — Korea Agentic AI Hackathon 2026 참가팀.
