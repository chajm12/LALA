"use client";

export type LoadingPhase = "hidden" | "visible" | "exiting";

const STEPS = ["trend", "concept", "variants"] as const;
type StepKey = (typeof STEPS)[number];

const STEP_TITLES: Record<StepKey, string> = {
  trend: "트렌드·날씨 조사 중",
  concept: "후보 생성·평가 중",
  variants: "룩북 생성 중",
};

export default function LoadingScreen({
  phase,
  currentStep,
}: {
  phase: LoadingPhase;
  currentStep: StepKey | "idle" | "done";
}) {
  const currentIndex = currentStep === "done" ? STEPS.length : STEPS.indexOf(currentStep as StepKey);
  const title = currentStep === "done" ? "완료!" : currentIndex >= 0 ? STEP_TITLES[STEPS[currentIndex]] : "준비 중";

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-black transition-transform duration-700 ease-in-out ${
        phase === "visible"
          ? "translate-y-0"
          : phase === "exiting"
          ? "-translate-y-full"
          : "translate-y-full"
      } ${phase !== "visible" ? "pointer-events-none" : ""}`}
    >
      {currentStep === "done" ? (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-violet-500 text-2xl text-white">
          ✓
        </div>
      ) : (
        <div className="h-14 w-14 animate-spin rounded-full border-4 border-violet-500/20 border-t-violet-400" />
      )}

      <p className="mt-6 text-lg font-medium text-white">{title}</p>
      <p className="mt-1 text-sm text-white/50">
        {currentStep === "done" ? "결과를 보여드릴게요" : "에이전트가 후보를 만들고 검증하고 있어요"}
      </p>

      <ol className="mt-10 flex items-center gap-3 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-3">
            <span
              className={
                i < currentIndex
                  ? "flex h-6 w-6 items-center justify-center rounded-full bg-violet-500 text-xs text-white"
                  : i === currentIndex
                  ? "flex h-6 w-6 items-center justify-center rounded-full border-2 border-violet-400 text-xs text-violet-300"
                  : "flex h-6 w-6 items-center justify-center rounded-full border border-white/20 text-xs text-white/30"
              }
            >
              {i < currentIndex ? "✓" : i + 1}
            </span>
            <span
              className={
                i === currentIndex ? "font-medium text-white" : i < currentIndex ? "text-white/50" : "text-white/30"
              }
            >
              {STEP_TITLES[s]}
            </span>
            {i < STEPS.length - 1 && <span className="ml-3 h-px w-6 bg-white/15" />}
          </li>
        ))}
      </ol>
    </div>
  );
}
