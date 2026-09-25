import { NextResponse } from "next/server";
import { analyzeTrend } from "@/lib/pipeline/trend";
import { agentLog, type TraceEvent } from "@/lib/log";

export async function POST(req: Request) {
  const trace: TraceEvent[] = [];
  try {
    const { keyword } = await req.json();
    const result = await analyzeTrend(keyword, trace);
    return NextResponse.json({ ...result, trace });
  } catch (e) {
    const message = e instanceof Error ? e.message : "트렌드 조사 중 알 수 없는 오류";
    agentLog("trend", `✗ 요청 실패: ${message}`, undefined, trace);
    return NextResponse.json({ error: message, trace }, { status: 500 });
  }
}
