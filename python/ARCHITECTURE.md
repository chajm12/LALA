# ConceptToon — 설계 문서

> AGENT:24 / Creative Agent 트랙 / 빌드 윈도우 8.01 14:00 – 8.02 08:00

---

## 0. 한 줄 정의

**어려운 개념과 대상 학년을 한 번 입력하면, 학습자의 오개념을 짚어내고 정지 화면으로 표현 가능한 비유를 골라 4컷 학습만화로 만들어내는 에이전트.**

발표에서 반복할 문장:
> "우리는 예쁜 그림을 만드는 게 아니라, **설명 전략을 스스로 설계하고 검증하는** 에이전트를 만들었습니다."

---

## 1. 사전 검증으로 확정된 사실 (재논의 금지)

| 항목 | 확정값 | 근거 |
|---|---|---|
| 생성 방식 | 2×2 한 장 | 캐릭터 일관성 36/36 통과 |
| 이미지 모델 | `gpt-image-2` | |
| 크기 / 품질 | `1536x1024` / `low` | 가장 빠르면서 컷 면적 최대 |
| 컷당 소요 | 평균 23초, 최악 30초 | 예산 90초 대비 여유 60초 |
| 말풍선 | 이미지 모델이 직접 렌더 | 한글 8/9 완벽 |
| 판정 모델 | `gpt-5.2` (비전) | A/B 판정 사람과 100% 일치 |
| 동시 요청 | 최대 4 | 20장 동시 실패 이력 |

### 프롬프트 규칙 (A/B로 입증됨: P2 성공률 0% → 100%)

1. **물리적 자세를 명시** — `spinning` ✗ / `standing upright on its edge` ✓
2. **보이면 안 되는 것도 명시** — `no readable design`
3. **움직임은 정지 화면의 흔적으로 번역** — 흐림, 잔상, 파문
4. **애초에 움직임에 의존하는 비유를 고르지 말 것** ← 스토리보드 단계에서 차단

---

## 2. 아키텍처

```
사용자 입력 1회
   "중학생에게 양자역학을 만화로 설명해줘"
        │
        ▼
┌─────────────────────────────────────────┐
│ PHASE 1 · 텍스트 (빠름 · 반복 가능)      │
│                                          │
│  analyze_concept                         │
│      └ 핵심 개념 3~5개 + 난이도 판정      │
│  find_misconception                      │
│      └ 대표 오개념 1~2개                 │
│  check_visual_feasibility  ←── 규칙 4     │
│      └ 비유가 정지 화면에 담기는가        │
│  draft_storyboard                        │
│      └ 캐릭터 + 4컷 장면/대사 JSON        │
│  check_coverage                          │
│      └ 대사만으로 핵심 개념 답할 수 있는가 │
│                                          │
│  ↺ 실패 시 draft_storyboard 로 복귀       │
│     (최대 3회, 회당 1~3초)                │
└─────────────────────────────────────────┘
        │ 통과
        ▼
┌─────────────────────────────────────────┐
│ PHASE 2 · 이미지 (느림 · 1~2회)          │
│                                          │
│  render_comic   ── 2장 병렬 (best-of-2)   │
│  verify_panels  ── 비전 판정, 나은 쪽 선택 │
│                                          │
│  ↺ 둘 다 실패 시 1회만 재생성 (하드 상한)  │
└─────────────────────────────────────────┘
        │
        ▼
   만화 + 확인 문제 + 커버리지 리포트
```

**설계 근거 (Pipeline Architecture 25% 대응):**
검증을 이미지 **앞**에 두었습니다. 이미지 재생성은 회당 25초, 텍스트 재작성은 회당 2초입니다.
잘못된 스토리보드로 그림을 그린 뒤 고치면 예산이 무너집니다. 발표에서 이 문장을 그대로 쓰십시오.

---

## 3. 툴 스키마

