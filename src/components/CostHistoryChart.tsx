"use client";

type MaterialCandidate = { material: string; note: string };

export type CostIteration = {
  iteration: number;
  materials: string[];
  materialCost: number;
  laborCost: number;
  overheadCost: number;
  totalCost: number;
  marginRate: number;
  sellCost: number;
  breakdown: string[];
  reason: string | null;
  candidates: MaterialCandidate[] | null;
};

function fmt(n: number) {
  return n.toLocaleString();
}

export default function CostHistoryChart({ history }: { history: CostIteration[] }) {
  if (history.length === 0) return null;

  const max = Math.max(...history.map((h) => h.sellCost));
  const chartHeight = 140;
  const barWidth = 48;
  const gap = 28;
  const width = history.length * (barWidth + gap) + gap;

  return (
    <div>
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        원가 재평가 추이 ({history.length}회 평가)
      </p>

      <svg
        role="img"
        aria-label="반복 평가별 판매가 변화"
        width="100%"
        viewBox={`0 0 ${width} ${chartHeight + 40}`}
        className="mt-2"
      >
        <line
          x1="0"
          y1={chartHeight}
          x2={width}
          y2={chartHeight}
          className="stroke-zinc-300 dark:stroke-zinc-700"
          strokeWidth={1}
        />
        {history.map((h, i) => {
          const barH = max > 0 ? (h.sellCost / max) * (chartHeight - 20) : 0;
          const x = gap + i * (barWidth + gap);
          const y = chartHeight - barH;
          const prev = history[i - 1];
          const delta = prev ? h.sellCost - prev.sellCost : null;

          return (
            <g key={h.iteration}>
              <title>
                {`반복 ${h.iteration}: 판매가 ${fmt(h.sellCost)} KRW, 마진 ${Math.round(h.marginRate * 100)}%`}
              </title>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                rx={4}
                className="fill-violet-500 dark:fill-violet-400"
              />
              <text
                x={x + barWidth / 2}
                y={y - 6}
                textAnchor="middle"
                className="fill-zinc-700 text-[10px] dark:fill-zinc-300"
              >
                {fmt(h.sellCost)}
              </text>
              <text
                x={x + barWidth / 2}
                y={chartHeight + 16}
                textAnchor="middle"
                className="fill-zinc-500 text-[10px]"
              >
                {h.iteration === 0 ? "초기" : `${h.iteration}차`}
              </text>
              {delta !== null && delta !== 0 && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 30}
                  textAnchor="middle"
                  className={
                    delta < 0
                      ? "fill-emerald-600 text-[10px] font-medium dark:fill-emerald-400"
                      : "fill-rose-600 text-[10px] font-medium dark:fill-rose-400"
                  }
                >
                  {delta < 0 ? "▼" : "▲"} {Math.abs(Math.round((delta / prev.sellCost) * 100))}%
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-xs text-zinc-600 dark:text-zinc-400">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th className="py-1 pr-3 font-medium">회차</th>
              <th className="py-1 pr-3 font-medium">주 원단</th>
              <th className="py-1 pr-3 font-medium">마진</th>
              <th className="py-1 pr-3 font-medium">판매가</th>
              <th className="py-1 font-medium">사유</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.iteration} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1 pr-3">{h.iteration === 0 ? "초기" : `${h.iteration}차`}</td>
                <td className="py-1 pr-3">{h.materials[0]}</td>
                <td className="py-1 pr-3">{Math.round(h.marginRate * 100)}%</td>
                <td className="py-1 pr-3">{fmt(h.sellCost)} KRW</td>
                <td className="py-1">{h.reason ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {history[history.length - 1].candidates && (
        <div className="mt-4">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            검토된 대체 원단 비교
          </p>
          <ul className="mt-1 space-y-1 text-xs text-zinc-500">
            {history[history.length - 1].candidates!.map((c) => (
              <li key={c.material}>
                <span
                  className={
                    c.material === history[history.length - 1].materials[0]
                      ? "font-semibold text-violet-600 dark:text-violet-400"
                      : "font-medium text-zinc-600 dark:text-zinc-400"
                  }
                >
                  {c.material}
                  {c.material === history[history.length - 1].materials[0] ? " (선택됨)" : ""}
                </span>
                {" — "}
                {c.note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
