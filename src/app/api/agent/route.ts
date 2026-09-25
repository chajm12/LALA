import { runAgent, type AgentEvent, type ChatTurn } from "@/lib/agent/run";
import type { AgentState } from "@/lib/agent/state";

export const maxDuration = 600;

/**
 * 에이전트 엔드포인트 — NDJSON 스트리밍.
 * body: { messages: ChatTurn[], state?: AgentState | null }
 * 각 줄: AgentEvent (trace | state | assistant | question | done | error)
 */
export async function POST(req: Request) {
  const { messages, state } = (await req.json()) as { messages: ChatTurn[]; state?: AgentState | null };
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runAgent(messages ?? [], state ?? null, emit);
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}
