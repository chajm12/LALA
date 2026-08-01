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

type EvaluationProcess = {
  originalCandidates: Concept[];
  round1: Evaluation[];
  repairSummary: string[];
  repairedCandidates: Concept[];
  round2: Evaluation[];
  finalConcepts: Concept[];
};

type ShoppingLink = {
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
  variants: "룩북·구매 링크 생성 중...",
  done: "완료",
};

const AGENT_TRACE_STEPS = [
  { key: "trend", title: "입력 해석", detail: "날짜, 장소, 성별, 키·몸무게, 상황 단서를 분리합니다." },
  { key: "weather", title: "날씨·계절 판단", detail: "날짜와 장소가 있으면 예보/계절감과 지역 기후를 함께 봅니다." },
  { key: "concept", title: "후보 생성", detail: "무드, 색감, 핏, 원단/질감을 다르게 둔 5개 후보를 만듭니다." },
  { key: "evaluate", title: "평가·수정", detail: "날씨, 장소, 체형/핏, 트렌드, 실용성 기준으로 재평가합니다." },
  { key: "variants", title: "룩북·구매 링크", detail: "최종 2안 이미지를 만들고 비슷한 상품 링크를 찾습니다." },
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

function asShoppingLinks(value: unknown): ShoppingLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const link = item as Record<string, unknown>;
      const url = typeof link.url === "string" ? link.url : "";
      if (!/^https?:\/\//.test(url)) return null;
      return {
        item: String(link.item ?? "추천 아이템"),
        title: String(link.title ?? "비슷한 상품"),
        url,
        source: String(link.source ?? "쇼핑몰"),
        reason: String(link.reason ?? "최종 착장과 유사한 아이템이에요."),
      };
    })
    .filter((item): item is ShoppingLink => item !== null);
}

function normalizeEvaluationProcess(value: Record<string, unknown>): EvaluationProcess {
  return {
    originalCandidates: asConceptArray(value.originalCandidates),
    round1: asEvaluationArray(value.round1),
    repairSummary: Array.isArray(value.repairSummary) ? (value.repairSummary as string[]) : [],
    repairedCandidates: asConceptArray(value.repairedCandidates),
    round2: asEvaluationArray(value.round2),
    finalConcepts: asConceptArray(value.finalConcepts),
  };
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // A route can fail before it ever writes a JSON body (uncaught throw,
  // network drop) - guard the parse so that shows up as a clear message
  // instead of "Unexpected end of JSON input".
  let data: Record<string, unknown> | null = null;
  try {
    data = await res.json();
  } catch {
    // leave data as null; res.ok check below produces the real error message
  }

  if (!res.ok) {
    const message = (data?.error as string | undefined) ?? `${url} 요청 실패 (HTTP ${res.status})`;
    throw new Error(message);
  }
  if (!data) {
    throw new Error(`${url} 응답을 읽을 수 없어요 (빈 응답)`);
  }
  return data;
}

