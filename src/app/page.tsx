"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const [keyword, setKeyword] = useState("");
  const [navigating, setNavigating] = useState(false);
  const router = useRouter();

  useEffect(() => {
    router.prefetch("/result");
  }, [router]);

  function handleSubmit() {
    if (!keyword.trim() || navigating) return;
    setNavigating(true);
    router.push(`/result?keyword=${encodeURIComponent(keyword.trim())}`);
  }

  return (
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
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="예: Y2K 스트릿 감성의 서머 캡슐 컬렉션"
          className="flex-1 rounded-lg border border-white/20 bg-white/10 px-4 py-3 text-white placeholder-white/50 backdrop-blur-md focus:border-white/40 focus:outline-none"
          disabled={navigating}
        />
        <button
          onClick={handleSubmit}
          disabled={navigating || !keyword.trim()}
          className={
            navigating
              ? "flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-white/15 px-5 py-3 font-medium text-white"
              : "rounded-lg bg-white px-5 py-3 font-medium text-black disabled:opacity-40"
          }
        >
          {navigating && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          )}
          {navigating ? "이동 중..." : "생성"}
        </button>
      </div>
    </section>
  );
}
