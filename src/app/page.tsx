"use client";

import { useRef, useState } from "react";
import CostHistoryChart, { type CostIteration } from "@/components/CostHistoryChart";

type Concept = {
  name: string;
  description: string;
  mood: string;
  colorPalette: string[];
  targetCustomer: string;
  materials: string[];
};

type Cost = {
  materialCost: number;
  laborCost: number;
  overheadCost: number;
  totalCost: number;
  marginRate: number;
  sellCost: number;
  breakdown: string[];
};

type Variant = {
  concept: Concept;
  contradictionIssue: string | null;
  imageUrl: string | null;
  lookbookVerified: boolean;
  lookbookMismatches: string[];
  lookbookRetried: boolean;
  lookbookError: string | null;
  cost: Cost | null;
  finalMaterials: string[] | null;
  substitutionReason: string | null;
  substitutionTier: string | null;
  costHistory: CostIteration[] | null;
  costError: string | null;
};

type Step = "idle" | "trend" | "concept" | "variants" | "done";

const stepLabels: Record<Step, string> = {
  idle: "생성",
  trend: "트렌드 조사 중...",
  concept: "컨셉 2안 기획 중...",
  variants: "룩북·원가 생성 중...",
  done: "완료",
};

const VARIANT_LABELS = ["A안", "B안"];

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

