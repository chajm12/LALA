export type AgentKitToolName = "trend" | "plan" | "lookbook" | "shopping";

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
  trend: {
    name: "trend",
    label: "Trend Context Tool",
    endpoint: "/api/trend",
    description: "입력 해석, 날짜·장소·날씨·계절감, 트렌드 단서를 분석합니다.",
  },
  plan: {
    name: "plan",
    label: "Styling Plan Tool",
    endpoint: "/api/plan",
    description: "후보 5개 생성, 1차 평가, 수정, 재평가, 최종 2안 선정을 수행합니다.",
  },
  lookbook: {
    name: "lookbook",
    label: "Lookbook Generation Tool",
    endpoint: "/api/lookbook",
    description: "최종 룩북 이미지를 생성하고 Vision 검증을 수행합니다.",
  },
  shopping: {
    name: "shopping",
    label: "Shopping Link Tool",
    endpoint: "/api/shopping",
    description: "사용자가 요청한 룩의 유사 상품 링크를 검색하고 유효성을 검증합니다.",
  },
};

export const AGENTKIT_TRACE_STEPS: AgentKitTraceStep[] = [
  {
    key: "trend",
    title: "입력 해석",
    detail: "날짜, 장소, 성별, 키·몸무게, 상황 단서를 분리합니다.",
    tool: "trend",
  },
  {
    key: "weather",
    title: "날씨·계절 판단",
    detail: "날짜와 장소가 있으면 예보/계절감과 지역 기후를 함께 봅니다.",
    tool: "trend",
  },
  {
    key: "concept",
    title: "후보 생성",
    detail: "무드, 색감, 핏, 원단/질감을 다르게 둔 5개 후보를 만듭니다.",
    tool: "plan",
  },
  {
    key: "evaluate",
    title: "평가·수정",
    detail: "날씨, 장소, 체형/핏, 트렌드, 실용성 기준으로 재평가합니다.",
    tool: "plan",
  },
  {
    key: "variants",
    title: "룩북 생성",
    detail: "최종 2안 이미지를 먼저 만들고 상품 링크는 버튼으로 호출합니다.",
    tool: "lookbook",
  },
];
