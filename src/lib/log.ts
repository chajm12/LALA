const COLORS = {
  trend: "\x1b[36m",
  weather: "\x1b[96m",
  concept: "\x1b[35m",
  evaluate: "\x1b[34m",
  lookbook: "\x1b[33m",
  shopping: "\x1b[32m",
  catalog: "\x1b[92m",
  agent: "\x1b[95m",
} as const;
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export type Scope = keyof typeof COLORS;

export type TraceEvent = { t: number; scope: Scope; message: string; tool?: string };

/**
 * 서버 콘솔 로그 + (선택) 요청 단위 trace 배열에 누적.
 * trace 를 API 응답에 실어 보내면 프론트 Agent Trace 패널이 실제 실행 흐름을 보여줄 수 있다.
 */
export function agentLog(scope: Scope, message: string, tool?: string, trace?: TraceEvent[]) {
  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  const color = COLORS[scope];
  const toolTag = tool ? ` ${DIM}[${tool}]${RESET}` : "";
  console.log(`${DIM}[${time}]${RESET} ${color}[${scope.toUpperCase()}]${RESET} ${message}${toolTag}`);
  trace?.push({ t: Date.now(), scope, message, tool });
}
