"use client";

import { useEffect, useRef, useState } from "react";
import LoadingScreen, { type LoadingPhase } from "@/components/LoadingScreen";

type Concept = {
  name: string;
  description: string;
  mood: string;
  colorPalette: string[];
  targetCustomer: string;
  materials: string[];
  id?: string;
  outfitItems?: string[];
  bodyProfile?: string;
  fitStrategy?: string;
  stylingReason?: string;
};

type Evaluation = {
  id: string;
  name: string;
  weatherScore: number;
  placeScore: number;
  bodyFitScore: number;
  trendScore: number;
  practicalityScore: number;
  totalScore: number;
  failureReasons: string[];
  revisionPlan: string[];
  rank?: number;
  decisionStatus?: "선택" | "탈락";
  decisionReason?: string;
};

type RoundSummary = { round: number; minScore: number; passed: boolean; repairSummary: string[] };

type EvaluationProcess = {
  originalCandidates: Concept[];
  round1: Evaluation[];
  repairSummary: string[];
  repairedCandidates: Concept[];
  round2: Evaluation[];
  finalConcepts: Concept[];
  iterations: number;
  passScore: number;
  rounds: RoundSummary[];
};

type TraceEvent = { t: number; scope: string; message: string; tool?: string };

type ChatTurn = { role: "user" | "assistant"; content: string; kind?: "question" };

/** 서버 에이전트 상태의 룩 항목 (이미지는 "(client)" 로 대체돼 오므로 클라이언트가 보관) */
type ServerLook = {
  concept: Concept;
  lookbook?: { imageUrl: string | null; verified: boolean; mismatches: string[]; retried: boolean; error: string | null };
  links?: ShoppingLink[];
  lastScore?: number;
};

type ShoppingLink = {
  category?: string;
  item: string;
  title: string;
  url: string;
  source: string;
  reason: string;
};

type Variant = {
  concept: Concept;
  contradictionIssue: string | null;
  imageUrl: string | null;
  lookbookVerified: boolean;
  lookbookMismatches: string[];
  lookbookRetried: boolean;
  lookbookError: string | null;
  finalMaterials: string[] | null;
  shoppingLinks: ShoppingLink[];
  shoppingError: string | null;
};

type Step = "idle" | "trend" | "concept" | "variants" | "done";

type SearchHistoryItem = {
  id: string;
  keyword: string;
  createdAt: string;
  elapsedMs: number;
  trend: string | null;
  variants: Variant[];
  evaluationProcess: EvaluationProcess | null;
};

const stepLabels: Record<Step, string> = {
  idle: "생성",
  trend: "트렌드 조사 중...",
  concept: "후보 생성·평가 중...",
  variants: "룩북 생성 중...",
  done: "완료",
};

const AGENT_TRACE_STEPS = [
  { key: "trend", title: "입력 해석", detail: "날짜, 장소, 성별, 키·몸무게, 상황 단서를 분리합니다." },
  { key: "weather", title: "날씨·계절 판단", detail: "날짜와 장소가 있으면 예보/계절감과 지역 기후를 함께 봅니다." },
  { key: "concept", title: "후보 생성", detail: "무드, 색감, 핏, 원단/질감을 다르게 둔 5개 후보를 만듭니다." },
  { key: "evaluate", title: "평가·수정", detail: "날씨, 장소, 체형/핏, 트렌드, 실용성 기준으로 재평가합니다." },
  { key: "variants", title: "룩북 생성", detail: "최종 2안 이미지를 먼저 만들고 상품 링크는 이후에 붙입니다." },
] as const;

