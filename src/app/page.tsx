"use client";

import { useState } from "react";

type Concept = {
  name: string;
  description: string;
  mood: string;
  colorPalette: string[];
  targetCustomer: string;
};

type Cost = {
  materialCost: number;
  laborCost: number;
  overheadCost: number;
  totalCost: number;
  breakdown: string[];
};

type Step = "idle" | "trend" | "concept" | "lookbook" | "cost" | "done";

export default function Home() {
  const [keyword, setKeyword] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<string | null>(null);
  const [concept, setConcept] = useState<Concept | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [cost, setCost] = useState<Cost | null>(null);

  const isRunning = step !== "idle" && step !== "done";

  async function runPipeline() {
    if (!keyword.trim()) return;

    setError(null);
    setTrend(null);
    setConcept(null);
    setImageUrl(null);
    setCost(null);

    try {
      setStep("trend");
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

      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "알 수 없는 오류가 발생했어요.");
      setStep("idle");
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      {/* Hero */}
      <section className="relative h-[70vh] w-full overflow-hidden bg-black">
        <iframe
          src="https://my.spline.design/retrofuturismbganimation-ekg1AOKnE6ZMIXQPsPPfYxw2/"
          title="Retro Futurism 3D Background"
          frameBorder="0"
          className="absolute inset-0 h-full w-full"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/70 via-black/50 to-black/80" />
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 text-center">
          <span className="text-xs font-medium tracking-[0.3em] text-violet-300/80 uppercase">
            AI Fashion Director
          </span>
          <h1 className="bg-gradient-to-b from-white to-violet-200 bg-clip-text text-5xl font-bold tracking-tight text-transparent sm:text-6xl">
            Fashion Planning Agent
          </h1>
          <p className="max-w-md text-sm text-violet-100/70 sm:text-base">
            한 줄의 아이디어만으로 트렌드 조사부터 룩북, 원가 산출까지
          </p>
        </div>
      </section>

      {/* Input + pipeline */}
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
        <div className="flex gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="예: Y2K 스트릿 감성의 서머 캡슐 컬렉션"
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            disabled={isRunning}
          />
          <button
            onClick={runPipeline}
            disabled={isRunning || !keyword.trim()}
            className="rounded-lg bg-black px-5 py-2 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          >
            {isRunning ? "진행 중..." : "생성"}
          </button>
        </div>

        {error && <p className="text-red-500">{error}</p>}

        {step !== "idle" && (
          <ol className="flex gap-4 text-sm text-zinc-500">
            {(["trend", "concept", "lookbook", "cost"] as Step[]).map((s) => (
              <li
                key={s}
                className={
                  step === s
                    ? "font-semibold text-black dark:text-white"
                    : trend && (s === "trend" || step === "done")
                    ? "text-zinc-400 line-through"
                    : ""
                }
              >
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
                Total: {cost.totalCost?.toLocaleString()} KRW
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
