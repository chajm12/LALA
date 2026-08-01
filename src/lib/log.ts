const COLORS = {
  trend: "\x1b[36m", // cyan
  concept: "\x1b[35m", // magenta
  lookbook: "\x1b[33m", // yellow
  cost: "\x1b[32m", // green
} as const;
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

type Scope = keyof typeof COLORS;

export function agentLog(scope: Scope, message: string) {
  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  const color = COLORS[scope];
  console.log(`${DIM}[${time}]${RESET} ${color}[${scope.toUpperCase()}]${RESET} ${message}`);
}