```python
from pydantic import BaseModel, Field

# ── 1
class ConceptAnalysis(BaseModel):
    key_points: list[str] = Field(description="반드시 전달할 핵심 개념 3~5개")
    difficulty: str        # "easy" | "medium" | "hard"
    prerequisites: list[str]

# ── 2
class Misconception(BaseModel):
    wrong_belief: str      # 학습자가 흔히 갖는 틀린 생각
    why_wrong: str
    correction: str

# ── 3  (규칙 4 강제)
class VisualFeasibility(BaseModel):
    analogy: str
    is_static: bool        # 정지 화면 한 장에 담기는가
    reason: str
    alternative: str | None  # is_static=False 일 때 대체 비유

# ── 4
class Panel(BaseModel):
    scene: str             # 영어, 물리적 자세 명시 (규칙 1~3)
    line: str              # 한국어 대사, 25자 이하

class Storyboard(BaseModel):
    character: str         # 4컷 전체 동일 외형 명세
    analogy: str
    panels: list[Panel]    # 정확히 4개

# ── 5
class CoverageResult(BaseModel):
    covered: list[str]
    missing: list[str]
    passed: bool           # missing 이 비어 있으면 True

# ── 7
class PanelVerdict(BaseModel):
    panel: int
    passed: bool
    reason: str
```

### 도구 목록

| # | 도구 | 입력 | 출력 | 소요 |
|---|---|---|---|---|
| 1 | `analyze_concept` | 개념, 학년 | ConceptAnalysis | ~3s |
| 2 | `find_misconception` | 개념, 학년 | Misconception | ~3s |
| 3 | `check_visual_feasibility` | 비유 후보 | VisualFeasibility | ~2s |
| 4 | `draft_storyboard` | 위 전부 | Storyboard | ~5s |
| 5 | `check_coverage` | key_points, 대사 4개 | CoverageResult | ~2s |
| 6 | `render_comic` | Storyboard | 이미지 2장 (병렬) | ~25s |
| 7 | `verify_panels` | 이미지, 기준 | list[PanelVerdict] | ~5s |
| 8 | `make_quiz` | key_points | 확인 문제 2개 | ~3s |

**최악 시나리오 총합**: 3+3+2+(5+2)×3+25+5+3 = **약 62초** → 90초 예산 내

---

## 4. 프롬프트 템플릿 (고정부는 하드코딩)

```python
TEMPLATE = """A four-panel educational comic in a 2x2 grid.
No panel borders, no gutters, no gaps between panels.

The SAME character appears in all four panels: {character}
Keep the character's face, hair, and clothing identical in every panel.

Panel 1 (top-left): {p1_scene}
Speech bubble text in Korean: "{p1_line}"
... (P2~P4 동일)

Flat vector children's book illustration style, clean solid backgrounds.
Each speech bubble sits in the upper part of its own panel.
No text anywhere except inside the four speech bubbles.
No posters, no signs, no writing on walls, boards, or books."""
```

에이전트는 `{}` 안만 채웁니다. **레이아웃·스타일·텍스트 통제는 절대 에이전트에게 넘기지 마십시오.**

### `draft_storyboard` 시스템 프롬프트에 반드시 포함

```
장면 서술 규칙 (영어로 작성):
- 물체의 물리적 자세와 위치를 명시할 것
- 보이면 안 되는 것도 명시할 것 (no readable text, no design)
- 움직임은 흐림·잔상·파문 등 정지 화면의 흔적으로 번역할 것
- 추상 개념어 금지 (energy, flow, interaction)

나쁜 예: "a spinning coin on the desk"
좋은 예: "a coin standing upright on its edge, its surface a blurred
         smear with no readable design, concentric ripples beneath"

비유 선택 규칙:
- 한 장의 정지 사진으로 찍을 수 있는 비유만 사용
- 움직임/변화/시간 경과 의존 비유 금지
  (도는 동전, 흐르는 물, 진동하는 줄, 자라는 식물)
- 대신 정적 대비 사용 (닫힘/열림, 가림/드러남, 있음/없음)

대사 규칙:
- 각 25자 이하
- P1은 반드시 오개념을 말할 것
- P4는 반드시 핵심을 정리할 것
```

---

## 5. Raw API Stream 화면

