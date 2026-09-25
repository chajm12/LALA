import { NextResponse } from "next/server";
import { renderLookbook } from "@/lib/pipeline/lookbook";
import { agentLog, type TraceEvent } from "@/lib/log";

export async function POST(req: Request) {
  const trace: TraceEvent[] = [];
  try {
    const { concept } = await req.json();
    const result = await renderLookbook(concept, trace);
    return NextResponse.json({ ...result, trace });
  } catch (e) {
    const message = e instanceof Error ? e.message : "룩북 생성 중 알 수 없는 오류";
    agentLog("lookbook", `✗ 요청 실패: ${message}`, undefined, trace);
    return NextResponse.json({ error: message, trace }, { status: 500 });
  }
}
