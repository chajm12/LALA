const COLORS = {
  trend: "\x1b[36m", // cyan
  concept: "\x1b[35m", // magenta
  lookbook: "\x1b[33m", // yellow
  cost: "\x1b[32m", // green
} as const;
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

type Scope = keyof typeof COLORS;

/**
 * tool: what's actually being called for this log line, e.g.
 * "responses.create + web_search_preview · gpt-4o" or
 * "images.generate · gpt-image-1" - shown dimmed so the log doubles
 * as a trace of which OpenAI API/tool/model fired at each step.
 */
export function agentLog(scope: Scope, message: string, tool?: string) {
  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  const color = COLORS[scope];
  const toolTag = tool ? ` ${DIM}[${tool}]${RESET}` : "";
  console.log(`${DIM}[${time}]${RESET} ${color}[${scope.toUpperCase()}]${RESET} ${message}${toolTag}`);
}
