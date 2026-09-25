import { NextResponse } from "next/server";
import { runStylingLoop } from "@/lib/pipeline/loop";
import { agentLog, type TraceEvent } from "@/lib/log";
import type { ParsedRequest } from "@/lib/styling";

export async function POST(req: Request) {
  const trace: TraceEvent[] = [];
  try {
    const { keyword, trend, parsed = null } = (await req.json()) as { keyword: string; trend: string; parsed?: ParsedRequest | null };
    const result = await runStylingLoop(keyword, trend, parsed, trace);
    return NextResponse.json({ ...result, trace });
  } catch (e) {
    const message = e instanceof Error ? e.message : "스타일링 계획 중 알 수 없는 오류";
    agentLog("evaluate", `✗ 요청 실패: ${message}`, undefined, trace);
    return NextResponse.json({ error: message, trace }, { status: 500 });
  }
}