```
┌───────────────────────────┬──────────────────────────────┐
│ 입력 & 결과                │ Raw API Stream               │
│                            │                              │
│ "중학생에게 양자역학을      │ agent_started  ComicTutor    │
│  만화로 설명해줘"           │ tool_called    analyze_...   │
│                            │ tool_output    {3 points}    │
│ [단계 표시]                 │ tool_called    find_misco... │
│  ✓ 개념 분석                │ tool_output    {...}         │
│  ✓ 오개념 탐색              │ tool_called    check_visual  │
│  ✓ 비유 검증 (1회 반려)     │ tool_output    is_static:F ✗ │
│  ✓ 스토리보드               │ tool_called    check_visual  │
│  ⟳ 이미지 생성...           │ tool_output    is_static:T ✓ │
│                            │ tool_called    draft_story...│
│ [스토리보드 텍스트 먼저]     │ tool_called    check_cover...│
│ [완성 만화 교체]            │ tool_output    missing:[] ✓  │
│                            │ tool_called    render_comic  │
│                            │ tool_called    verify_panels │
└───────────────────────────┴──────────────────────────────┘
```

```python
async for event in result.stream_events():
    if event.type != "run_item_stream_event":
        continue
    if event.name == "tool_called":
        raw = event.item.raw_item
        emit("tool_call", getattr(raw, "name", "?"), getattr(raw, "arguments", ""))
    elif event.name == "tool_output":
        emit("tool_result", str(event.item.output)[:300])
```

**연출 포인트**: `check_visual_feasibility`가 한 번 반려하고 다시 통과하는 장면이
심사위원에게 "판단하는 에이전트"를 증명합니다. 데모용 개념은
**첫 비유가 반려될 만한 것**을 골라두십시오.

---

## 6. 폴더 구조

```
conceptoon/
├── .gitignore          ← git init 직후, 첫 커밋 전
├── .env.example        ← 키는 절대 커밋 금지
├── README.md
├── agent/
│   ├── main.py         # Agent 정의, Runner
│   ├── tools.py        # 도구 8개
│   ├── schemas.py      # Pydantic 모델
│   ├── prompts.py      # TEMPLATE + 시스템 프롬프트
│   └── stream.py       # 이벤트 → 프런트 브릿지
├── web/
│   ├── index.html      # 좌: 결과 / 우: Raw Stream
│   └── app.js
├── server.py           # FastAPI + WebSocket
└── tests/
    └── concepts.txt    # 리허설용 개념 20개
```

---

## 7. 18시간 일정

| 시각 | 작업 | 완료 기준 |
|---|---|---|
| **14:00–15:00** | 스캐폴딩 + **최소 경로 관통** | 하드코딩 스토리보드로 입력→이미지→출력이 끝까지 돈다 |
| 15:00–17:00 | 도구 1·2·4 구현 | 임의 개념으로 스토리보드 JSON이 나온다 |
| 17:00–18:30 | 도구 3·5 + 검증 루프 | 반려→재작성이 실제로 발생한다 |
| **18:30** | 저녁 | |
| 19:00–21:00 | Raw Stream UI | 두 화면이 실시간으로 갱신된다 |
| **21:00** | 중간 체크인 | |
| 21:00–23:00 | 통합 · 첫 E2E | 입력 1회로 만화가 나온다 |
| 23:00–01:00 | 개념 10개 리허설 · 프롬프트 튜닝 | 8/10 이상 만족스러운 결과 |
| **00:00** | 야식 | |
| 01:00–03:00 | best-of-2 · 폴백 · 타임아웃 · 에러 처리 | 어떤 입력에도 뭔가는 나온다 |
| 03:00–05:00 | 리허설 반복 · 버그 수정 | 연속 5회 무사고 |
| 05:00–06:30 | 슬라이드 5장 + 데모 대본 | 7분 리허설 완료 |
| 06:30–07:30 | **2분 데모 영상 녹화 + 업로드** | YouTube 링크 확보 |
| **07:30** | 아침 | |
| 07:30–08:00 | 제출 · 예비 시간 | |
| **08:00** | 제출 마감 (영상 + PDF) | |
| 08:30 | Peer Review 50분 | |
| 10:30 | 파이널 (진출 시) 7분 | |

### 절대 규칙

- **15:00까지 최소 경로가 안 돌면 기능을 줄여라.** 기능을 다 만들고 마지막에 연결하는 팀이 매년 실패합니다.
- **03:00 이후 새 기능 금지.** 그 시점부터는 안정화와 발표 준비만.
- **06:30에는 무조건 녹화 시작.** 영상 미제출은 예선 탈락입니다.

### 역할 분담 (개발자만 있는 팀 기준)

