export type AgentKitToolName = "agent" | "intent" | "trend" | "plan" | "lookbook" | "shopping" | "consult";

export type AgentKitTool = {
  name: AgentKitToolName;
  label: string;
  endpoint: string;
  description: string;
};

export type AgentKitTraceStep = {
  key: string;
  title: string;
  detail: string;
  tool?: AgentKitToolName;
};

export const AGENTKIT_TOOLS: Record<AgentKitToolName, AgentKitTool> = {
  agent: {
    name: "agent",
    label: "Agent Orchestrator",
    endpoint: "/api/agent",
    description: "기본 UI가 모든 핵심 요청을 통과시키는 NVIDIA Agent Orchestrator입니다. NAT Workflow 연결 시 전체 그래프를 NeMo Agent Toolkit으로 실행합니다.",
  },
  intent: {
    name: "intent",
    label: "NVIDIA User Intent Agent",
    endpoint: "/api/intent",
    description: "사용자 입력에서 명시적 요구, 피해야 할 요소, 스타일 방향, 추가 질문이 필요한 정보를 구조화합니다.",
  },
  trend: {
    name: "trend",
    label: "NVIDIA + Open-Meteo + Fashion Web Search",
    endpoint: "/api/trend",
    description: "NVIDIA NIM, Open-Meteo, 실시간 패션 웹 리서치가 날짜·장소·트렌드 컨텍스트를 함께 분석합니다.",
  },
  plan: {
    name: "plan",
    label: "NVIDIA Styling Planner",
    endpoint: "/api/plan",
    description: "NVIDIA NIM이 후보 생성·평가·수정을 수행하고 코드 기반 Verifier와 함께 최종 2안을 선정합니다.",
  },
  lookbook: {
    name: "lookbook",
    label: "Image Generation + NVIDIA Vision",
    endpoint: "/api/lookbook",
    description: "이미지는 기존 생성 API로 만들고 NVIDIA 멀티모달 NIM으로 스펙 정합성을 검증합니다.",
  },
  shopping: {
    name: "shopping",
    label: "Shopping Link Tool",
    endpoint: "/api/shopping",
    description: "사용자가 요청한 룩의 유사 상품 링크를 검색하고 유효성을 검증합니다.",
  },
  consult: {
    name: "consult",
    label: "NVIDIA Style Consultation",
    endpoint: "/api/consult",
    description: "사용자의 피드백을 반영해 장소 무드·핏·소재 방향을 단계별 자연어 상담으로 조정합니다.",
  },
};

export const AGENTKIT_TRACE_STEPS: AgentKitTraceStep[] = [
  {
    key: "agent",
    title: "Agent Orchestrator",
    detail: "Agent Orchestrator가 중복 라우팅 호출 없이 최적화된 Tool 실행 그래프를 시작합니다.",
    tool: "agent",
  },
  {
    key: "trend",
    title: "입력 해석",
    detail: "로컬 입력 파서가 날짜·장소 힌트를 먼저 분리하고 빠른 NIM과 패션 리서치 Tool이 스타일 컨텍스트를 보완합니다.",
    tool: "trend",
  },
  {
    key: "intent",
    title: "사용자 요구사항 해석",
    detail: "사용자 원문에서 반드시 지킬 요구, 피할 요소, 무드·핏·소재 방향과 부족한 정보를 구조화합니다.",
    tool: "intent",
  },
  {
    key: "weather",
    title: "날씨·계절 판단",
    detail: "Open-Meteo와 실시간 패션 레퍼런스 조회를 병렬 호출해 예보·계절감·현재 실루엣 방향을 확인합니다.",
    tool: "trend",
  },
  {
    key: "concept",
    title: "후보 생성",
    detail: "NVIDIA NIM이 무드, 색감, 핏, 원단/질감을 다르게 둔 5개 후보를 만듭니다.",
    tool: "plan",
  },
  {
    key: "evaluate",
    title: "평가·수정",
    detail: "1차 평가 결과를 바탕으로 repair Tool이 후보를 수정합니다.",
    tool: "plan",
  },
  {
    key: "weather_fit",
    title: "weather_fit 검증",
    detail: "Open-Meteo의 기온·강수·바람과 착장 보온·방수 요소를 코드로 비교합니다.",
    tool: "plan",
  },
  {
    key: "color_harmony",
    title: "color_harmony 검증",
    detail: "색상군 수와 중성색·포인트색 균형을 코드로 계산합니다.",
    tool: "plan",
  },
  {
    key: "diversity",
    title: "diversity 검증",
    detail: "후보 간 아이템·색감·무드 유사도를 계산해 선택 폭을 확인합니다.",
    tool: "plan",
  },
  {
    key: "occasion_fit",
    title: "occasion_fit 검증",
    detail: "로컬 휴리스틱이 장소·약속 종류의 포멀리티와 후보 무드를 즉시 비교합니다.",
    tool: "plan",
  },
  {
    key: "variants",
    title: "룩북 생성",
    detail: "최종 2안 이미지를 먼저 만들고 상품 링크는 버튼으로 호출합니다.",
    tool: "lookbook",
  },
];
