import { NextResponse } from "next/server";
import { AGENTKIT_TOOLS, AGENTKIT_TRACE_STEPS } from "@/lib/agentkit";

export async function GET() {
  return NextResponse.json({
    name: "DDP PARK SAJANG AgentKit",
    description: "기존 API 라우트를 AgentKit tool orchestration 형태로 묶은 퍼스널 스타일링 에이전트",
    tools: Object.values(AGENTKIT_TOOLS),
    traceSteps: AGENTKIT_TRACE_STEPS,
  });
}