function AgentTracePanel({ step }: { step: Step }) {
  const activeIndex =
    step === "idle" ? -1 : step === "done" ? AGENT_TRACE_STEPS.length : AGENT_TRACE_STEPS.findIndex((item) => item.key === step);

  return (
    <aside className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
        Agent Trace
      </p>
      <div className="mt-4 flex flex-col gap-3">
        {AGENT_TRACE_STEPS.map((item, index) => {
          const isDone = activeIndex > index;
          const isActive = activeIndex === index;
          return (
            <div
              key={item.key}
              className={
                isActive
                  ? "rounded-md border border-violet-200 bg-violet-50 p-3 dark:border-violet-900 dark:bg-violet-950/50"
                  : "rounded-md bg-zinc-50 p-3 dark:bg-zinc-900"
              }
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    isDone
                      ? "flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] text-white"
                      : isActive
                      ? "h-5 w-5 animate-pulse rounded-full border-2 border-violet-500"
                      : "h-5 w-5 rounded-full border border-zinc-300 dark:border-zinc-700"
                  }
                >
                  {isDone ? "✓" : ""}
                </span>
                <p className="text-sm font-medium text-black dark:text-zinc-50">{item.title}</p>
              </div>
              <p className="mt-1 pl-7 text-xs leading-relaxed text-zinc-500 break-keep">{item.detail}</p>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function EvaluationList({
  title,
  evaluations,
  hideSelectedDetails = false,
}: {
  title: string;
  evaluations: Evaluation[];
  hideSelectedDetails?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
        {title}
      </p>
      <div className="mt-2 flex flex-col gap-3">
        {evaluations.map((evaluation) => (
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
              <span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                총점 {evaluation.totalScore}
              </span>
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
        ))}
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
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>("hidden");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const resultsRef = useRef<HTMLElement>(null);

  const isRunning = step !== "idle" && step !== "done";

  useEffect(() => {
    if (!isRunning || startedAt === null) return;
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 100);
    return () => window.clearInterval(interval);
  }, [isRunning, startedAt]);

  function updateVariant(index: number, patch: Partial<Variant>) {
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  }

  function saveHistory(item: SearchHistoryItem) {
    setHistory((prev) => [item, ...prev.filter((historyItem) => historyItem.id !== item.id)].slice(0, 5));
  }

  function resetForNewSearch() {
    setKeyword("");
    setError(null);
    setTrend(null);
    setVariants([]);
    setEvaluationProcess(null);
    setStep("idle");
    setStartedAt(null);
    setElapsedMs(null);
    setLoadingPhase("hidden");
    setIsHistoryOpen(false);
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

  async function runVariantWork(concept: Concept, index: number): Promise<Partial<Variant>> {
    const lookbookPatch: Partial<Variant> = {};
    const shoppingPatch: Partial<Variant> = {};

    const lookbookPromise = (async () => {
      const lookbookData = await postJson("/api/lookbook", { concept });
      Object.assign(lookbookPatch, {
        imageUrl: (lookbookData.imageUrl as string) ?? null,
        lookbookVerified: Boolean(lookbookData.verified),
        lookbookMismatches: Array.isArray(lookbookData.mismatches)
          ? (lookbookData.mismatches as string[])
          : [],
        lookbookRetried: Boolean(lookbookData.retried),
        lookbookError: (lookbookData.error as string) ?? null,
      });
      updateVariant(index, lookbookPatch);
    })().catch((e) => {
      Object.assign(lookbookPatch, {
        lookbookError: e instanceof Error ? e.message : "룩북 이미지 생성 실패",
      });
      updateVariant(index, lookbookPatch);
    });

    const shoppingPromise = postJson("/api/shopping", { keyword, concept })
      .then((shoppingData) => {
        const links = asShoppingLinks(shoppingData.links);
        Object.assign(shoppingPatch, {
          shoppingLinks: links,
          shoppingError: links.length
            ? null
            : "조건에 맞는 직접 상품 상세 링크를 찾지 못했어요.",
        });
        updateVariant(index, shoppingPatch);
      })
      .catch((e) => {
        Object.assign(shoppingPatch, {
          shoppingError: e instanceof Error ? e.message : "구매 링크 검색 실패",
        });
        updateVariant(index, shoppingPatch);
      });

    await Promise.all([lookbookPromise, shoppingPromise]);
    return { ...lookbookPatch, ...shoppingPatch };
  }

  async function runPipeline() {
    if (!keyword.trim()) return;
    const runKeyword = keyword.trim();
    const runStartedAt = getTimestamp();

    setError(null);
    setTrend(null);
    setVariants([]);
    setEvaluationProcess(null);
    setLoadingPhase("hidden");
    setStartedAt(runStartedAt);
    setElapsedMs(0);
    setIsHistoryOpen(false);

    try {
      setStep("trend");
      window.setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
      const trendData = await postJson("/api/trend", { keyword: runKeyword });
      setTrend(trendData.trend as string);

      setStep("concept");
      const conceptData = await postJson("/api/concept", { keyword: runKeyword, trend: trendData.trend });
      const candidatePool = asConceptArray(conceptData.concepts);
      const evaluationData = normalizeEvaluationProcess(await postJson("/api/evaluate", {
        keyword: runKeyword,
        trend: trendData.trend,
        candidates: candidatePool,
      }));
      setEvaluationProcess(evaluationData);
      const concepts = evaluationData.finalConcepts.length
        ? evaluationData.finalConcepts
        : candidatePool.slice(0, 2);

      const initialVariants: Variant[] = concepts.map((concept) => ({
        concept,
        contradictionIssue: null,
        imageUrl: null,
        lookbookVerified: false,
        lookbookMismatches: [],
        lookbookRetried: false,
        lookbookError: null,
        finalMaterials: null,
        shoppingLinks: [],
        shoppingError: null,
      }));
      setVariants(initialVariants);

      setStep("variants");

      const variantPatches = await Promise.all(concepts.map((concept, i) => runVariantWork(concept, i)));
      const finalVariants = initialVariants.map((variant, index) => ({
        ...variant,
        ...variantPatches[index],
      }));
      setVariants(finalVariants);

      const finishedElapsedMs = getTimestamp() - runStartedAt;
      setElapsedMs(finishedElapsedMs);
      setStartedAt(null);
      setStep("done");
      saveHistory({
        id: `${runStartedAt}`,
        keyword: runKeyword,
        createdAt: new Date(runStartedAt).toLocaleString("ko-KR", { hour12: false }),
        elapsedMs: finishedElapsedMs,
        trend: trendData.trend as string,
        variants: finalVariants,
        evaluationProcess: evaluationData,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "알 수 없는 오류가 발생했어요.");
      setStep("idle");
      setStartedAt(null);
      setElapsedMs(getTimestamp() - runStartedAt);
      setLoadingPhase("hidden");
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <LoadingScreen phase={loadingPhase} currentStep={step} />

      {/* Hero */}
      <section className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-black">
        <iframe
          src="https://my.spline.design/retrofuturismbganimation-ekg1AOKnE6ZMIXQPsPPfYxw2/"
          title="Retro Futurism 3D Background"
          frameBorder="0"
          className="absolute inset-0 h-full w-full"
        />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,transparent_35%,rgba(0,0,0,0.55)_55%,rgba(0,0,0,0.93)_85%)]" />

        <div className="relative flex flex-col items-center gap-4 px-6 text-center [text-shadow:0_2px_24px_rgba(0,0,0,0.85)]">
          <span className="text-xs font-medium tracking-[0.3em] text-violet-200 uppercase">
            AI Fashion Director
          </span>
          <h1 className="text-5xl font-bold tracking-tight text-white sm:text-6xl">
            Fashion Planning Agent
          </h1>
          <p className="max-w-md text-sm text-violet-100 sm:text-base">
           
          </p>
        </div>

        <div className="relative mt-10 w-full max-w-xl px-6">
          <div className="flex gap-2">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="예: 8월 10일 성수동 카페 데이트, 175cm 70kg"
              className="flex-1 rounded-lg border border-white/20 bg-white/10 px-4 py-3 text-white placeholder-white/50 backdrop-blur-md focus:border-white/40 focus:outline-none"
              disabled={isRunning}
            />
            <button
              onClick={runPipeline}
              disabled={isRunning || !keyword.trim()}
              className={
                isRunning
                  ? "flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-white/15 px-5 py-3 font-medium text-white"
                  : "rounded-lg bg-white px-5 py-3 font-medium text-black disabled:opacity-40"
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
              className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur-md transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              이전 기록 {history.length > 0 ? history.length : ""}
            </button>

            {isHistoryOpen && (
              <div className="absolute left-0 top-10 z-20 w-full max-w-md overflow-hidden rounded-lg border border-white/15 bg-black/80 p-2 text-left shadow-2xl backdrop-blur-xl">
                {history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => restoreHistory(item)}
                    className="block w-full rounded-md px-3 py-2 text-left transition hover:bg-white/10"
                  >
                    <span className="block truncate text-sm font-medium text-white">{item.keyword}</span>
                    <span className="mt-0.5 block text-xs text-white/50">
                      {item.createdAt} · {formatElapsed(item.elapsedMs)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="relative mt-4 px-6 text-center text-red-300">{error}</p>
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
                {s === "variants" ? "룩북·구매 링크" : s === "concept" ? "후보 평가" : s}
              </li>
            ))}
          </ol>
        )}

        {(trend || step !== "idle") && (
          <section className="grid items-stretch grid-cols-1 gap-4 lg:grid-cols-[3fr_1fr]">
            <div className="flex h-full min-h-0 flex-col rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
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
            <AgentTracePanel step={step} />
          </section>
        )}

        {evaluationProcess && (
          <section>
            <h2 className="font-semibold text-black dark:text-zinc-50">2. 후보 평가·수정·재평가</h2>
            <p className="mt-1 text-xs text-zinc-500">
              룩북 이미지는 최종 2안만 생성하고, 아래에는 전체 후보의 평가 과정만 보여줍니다.
            </p>

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
              <EvaluationList title="재평가" evaluations={evaluationProcess.round2} hideSelectedDetails />
            </div>
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
                              {link.item} · {link.source}
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
      </main>

    </div>
  );
}
