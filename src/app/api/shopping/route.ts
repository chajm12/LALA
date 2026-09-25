import { NextResponse } from "next/server";
import { matchProducts } from "@/lib/pipeline/shopping";
import { agentLog, type TraceEvent } from "@/lib/log";

export async function POST(req: Request) {
  const trace: TraceEvent[] = [];
  try {
    const { keyword, concept } = await req.json();
    const links = await matchProducts(keyword, concept ?? {}, trace);
    return NextResponse.json({ links, trace });
  } catch (e) {
    const message = e instanceof Error ? e.message : "상품 매칭 중 알 수 없는 오류";
    agentLog("shopping", `✗ 요청 실패: ${message}`, undefined, trace);
    return NextResponse.json({ error: message, links: [], trace }, { status: 500 });
  }
}