export default function Home() {
  const [keyword, setKeyword] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<string | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const resultsRef = useRef<HTMLElement>(null);

  const isRunning = step !== "idle" && step !== "done";

  function updateVariant(index: number, patch: Partial<Variant>) {
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  }

  async function runVariantWork(concept: Concept, index: number) {
    try {
      const lookbookData = await postJson("/api/lookbook", { concept });
      updateVariant(index, {
        imageUrl: (lookbookData.imageUrl as string) ?? null,
        lookbookVerified: Boolean(lookbookData.verified),
        lookbookMismatches: Array.isArray(lookbookData.mismatches)
          ? (lookbookData.mismatches as string[])
          : [],
        lookbookRetried: Boolean(lookbookData.retried),
        lookbookError: (lookbookData.error as string) ?? null,
      });
    } catch (e) {
      updateVariant(index, {
        lookbookError: e instanceof Error ? e.message : "룩북 이미지 생성 실패",
      });
    }

    try {
      const costData = await postJson("/api/cost", { concept });
      updateVariant(index, {
        cost: costData.cost as Cost,
        finalMaterials: (costData.materials as string[]) ?? null,
        substitutionReason: (costData.substitutionReason as string) ?? null,
        substitutionTier: (costData.substitutionTier as string) ?? null,
        costHistory: Array.isArray(costData.history) ? (costData.history as CostIteration[]) : null,
      });
    } catch (e) {
      updateVariant(index, {
        costError: e instanceof Error ? e.message : "원가 산출 실패",
      });
    }
  }

  async function runPipeline() {
    if (!keyword.trim()) return;

    setError(null);
    setTrend(null);
    setVariants([]);

    try {
      setStep("trend");
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      const trendData = await postJson("/api/trend", { keyword });
      setTrend(trendData.trend as string);

      setStep("concept");
      const conceptData = await postJson("/api/concept", { keyword, trend: trendData.trend });
      const concepts = conceptData.concepts as Concept[];
      const contradictionIssues = Array.isArray(conceptData.contradictionIssues)
        ? (conceptData.contradictionIssues as (string | null)[])
        : [];

      const initialVariants: Variant[] = concepts.map((concept, i) => ({
        concept,
        contradictionIssue: contradictionIssues[i] ?? null,
        imageUrl: null,
        lookbookVerified: false,
        lookbookMismatches: [],
        lookbookRetried: false,
        lookbookError: null,
        cost: null,
        finalMaterials: null,
        substitutionReason: null,
        substitutionTier: null,
        costHistory: null,
        costError: null,
      }));
      setVariants(initialVariants);

      setStep("variants");
      await Promise.all(concepts.map((concept, i) => runVariantWork(concept, i)));

      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "알 수 없는 오류가 발생했어요.");
      setStep("idle");
    }
  }

  const bothCostsReady = variants.length === 2 && variants.every((v) => v.cost);
  const cheaperIndex =
    bothCostsReady && variants[0].cost!.sellCost !== variants[1].cost!.sellCost
      ? variants[0].cost!.sellCost < variants[1].cost!.sellCost
        ? 0
        : 1
      : null;

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
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
            한 줄의 아이디어만으로 트렌드 조사부터 룩북, 원가 초안까지 몇 분 만에 — 두 가지 방향으로 비교해서
          </p>
        </div>

        <div className="relative mt-10 flex w-full max-w-xl gap-2 px-6">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="예: Y2K 스트릿 감성의 서머 캡슐 컬렉션"
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

        {error && (
          <p className="relative mt-4 px-6 text-center text-red-300">{error}</p>
        )}
      </section>

      {/* Pipeline results */}
      <main
        ref={resultsRef}
        className="mx-auto flex min-h-screen max-w-4xl scroll-mt-6 flex-col gap-8 px-6 py-16"
      >
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
                {s === "variants" ? "룩북·원가" : s}
              </li>
            ))}
          </ol>
        )}

        {trend && (
          <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-semibold text-black dark:text-zinc-50">1. Trend</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
              {trend}
            </p>
          </section>
        )}

        {variants.length > 0 && (
          <section>
            <h2 className="font-semibold text-black dark:text-zinc-50">2. Concept — 두 가지 방향</h2>
            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {variants.map((v, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
                >
                  <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                    {VARIANT_LABELS[i]}
                  </p>
                  <p className="mt-1 font-medium text-black dark:text-zinc-50">{v.concept.name}</p>
                  <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{v.concept.description}</p>
                  <p className="mt-1 text-sm text-zinc-500">Mood: {v.concept.mood}</p>
                  <p className="mt-1 text-sm text-zinc-500">Colors: {v.concept.colorPalette?.join(", ")}</p>
                  <p className="mt-1 text-sm text-zinc-500">Target: {v.concept.targetCustomer}</p>
                  <p className="mt-1 text-sm text-zinc-500">
                    Materials: {(v.finalMaterials ?? v.concept.materials)?.join(", ")}
                  </p>
                  {v.contradictionIssue && (
                    <div className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      <p className="font-semibold">💡 왜 원단이 바뀌었나요?</p>
                      <p className="mt-0.5">
                        계절/트렌드와 원단이 안 맞아서 자동으로 고쳤어요: {v.contradictionIssue}
                      </p>
                    </div>
                  )}
                  {v.substitutionReason && (
                    <div className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      <p className="font-semibold">
                        💡 왜 원단이 바뀌었나요?{v.substitutionTier ? ` (${v.substitutionTier}에서 탐색)` : ""}
                      </p>
                      <p className="mt-0.5">
                        원가 절감을 위해 원단을 자동으로 대체했어요: {v.substitutionReason}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {variants.some((v) => v.imageUrl || v.lookbookError) && (
          <section>
            <h2 className="font-semibold text-black dark:text-zinc-50">3. Lookbook</h2>
            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {variants.map((v, i) => (
                <div key={i} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                  <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                    {VARIANT_LABELS[i]}
                  </p>
                  {v.imageUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={v.imageUrl}
                        alt={`${VARIANT_LABELS[i]} lookbook`}
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
                    <p className="mt-2 text-sm text-zinc-400">생성 중...</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {variants.some((v) => v.cost || v.costError) && (
          <section>
            <h2 className="font-semibold text-black dark:text-zinc-50">4. Cost — 두 방향 비교</h2>
            <p className="mt-1 text-xs text-zinc-500">
              ⚠️ 아래 수치는 웹검색 기반 AI 추정치예요. 실제 발주 전에는 반드시 원단 시세를 별도로 확인하세요.
            </p>

            {bothCostsReady && cheaperIndex !== null && (
              <p className="mt-2 rounded-md bg-violet-50 p-2 text-sm font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300">
                💰 {VARIANT_LABELS[cheaperIndex]}이 판매가 기준으로 더 저렴해요 (
                {Math.abs(
                  Math.round(
                    ((variants[cheaperIndex].cost!.sellCost -
                      variants[cheaperIndex === 0 ? 1 : 0].cost!.sellCost) /
                      variants[cheaperIndex === 0 ? 1 : 0].cost!.sellCost) *
                      100,
                  ),
                )}
                % 낮음)
              </p>
            )}

            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {variants.map((v, i) => (
                <div key={i} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                  <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                    {VARIANT_LABELS[i]}
                  </p>
                  {v.cost ? (
                    <>
                      <ul className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
                        <li>Material: {v.cost.materialCost?.toLocaleString()} KRW</li>
                        <li>Labor: {v.cost.laborCost?.toLocaleString()} KRW</li>
                        <li>Overhead: {v.cost.overheadCost?.toLocaleString()} KRW</li>
                        <li className="font-semibold">
                          Production cost (추정): {v.cost.totalCost?.toLocaleString()} KRW
                        </li>
                        <li className="mt-1 font-semibold text-emerald-600 dark:text-emerald-400">
                          Sell price (추정): {v.cost.sellCost?.toLocaleString()} KRW{" "}
                          <span className="font-normal text-zinc-500">
                            (margin {Math.round((v.cost.marginRate ?? 0) * 100)}%)
                          </span>
                        </li>
                      </ul>

                      <p className="mt-3 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                        💡 이렇게 계산했어요
                      </p>
                      <ul className="mt-1 list-disc pl-5 text-sm text-zinc-500">
                        {v.cost.breakdown?.map((b, bi) => (
                          <li key={bi}>{b}</li>
                        ))}
                      </ul>

                      {v.costHistory && v.costHistory.length > 1 && (
                        <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                          <CostHistoryChart history={v.costHistory} />
                        </div>
                      )}
                    </>
                  ) : v.costError ? (
                    <p className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                      ✗ 원가 산출 실패: {v.costError}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-zinc-400">계산 중...</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
