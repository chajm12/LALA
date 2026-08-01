"use client";

import { useRef, useState } from "react";

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

type Step = "idle" | "trend" | "concept" | "lookbook" | "cost" | "done";

const stepLabels: Record<Step, string> = {
  idle: "생성",
  trend: "트렌드 조사 중...",
  concept: "컨셉 기획 중...",
  lookbook: "룩북 생성 중...",
  cost: "원가 산출 중...",
  done: "완료",
};

export default function Home() {
  const [keyword, setKeyword] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<string | null>(null);
  const [concept, setConcept] = useState<Concept | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [cost, setCost] = useState<Cost | null>(null);
  const [finalMaterials, setFinalMaterials] = useState<string[] | null>(null);
  const [substitutionReason, setSubstitutionReason] = useState<string | null>(null);
  const resultsRef = useRef<HTMLElement>(null);

  const isRunning = step !== "idle" && step !== "done";

  async function runPipeline() {
    if (!keyword.trim()) return;

    setError(null);
    setTrend(null);
    setConcept(null);
    setImageUrl(null);
    setCost(null);
    setFinalMaterials(null);
    setSubstitutionReason(null);

    try {
      setStep("trend");
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      const trendRes = await fetch("/api/trend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword }),
      });
      const trendData = await trendRes.json();
      setTrend(trendData.trend);

      setStep("concept");
      const conceptRes = await fetch("/api/concept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, trend: trendData.trend }),
      });
      const conceptData = await conceptRes.json();
      setConcept(conceptData.concept);

      setStep("lookbook");
      const lookbookRes = await fetch("/api/lookbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: conceptData.concept }),
      });
      const lookbookData = await lookbookRes.json();
      setImageUrl(lookbookData.imageUrl);

      setStep("cost");
      const costRes = await fetch("/api/cost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: conceptData.concept }),
      });
      const costData = await costRes.json();
      setCost(costData.cost);
      setFinalMaterials(costData.materials ?? null);
      setSubstitutionReason(costData.substitutionReason ?? null);

      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "알 수 없는 오류가 발생했어요.");
      setStep("idle");
    }
  }

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
            한 줄의 아이디어만으로 트렌드 조사부터 룩북, 원가 산출까지
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
        className="mx-auto flex min-h-screen max-w-2xl scroll-mt-6 flex-col gap-8 px-6 py-16"
      >
        {step !== "idle" && (
          <ol className="flex gap-4 text-sm text-zinc-500">
            {(["trend", "concept", "lookbook", "cost"] as Step[]).map((s) => (
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
                {s}
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

        {concept && (
          <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-semibold text-black dark:text-zinc-50">2. Concept</h2>
            <p className="mt-2 font-medium text-black dark:text-zinc-50">{concept.name}</p>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              {concept.description}
            </p>
            <p className="mt-1 text-sm text-zinc-500">Mood: {concept.mood}</p>
            <p className="mt-1 text-sm text-zinc-500">
              Colors: {concept.colorPalette?.join(", ")}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              Target: {concept.targetCustomer}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              Materials: {(finalMaterials ?? concept.materials)?.join(", ")}
            </p>
            {substitutionReason && (
              <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                원가 절감을 위해 원단이 자동으로 대체됐어요: {substitutionReason}
              </p>
            )}
          </section>
        )}

        {imageUrl && (
          <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-semibold text-black dark:text-zinc-50">3. Lookbook</h2>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt="Generated lookbook"
              className="mt-2 w-full rounded-lg"
            />
          </section>
        )}

        {cost && (
          <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-semibold text-black dark:text-zinc-50">4. Cost</h2>
            <ul className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
              <li>Material: {cost.materialCost?.toLocaleString()} KRW</li>
              <li>Labor: {cost.laborCost?.toLocaleString()} KRW</li>
              <li>Overhead: {cost.overheadCost?.toLocaleString()} KRW</li>
              <li className="font-semibold">
                Production cost: {cost.totalCost?.toLocaleString()} KRW
              </li>
              <li className="mt-1 font-semibold text-emerald-600 dark:text-emerald-400">
                Sell price: {cost.sellCost?.toLocaleString()} KRW{" "}
                <span className="font-normal text-zinc-500">
                  (margin {Math.round((cost.marginRate ?? 0) * 100)}%)
                </span>
              </li>
            </ul>
            <ul className="mt-2 list-disc pl-5 text-sm text-zinc-500">
              {cost.breakdown?.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