function formatElapsed(ms: number | null) {
  if (ms === null) return "0.0초";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}분 ${rest}초`;
}

function getTimestamp() {
  return Date.now();
}

function asConceptArray(value: unknown): Concept[] {
  return Array.isArray(value) ? (value as Concept[]) : [];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value];
  }
  return [];
}

function asScore(value: unknown): number {
  const score = typeof value === "number" ? value : Number(value);
  return Number.isFinite(score) ? score : 0;
}

function normalizeEvaluation(value: unknown): Evaluation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  return {
    id: String(item.id ?? item.name ?? crypto.randomUUID()),
    name: String(item.name ?? item.id ?? "이름 없는 후보"),
    weatherScore: asScore(item.weatherScore),
    placeScore: asScore(item.placeScore),
    bodyFitScore: asScore(item.bodyFitScore),
    trendScore: asScore(item.trendScore),
    practicalityScore: asScore(item.practicalityScore),
    totalScore: asScore(item.totalScore),
    failureReasons: asStringArray(item.failureReasons),
    revisionPlan: asStringArray(item.revisionPlan),
    rank: item.rank === undefined ? undefined : asScore(item.rank),
    decisionStatus: item.decisionStatus === "선택" ? "선택" : item.decisionStatus === "탈락" ? "탈락" : undefined,
    decisionReason: typeof item.decisionReason === "string" ? item.decisionReason : undefined,
  };
}

function asEvaluationArray(value: unknown): Evaluation[] {
  return Array.isArray(value)
    ? value.map(normalizeEvaluation).filter((item): item is Evaluation => item !== null)
    : [];
}

function normalizeEvaluationProcess(value: Record<string, unknown>): EvaluationProcess {
  return {
    originalCandidates: asConceptArray(value.originalCandidates),
    round1: asEvaluationArray(value.round1),
    repairSummary: Array.isArray(value.repairSummary) ? (value.repairSummary as string[]) : [],
    repairedCandidates: asConceptArray(value.repairedCandidates),
    round2: asEvaluationArray(value.round2),
    finalConcepts: asConceptArray(value.finalConcepts),
    iterations: asScore(value.iterations) || 1,
    passScore: asScore(value.passScore) || 0,
    rounds: Array.isArray(value.rounds)
      ? (value.rounds as Record<string, unknown>[]).map((r) => ({
          round: asScore(r.round),
          minScore: asScore(r.minScore),
          passed: Boolean(r.passed),
          repairSummary: asStringArray(r.repairSummary),
        }))
      : [],
  };
}


const SCOPE_STYLE: Record<string, string> = {
  trend: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  weather: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  catalog: "bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-300",
  concept: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  evaluate: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  lookbook: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  shopping: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  agent: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

function formatClock(t: number) {
  return new Date(t).toLocaleTimeString("en-GB", { hour12: false });
}

function AgentTracePanel({ step, events }: { step: Step; events: TraceEvent[] }) {
  const logRef = useRef<HTMLOListElement | null>(null);
  const activeIndex =
    step === "idle" ? -1 : step === "done" ? AGENT_TRACE_STEPS.length : AGENT_TRACE_STEPS.findIndex((item) => item.key === step);
  const running = step !== "idle" && step !== "done";
  const modelCalls = events.filter((e) => e.tool?.includes("chat.completions")).length;
  const toolCalls = events.filter((e) => e.tool?.startsWith("tool:")).length;
  const fallbacks = events.filter((e) => e.tool === "fallback").length;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <aside className="flex max-h-[calc(100vh-3rem)] flex-col rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span
            className={
              running
                ? "h-2 w-2 animate-pulse rounded-full bg-violet-500"
                : step === "done"
                ? "h-2 w-2 rounded-full bg-emerald-500"
                : "h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-700"
            }
          />
          <p className="text-sm font-semibold text-black dark:text-zinc-50">Agent Trace</p>
        </div>
        <p className="text-[11px] text-zinc-500">{running ? "실행 중" : step === "done" ? "완료" : "대기"}</p>
      </div>

      <ol className="flex flex-col gap-1 px-4 py-3">
        {AGENT_TRACE_STEPS.map((item, index) => {
          const isDone = activeIndex > index;
          const isActive = activeIndex === index;
          return (
            <li key={item.key} className="flex items-center gap-2.5 py-1">
              <span
                className={
                  isDone
                    ? "flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] text-white"
                    : isActive
                    ? "h-4 w-4 animate-pulse rounded-full border-2 border-violet-500"
                    : "h-4 w-4 rounded-full border border-zinc-300 dark:border-zinc-700"
                }
              >
                {isDone ? "✓" : ""}
              </span>
              <span
                className={
                  isActive
                    ? "text-sm font-medium text-black dark:text-zinc-50"
                    : isDone
                    ? "text-sm text-zinc-500"
                    : "text-sm text-zinc-400 dark:text-zinc-600"
                }
              >
                {item.title}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="grid grid-cols-3 gap-2 border-y border-zinc-200 px-4 py-2.5 text-center dark:border-zinc-800">
        <div>
          <p className="text-base font-semibold tabular-nums text-black dark:text-zinc-50">{modelCalls}</p>
          <p className="text-[10px] text-zinc-500">모델 호출</p>
        </div>
        <div>
          <p className="text-base font-semibold tabular-nums text-black dark:text-zinc-50">{toolCalls}</p>
          <p className="text-[10px] text-zinc-500">도구 호출</p>
        </div>
        <div>
          <p className={fallbacks ? "text-base font-semibold tabular-nums text-amber-600" : "text-base font-semibold tabular-nums text-black dark:text-zinc-50"}>{fallbacks}</p>
          <p className="text-[10px] text-zinc-500">모델 대체</p>
        </div>
      </div>

      <ol ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {events.length === 0 && (
          <li className="px-1 py-6 text-center text-xs text-zinc-400">서버 실행 로그가 여기에 쌓여요.</li>
        )}
        {events.map((e, i) => {
          const isWarn = e.message.startsWith("⚠") || e.message.startsWith("✗");
          return (
            <li
              key={`${e.t}-${i}`}
              className={
                isWarn
                  ? "flex gap-2 rounded-md bg-amber-50 px-1.5 py-1.5 dark:bg-amber-950/30"
                  : "flex gap-2 px-1.5 py-1.5"
              }
            >
              <span className="mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-zinc-400">{formatClock(e.t)}</span>
              <div className="min-w-0 flex-1">
                <span className={`mr-1.5 inline-block rounded px-1 py-px text-[10px] font-medium ${SCOPE_STYLE[e.scope] ?? SCOPE_STYLE.agent}`}>
                  {e.scope}
                </span>
                <span className="break-keep text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">{e.message}</span>
                {e.tool && e.tool !== "fallback" && (
                  <span className="ml-1 font-mono text-[10px] text-zinc-400">{e.tool.replace("chat.completions · ", "")}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function EvaluationList({
  title,
  evaluations,
  previousEvaluations,
  hideSelectedDetails = false,
}: {
  title: string;
  evaluations: Evaluation[];
  previousEvaluations?: Evaluation[];
  hideSelectedDetails?: boolean;
}) {
  const previousRankById = new Map(
    (previousEvaluations ?? []).map((evaluation, index) => [
      evaluation.id,
      evaluation.rank ?? index + 1,
    ]),
  );

  function getRankMovement(evaluation: Evaluation, index: number) {
    const previousRank = previousRankById.get(evaluation.id);
    if (previousRank === undefined) return null;
    const currentRank = evaluation.rank ?? index + 1;
    if (currentRank < previousRank) return { symbol: "▲", label: "상승", className: "text-emerald-600" };
    if (currentRank > previousRank) return { symbol: "▼", label: "하강", className: "text-red-600" };
    return { symbol: "—", label: "유지", className: "text-zinc-500" };
  }

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
        {title}
      </p>
      <div className="mt-2 flex flex-col gap-3">
        {evaluations.map((evaluation, index) => {
          const rankMovement = getRankMovement(evaluation, index);
          return (
          <div key={`${title}-${evaluation.id}`} className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-black dark:text-zinc-50">
                    {evaluation.rank ? `${evaluation.rank}위 · ` : ""}
                    {evaluation.name}
                  </p>
                  {evaluation.decisionStatus && (
                    <span
                      className={
                        evaluation.decisionStatus === "선택"
                          ? "rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "rounded-full bg-zinc-200 px-2 py-0.5 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      }
                    >
                      {evaluation.decisionStatus}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  날씨 {evaluation.weatherScore} · 장소 {evaluation.placeScore} · 체형/핏 {evaluation.bodyFitScore} · 트렌드 {evaluation.trendScore} · 실용 {evaluation.practicalityScore}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {rankMovement && (
                  <span
                    className={`text-xs font-semibold ${rankMovement.className}`}
                    title={`1차 평가 대비 ${rankMovement.label}`}
                  >
                    {rankMovement.symbol}
                  </span>
                )}
                <span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                  총점 {evaluation.totalScore}
                </span>
              </div>
            </div>
            <div className="mt-2 grid gap-2 text-xs text-zinc-600 dark:text-zinc-300">
              {evaluation.decisionReason && (
                <p>
                  <span className="font-semibold text-zinc-800 dark:text-zinc-100">선택 판단: </span>
                  {evaluation.decisionReason}
                </p>
              )}
              {!(hideSelectedDetails && evaluation.decisionStatus === "선택") && (
                <>
                  <p>
                    <span className="font-semibold text-zinc-800 dark:text-zinc-100">실패 원인: </span>
                    {evaluation.failureReasons?.join(", ") || "큰 실패 요인 없음"}
                  </p>
                  <p>
                    <span className="font-semibold text-zinc-800 dark:text-zinc-100">수정 방향: </span>
                    {evaluation.revisionPlan?.join(", ") || "유지"}
                  </p>
                </>
              )}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Home() {
  const [keyword, setKeyword] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<string | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [evaluationProcess, setEvaluationProcess] = useState<EvaluationProcess | null>(null);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [followUp, setFollowUp] = useState("");
  const agentStateRef = useRef<Record<string, unknown> | null>(null);
  const looksRef = useRef<Record<string, ServerLook>>({});
  const finalIdsRef = useRef<string[]>([]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>("hidden");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const resultsRef = useRef<HTMLElement>(null);
  const activeRunIdRef = useRef<string | null>(null);

  const isRunning = step !== "idle" && step !== "done";

  useEffect(() => {
    if (!isRunning || startedAt === null) return;
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 100);
    return () => window.clearInterval(interval);
  }, [isRunning, startedAt]);

  function saveHistory(item: SearchHistoryItem) {
    setHistory((prev) => [item, ...prev.filter((historyItem) => historyItem.id !== item.id)].slice(0, 5));
  }

  function resetForNewSearch() {
    setKeyword("");
    setChat([]);
    setFollowUp("");
    agentStateRef.current = null;
    looksRef.current = {};
    finalIdsRef.current = [];
    setError(null);
    setTrend(null);
    setVariants([]);
    setEvaluationProcess(null);
    setStep("idle");
    setStartedAt(null);
    setElapsedMs(null);
    setLoadingPhase("hidden");
    setIsHistoryOpen(false);
    activeRunIdRef.current = null;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function restoreHistory(item: SearchHistoryItem) {
    setKeyword(item.keyword);
    setTrend(item.trend);
    setVariants(item.variants);
    setEvaluationProcess(item.evaluationProcess);
    setElapsedMs(item.elapsedMs);
    setStartedAt(null);
    setError(null);
    setStep("done");
    setLoadingPhase("hidden");
    setIsHistoryOpen(false);
    window.setTimeout(() => {
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }


  function looksToVariants(): Variant[] {
    return finalIdsRef.current
      .map((id) => looksRef.current[id])
      .filter((look): look is ServerLook => Boolean(look))
      .map((look) => ({
        concept: look.concept,
        contradictionIssue: null,
        imageUrl: look.lookbook?.imageUrl ?? null,
        lookbookVerified: Boolean(look.lookbook?.verified),
        lookbookMismatches: look.lookbook?.mismatches ?? [],
        lookbookRetried: Boolean(look.lookbook?.retried),
        lookbookError: look.lookbook?.error ?? null,
        finalMaterials: null,
        shoppingLinks: look.links ?? [],
        shoppingError: look.links && look.links.length === 0 ? "조건에 맞는 상품을 카탈로그에서 찾지 못했어요." : null,
      }));
  }

  function applyStatePatch(patch: Record<string, unknown>) {
    if (typeof patch.trend === "string" && patch.trend) setTrend(patch.trend);
    if (patch.plan && typeof patch.plan === "object") {
      setEvaluationProcess(normalizeEvaluationProcess(patch.plan as Record<string, unknown>));
    }
    if (Array.isArray(patch.finalIds) && patch.finalIds.length) finalIdsRef.current = patch.finalIds.map(String);
    if (patch.looks && typeof patch.looks === "object") {
      for (const [id, raw] of Object.entries(patch.looks as Record<string, ServerLook>)) {
        const prev = looksRef.current[id];
        const next: ServerLook = { ...raw };
        // 서버는 이미지를 "(client)" 로 보내므로 이전에 받은 실제 이미지를 유지
        if (next.lookbook && next.lookbook.imageUrl === "(client)") {
          next.lookbook = { ...next.lookbook, imageUrl: prev?.lookbook?.imageUrl ?? null };
        }
        looksRef.current[id] = next;
      }
    }
    if (finalIdsRef.current.length) setVariants(looksToVariants());
  }

  function stepFromScope(scope: string): Step | null {
    if (scope === "trend" || scope === "weather" || scope === "catalog") return "trend";
    if (scope === "concept" || scope === "evaluate") return "concept";
    if (scope === "lookbook" || scope === "shopping") return "variants";
    return null;
  }

  async function runAgent(userText: string, isFollowUp: boolean) {
    const runStartedAt = getTimestamp();
    const runId = `${runStartedAt}`;
    activeRunIdRef.current = runId;
    const nextChat: ChatTurn[] = [...chat, { role: "user", content: userText }];
    setChat(nextChat);
    setFollowUp("");
    setError(null);
    setStartedAt(runStartedAt);
    setElapsedMs(0);
    setIsHistoryOpen(false);
    setStep(isFollowUp ? "concept" : "trend");
    if (!isFollowUp) {
      setTrend(null);
      setVariants([]);
      setEvaluationProcess(null);
      setTraceEvents([]);
      setLoadingPhase("hidden");
      agentStateRef.current = null;
      looksRef.current = {};
      finalIdsRef.current = [];
      window.setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } else {
      setTraceEvents((prev) => [...prev, { t: Date.now(), scope: "agent", message: `— 후속 요청: ${userText}` }]);
    }

    try {
      // 이미지는 서버에 되돌려 보내지 않는다 (클라이언트가 보관)
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextChat.map(({ role, content }) => ({ role, content })),
          state: agentStateRef.current,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`에이전트 요청 실패 (HTTP ${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line || activeRunIdRef.current !== runId) continue;
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.type === "trace") {
            const t = ev.event as TraceEvent;
            setTraceEvents((prev) => [...prev, t]);
            const s = stepFromScope(t.scope);
            if (s) setStep(s);
          } else if (ev.type === "state") {
            applyStatePatch(ev.patch as Record<string, unknown>);
          } else if (ev.type === "assistant" || ev.type === "question") {
            const turn: ChatTurn = { role: "assistant", content: String(ev.text), kind: ev.type === "question" ? "question" : undefined };
            setChat((prev) => [...prev, turn]);
          } else if (ev.type === "done") {
            agentStateRef.current = ev.state as Record<string, unknown>;
            finished = true;
          } else if (ev.type === "error") {
            throw new Error(String(ev.message));
          }
        }
      }
      if (!finished) throw new Error("에이전트 응답이 중간에 끊겼어요.");

      const finishedElapsedMs = getTimestamp() - runStartedAt;
      setElapsedMs(finishedElapsedMs);
      setStartedAt(null);
      setStep("done");
      const finalVariants = looksToVariants();
      saveHistory({
        id: runId,
        keyword: nextChat[0]?.content ?? userText,
        createdAt: new Date(runStartedAt).toLocaleString("ko-KR", { hour12: false }),
        elapsedMs: finishedElapsedMs,
        trend,
        variants: finalVariants,
        evaluationProcess,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "알 수 없는 오류가 발생했어요.");
      setStep(isFollowUp ? "done" : "idle");
      setStartedAt(null);
      setElapsedMs(getTimestamp() - runStartedAt);
      setLoadingPhase("hidden");
    }
  }

  function runPipeline() {
    if (!keyword.trim()) return;
    setChat([]);
    void runAgent(keyword.trim(), false);
  }

  function sendFollowUp() {
    const text = followUp.trim();
    if (!text || isRunning) return;
    void runAgent(text, true);
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chat.length]);

  return (
    <div className="retro-page min-h-screen font-sans">
      <LoadingScreen phase={loadingPhase} currentStep={step} />

      {/* Hero */}
      <section className="retro-hero relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden px-5 py-8">
        <header className="style-header w-full max-w-6xl">
          <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-400">
            AI Fashion Planning Agent
          </div>
          <h1 className="retro-title">DDP PARK SAJANG</h1>
          <nav className="style-nav" aria-label="서비스 메뉴">
            <span>WEATHER</span>
            <span>CONCEPT</span>
            <span>LOOKBOOK</span>
            <span>SHOPPING</span>
          </nav>
        </header>

        <div className="relative mt-12 w-full max-w-3xl">
          <div className="style-search flex gap-2">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="예: 180cm 90kg 남성, 이번 주말 제주도 여행, 결혼식 하객룩"
              className="flex-1 rounded-none border border-zinc-200 bg-white px-4 py-3 text-zinc-950 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none"
              disabled={isRunning}
            />
            <button
              onClick={runPipeline}
              disabled={isRunning || !keyword.trim()}
              className={
                isRunning
                  ? "flex items-center justify-center gap-2 whitespace-nowrap rounded-none bg-zinc-900 px-5 py-3 font-medium text-white"
                  : "rounded-none bg-zinc-950 px-5 py-3 font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40"
              }
            >
              {isRunning && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              )}
              {isRunning ? stepLabels[step] : "생성"}
            </button>
          </div>

          <div className="relative mt-2 flex justify-start">
            <button
              type="button"
              onClick={() => setIsHistoryOpen((prev) => !prev)}
              disabled={history.length === 0}
              className="rounded-none border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-zinc-900 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              이전 기록 {history.length > 0 ? history.length : ""}
            </button>

            {isHistoryOpen && (
              <div className="absolute left-0 top-10 z-20 w-full max-w-md overflow-hidden rounded-none border border-zinc-200 bg-white p-2 text-left shadow-2xl">
                {history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => restoreHistory(item)}
                    className="block w-full rounded-none px-3 py-2 text-left transition hover:bg-zinc-50"
                  >
                    <span className="block truncate text-sm font-medium text-zinc-950">{item.keyword}</span>
                    <span className="mt-0.5 block text-xs text-zinc-500">
                      {item.createdAt} · {formatElapsed(item.elapsedMs)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="relative mt-4 px-6 text-center text-red-600">{error}</p>
        )}
      </section>

      {/* Pipeline results */}
      <main
        ref={resultsRef}
        className="mx-auto flex min-h-screen max-w-7xl scroll-mt-6 flex-col gap-8 px-6 py-16"
      >
        {step !== "idle" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="text-sm text-zinc-600 dark:text-zinc-300">
              <span className="font-semibold text-black dark:text-zinc-50">걸린 시간</span>{" "}
              {formatElapsed(elapsedMs)}
              {isRunning && <span className="ml-2 text-xs text-violet-500">진행 중</span>}
            </div>
            <button
              type="button"
              onClick={resetForNewSearch}
              className="rounded-md bg-black px-3 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              재검색
            </button>
          </div>
        )}

        {step !== "idle" && (
          <ol className="flex gap-4 text-sm text-zinc-500">
            {(["trend", "concept", "variants"] as Step[]).map((s) => (
              <li
                key={s}
                className={
                  step === s
                    ? "flex items-center gap-1.5 font-semibold text-black dark:text-white"
                    : trend && (s === "trend" || step === "done")
                    ? "text-zinc-400 line-through"
                    : ""
                }
              >
                {step === s && (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-black dark:border-zinc-600 dark:border-t-white" />
                )}
                {s === "variants" ? "룩북" : s === "concept" ? "후보 평가" : s}
              </li>
            ))}
          </ol>
        )}

        <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-8">
        {(trend || step !== "idle") && (
          <section>
            <div className="flex flex-col rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <h2 className="font-semibold text-black dark:text-zinc-50">1. 트렌드·날씨 분석</h2>
              <p className="mt-1 text-sm text-zinc-500">
                분석 내용은 이 박스 안에서 스크롤해 확인할 수 있어요.
              </p>
              {trend ? (
                <div className="mt-3 max-h-96 overflow-y-auto rounded-md bg-zinc-50 p-3 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                  <p className="whitespace-pre-wrap break-keep leading-relaxed">{trend}</p>
                </div>
              ) : (
                <p className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-500 dark:border-zinc-700 dark:border-t-zinc-400" />
                  입력을 해석하고 날짜·장소·날씨 단서를 분석 중...
                </p>
              )}
            </div>
          </section>
        )}

        {evaluationProcess && (
          <section>
            <h2 className="font-semibold text-black dark:text-zinc-50">2. 후보 생성 → 평가 → 수정 루프</h2>
            <p className="mt-1 text-xs text-zinc-500">
              생성 모델과 별도의 평가 모델이 채점하고, 통과 기준({evaluationProcess.passScore}점) 미달이면 수정 후 재평가합니다.
              이번 실행은 {evaluationProcess.iterations}회 평가로 종료됐어요.
            </p>
            {evaluationProcess.rounds.length > 0 && (
              <ol className="mt-2 flex flex-wrap gap-2 text-xs">
                {evaluationProcess.rounds.map((r) => (
                  <li
                    key={r.round}
                    className={
                      r.passed
                        ? "rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                        : "rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                    }
                  >
                    {r.round}차 · 최저 {r.minScore}점 · {r.passed ? "통과" : `미달 → 수정 ${r.repairSummary.length}건`}
                  </li>
                ))}
              </ol>
            )}

            <div className="mt-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                후보 {evaluationProcess.originalCandidates.length}개 생성
              </p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {evaluationProcess.originalCandidates.map((candidate) => (
                  <div key={candidate.id ?? candidate.name} className="rounded-md bg-zinc-50 p-2 text-sm dark:bg-zinc-900">
                    <p className="font-medium text-black dark:text-zinc-50">{candidate.name}</p>
                    <p className="text-xs text-zinc-500">{candidate.mood}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <EvaluationList title="1차 평가" evaluations={evaluationProcess.round1} />
              <EvaluationList
                title={`${evaluationProcess.iterations}차 평가 (최종)`}
                evaluations={evaluationProcess.round2}
                previousEvaluations={evaluationProcess.round1}
                hideSelectedDetails
              />
            </div>

            <p className="mt-4 text-sm font-medium text-black dark:text-zinc-50">
              최종 선택: {evaluationProcess.finalConcepts.map((item) => item.name).join(" / ")}
            </p>
          </section>
        )}

        {variants.length > 0 && (
          <section>
            <h2 className="font-semibold text-black dark:text-zinc-50">3. 최종 룩북 2안</h2>
            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {variants.map((v) => (
                <div key={v.concept.id ?? v.concept.name} className="min-w-0 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                  <h3 className="break-keep text-lg font-semibold text-black dark:text-zinc-50">
                    {v.concept.name}
                  </h3>
                  {v.imageUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={v.imageUrl}
                        alt={`${v.concept.name} 룩북`}
                        className="mt-2 w-full rounded-lg"
                      />
                      <div
                        className={
                          v.lookbookVerified
                            ? "mt-2 rounded-md bg-emerald-50 p-2 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                            : "mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        }
                      >
                        <p className="font-semibold">
                          {v.lookbookVerified ? "✓ AI가 직접 검증했어요" : "💡 아직 스펙과 안 맞는 부분이 있어요"}
                        </p>
                        <p className="mt-0.5">
                          {v.lookbookVerified
                            ? `색상·원단·타겟 모델(성별·연령대)이 컨셉과 일치하는지 확인했어요.${v.lookbookRetried ? " (1회 재생성했어요.)" : ""}`
                            : `${v.lookbookRetried ? "1회 재생성해봤지만" : "확인해보니"} 남아있는 차이: ${v.lookbookMismatches.join(", ")}. 참고용 초안으로 봐주세요.`}
                        </p>
                      </div>
                    </>
                  ) : v.lookbookError ? (
                    <p className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                      ✗ 이미지 생성 실패: {v.lookbookError}
                    </p>
                  ) : (
                    <p className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-500 dark:border-zinc-700 dark:border-t-zinc-400" />
                      이미지 생성 중...
                    </p>
                  )}

                  <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                    <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                      비슷한 옷 구매 링크
                    </p>
                    {v.shoppingLinks.length > 0 ? (
                      <div className="mt-2 flex flex-col gap-2">
                        {v.shoppingLinks.map((link, linkIndex) => (
                          <a
                            key={`${link.url}-${linkIndex}`}
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="min-w-0 overflow-hidden rounded-md bg-zinc-50 p-3 text-sm transition hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                          >
                            <span className="block break-words text-xs font-semibold text-violet-600 dark:text-violet-400">
                              {[link.category, link.item, link.source].filter(Boolean).join(" · ")}
                            </span>
                            <span className="mt-1 block break-words font-medium leading-snug text-black dark:text-zinc-50">
                              {link.title}
                            </span>
                            <span className="mt-1 block break-keep text-xs leading-relaxed text-zinc-500">{link.reason}</span>
                          </a>
                        ))}
                      </div>
                    ) : v.shoppingError ? (
                      <p className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                        ✗ 구매 링크 검색 실패: {v.shoppingError}
                      </p>
                    ) : (
                      <p className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-500 dark:border-zinc-700 dark:border-t-zinc-400" />
                        비슷한 상품 검색 중...
                      </p>
                    )}
                  </div>

                  <div className="mt-4 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800">
                    <p className="break-keep text-zinc-700 dark:text-zinc-300">{v.concept.description}</p>
                    <div className="mt-3 grid gap-1 text-xs text-zinc-500">
                      <p className="break-words">무드: {v.concept.mood}</p>
                      <p className="break-words">색감: {v.concept.colorPalette?.join(", ")}</p>
                      <p className="break-words">대상: {v.concept.targetCustomer}</p>
                      {v.concept.bodyProfile && <p className="break-words">체형 반영: {v.concept.bodyProfile}</p>}
                      {v.concept.fitStrategy && <p className="break-words">핏 전략: {v.concept.fitStrategy}</p>}
                      {Array.isArray(v.concept.outfitItems) && (
                        <p className="break-words">아이템: {v.concept.outfitItems.join(", ")}</p>
                      )}
                      <p className="break-words">원단/질감: {(v.finalMaterials ?? v.concept.materials)?.join(", ")}</p>
                    </div>
                    {v.concept.stylingReason && (
                      <p className="mt-3 break-keep text-sm text-zinc-700 dark:text-zinc-300">
                        {v.concept.stylingReason}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {chat.length > 0 && (
          <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <h2 className="font-semibold text-black dark:text-zinc-50">4. 에이전트와 대화</h2>
            <p className="mt-1 text-xs text-zinc-500">
              결과를 보고 이어서 요청하세요. 에이전트가 바꿔야 할 부분만 골라 다시 작업합니다 (예: &quot;두 번째 룩 신발을 로퍼로&quot;, &quot;날짜를 11월 1일로&quot;).
            </p>
            <div className="mt-3 flex max-h-80 flex-col gap-2 overflow-y-auto">
              {chat.map((turn, i) => (
                <div key={i} className={turn.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={
                      turn.role === "user"
                        ? "max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-900 px-3.5 py-2 text-sm text-white dark:bg-zinc-100 dark:text-black"
                        : turn.kind === "question"
                        ? "max-w-[85%] rounded-2xl rounded-bl-sm border border-violet-200 bg-violet-50 px-3.5 py-2 text-sm text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-100"
                        : "max-w-[85%] rounded-2xl rounded-bl-sm bg-zinc-100 px-3.5 py-2 text-sm text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                    }
                  >
                    {turn.kind === "question" && <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-violet-500">질문</span>}
                    <p className="whitespace-pre-wrap break-keep leading-relaxed">{turn.content}</p>
                  </div>
                </div>
              ))}
              {isRunning && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-zinc-100 px-3.5 py-2 text-sm text-zinc-500 dark:bg-zinc-900">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-300" />
                    {stepLabels[step]}
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                sendFollowUp();
              }}
            >
              <input
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                placeholder={isRunning ? "에이전트가 작업 중이에요..." : "후속 요청을 입력하세요"}
                disabled={isRunning}
                className="flex-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-950 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50"
              />
              <button
                type="submit"
                disabled={isRunning || !followUp.trim()}
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                보내기
              </button>
            </form>
          </section>
        )}
        </div>

        {step !== "idle" && (
          <div className="lg:sticky lg:top-6 lg:w-80 lg:shrink-0">
            <AgentTracePanel step={step} events={traceEvents} />
          </div>
        )}
        </div>
      </main>

    </div>
  );
}