| 담당 | 범위 |
|---|---|
| A | 에이전트 코어 + 도구 1·2·4 |
| B | 프런트엔드 (Raw Stream + 만화 표시) + server.py |
| C | 도구 3·5·6·7 + 프롬프트 튜닝 + 리허설 |
| D | 통합, 발표 자료, 영상, 제출 (없으면 C가 겸임) |

**API 사용 규칙**: 레이트 리밋이 org 단위로 공유됩니다.
리허설·녹화·발표 시간대에는 **한 명만** API를 씁니다.

---

## 8. 발표 (2 + 3 + 2)

### 슬라이드 5장

1. 문제 — 어려운 개념 설명은 학습자의 오개념을 건드리지 않는다
2. 사용자 — 중·고등학생에게 STEM을 설명해야 하는 교사
3. 해법 — 개념 분석 → 오개념 탐색 → 비유 검증 → 만화
4. **차별점 — 우리는 그리기 전에 검증한다** (검증 루프 다이어그램 1장)
5. 지금부터 라이브

### 라이브 데모 3분 대본

```
0:00  입력 한 줄 타이핑, 엔터
0:05  "지금부터 사람은 손을 대지 않습니다"
0:10  우측 Raw Stream 가리키며 도구 호출 실황 설명
0:35  check_visual_feasibility 반려 장면 → "에이전트가 비유를 거절했습니다"
0:50  스토리보드 텍스트가 먼저 뜸 → 커버리지 통과
1:10  이미지 생성 시작 (25초)
1:40  완성 만화 표시
2:00  확인 문제 + 커버리지 리포트
2:20  "여기까지 사람 입력은 처음 한 줄이 전부입니다"
```

### Surprise Task 2분 전략

- **입력받자마자 바로 실행.** 설명은 돌아가는 동안 한다.
- **텍스트 스토리보드가 먼저 뜨는 것이 방어선.** 이미지가 늦어도 "설계는 이미 끝났습니다"라고 말할 수 있다.
- **폴백은 자동이 아니라 수동 버튼.** 심사 항목이 "압박 속에서 에이전트를 조종하는 팀의 순간 대응력"이므로, 팀이 능동적으로 전환하는 모습이 더 높은 점수를 받는다.
- 결과가 어색하면 **변명하지 말고 한계를 지목하라.** "이 비유는 정지 화면 표현이 어려운 사례입니다" — 한계를 아는 팀이 모르는 팀보다 낫다.

---

## 9. 실패 대비

| 실패 | 대비책 |
|---|---|
| 이미지 API 지연/실패 | 텍스트 스토리보드 우선 표시 + 수동 폴백 버튼 |
| 429 레이트 리밋 | 동시 4 제한, 지수 백오프 재시도, 발표 중 타 팀원 API 사용 금지 |
| 검증 루프 무한 반복 | 재시도 하드 상한 (텍스트 3회, 이미지 1회) + 전체 90초 타임아웃 |
| 낯선 분야 개념 | 커버리지 미달 시 "이 부분은 다루지 못했습니다"를 리포트에 명시 |
| 네트워크 장애 | 직전 성공 결과를 캐시해두고 최악의 경우 그것으로 설명 |
| 발표 PC 문제 | 노트북 2대에 동일 환경 세팅 |

---

## 10. 심사 루브릭 대응

| 항목 | 배점 | 우리의 근거 |
|---|---|---|
| Pipeline Architecture | 25% | 검증을 이미지 앞에 배치한 이유를 초 단위 비용으로 설명 |
| Real-time Adaptability | 25% | 텍스트 우선 출력 + 수동 폴백 + 한계 지목 |
| Prompt Quality | 20% | **A/B 실험 데이터 (P2 성공률 0% → 100%)** 제시 |
| Impact / Idea | 20% | 오개념 교정이라는 교육적 목표, 타깃 명확 |
| Presentation Clarity | 10% | 입력 한 줄 → 결과가 직관적 |

**Prompt Quality에서 A/B 데이터를 제시하는 팀은 거의 없을 것입니다.**
감으로 프롬프트를 쓴 팀과 측정해서 쓴 팀의 차이가 여기서 갈립니다. 슬라이드나 Q&A에서 반드시 꺼내십시오.
