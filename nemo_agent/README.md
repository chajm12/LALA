# DDP PARK SAJANG · NeMo Agent Toolkit Workflow

이 디렉터리는 기존 Next.js API를 NeMo Agent Toolkit의 실제 Tool로 등록한 대회용 Python Workflow입니다. UI와 기존 API의 디자인·응답 흐름은 건드리지 않고, NAT가 다음 API를 공유 스타일 상태로 연결합니다.

| NAT Tool | Next.js route | 역할 |
| --- | --- | --- |
| `user_intent_extractor` | `/api/intent` | 명시적 요구·회피 요소·무드·핏·소재·부족 정보 추출 |
| `analyze_context` | `/api/trend` | 날짜·장소·날씨·계절감·트렌드 분석 |
| `style_consultation` | `/api/consult` | 사용자 피드백을 반영한 단계별 상담 |
| `outfit_planner` | `/api/plan` | 5개 후보 생성 및 평가·수정·재평가 |
| `lookbook_generator` | `/api/lookbook` | 선택 룩 이미지 생성 및 검증 |

## 실행

1. 먼저 Next.js 앱을 실행합니다.

```bash
npm run dev
```

2. 별도 Python 환경에서 NAT 플러그인을 설치합니다. Python 3.11과 `nvidia-nat[langchain]==1.8.*`를 사용합니다.

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e nemo_agent
```

3. `.env` 또는 셸 환경에 `NVIDIA_API_KEY`를 설정합니다. 앱이 다른 주소에서 실행 중이면 `DDP_APP_URL`도 설정합니다.

4. Tool-calling Workflow를 실행합니다.

```bash
nat run --config_file nemo_agent/configs/config.yml \
  --input '{"keyword":"다음주 주말 을지로 데이트, 175cm 70kg 남성"}'
```

HTTP Workflow 서버가 필요하면 저장소 루트에서 다음처럼 실행할 수 있습니다.

```bash
./scripts/run-nat.sh
```

`nat serve`의 기본 주소는 `http://localhost:8000`이며, Next.js 앱이 다른 주소에서 실행 중이면 `DDP_APP_URL`을 지정합니다. 공식 NAT 서버는 `/generate` 또는 버전에 따라 `/v1/workflow`를 제공합니다.

## 재현 가능한 평가

고정된 두 개의 패션 요청으로 Tool 호출과 결과 품질을 반복 확인할 수 있습니다.

```bash
nat eval --config_file nemo_agent/configs/eval_config.yml
```

평가 입력은 `nemo_agent/eval/style_cases.json`에 있으며, 출력은 `.tmp/nat/ddp_park_sajang/eval`에 저장됩니다.

## 대회용 역할 분리

- Nemotron NIM: 사용자 요구 해석, 컨텍스트 판단, 후보 계획, 평가·수정·Vision 검증
- NeMo Agent Toolkit: Tool-calling Workflow, NAT serve/run/eval, 실행 trace
- Next.js API Tools: 날씨, 장소·트렌드, 상담, 후보 계획, 룩북 생성
- Open-Meteo/OpenAI: 각각 날씨 사실 조회와 현재 이미지·웹 리서치 보조

이미지 생성과 웹 리서치에 사용하는 외부 API는 핵심 의사결정 모델과 분리된 보조 Tool로 발표 자료에 명시합니다.

NAT가 제공하는 실행 서버의 포트와 API 형식은 설치한 `nvidia-nat` 버전에 따라 `nat --help`와 `nat serve --help`로 확인합니다.
