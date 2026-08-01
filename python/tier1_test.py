"""
Tier 1 테스트 — 2x2 4컷 만화 실현 가능성 검증

확인하는 것:
  1. 4패널이 정확히 균등 분할되는가      → 512/512 지점에서 잘라도 되는가
  2. 4컷의 캐릭터가 동일 인물인가          → 2x2 방식의 핵심 전제
  3. 말풍선 한글이 깨지지 않는가          → 대사를 모델에 맡길 수 있는가
  4. 패널 읽기 순서가 지켜지는가          → 좌상→우상→좌하→우하
  5. 요청하지 않은 글자가 섞이는가        → 벽 포스터 등

결과: _tier1/report.html
  - 원본 이미지에 빨간 십자선을 겹쳐 격자 정렬을 육안 확인
  - 자동 4분할한 패널을 나란히 배치해 캐릭터 일관성 확인

사용법:
    python -m pip install openai python-dotenv pillow
    python tier1_test.py                      # 1024x1024, 3회
    python tier1_test.py --runs 2 --sizes 1024x1024 1536x1024
    python tier1_test.py --quality medium
"""

import argparse
import asyncio
import base64
import io
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import AsyncOpenAI
from PIL import Image

load_dotenv()

OUT = Path(__file__).parent / "_tier1"
OUT.mkdir(exist_ok=True)

SEM = asyncio.Semaphore(4)  # 동시 요청 한도 (20장 동시 실패 이력 반영)


# ─────────────────────────────────────────────────────────
# 실전 템플릿 — 고정부(레이아웃/스타일/통제)와 가변부({})를 분리
# 실전에서는 {} 안을 에이전트가 JSON으로 채운다.
# ─────────────────────────────────────────────────────────
TEMPLATE = """A four-panel educational comic in a 2x2 grid.
No panel borders, no gutters, no gaps between panels.

The SAME character appears in all four panels: {character}
Keep the character's face, hair, and clothing identical in every panel.

Panel 1 (top-left): {p1_scene}
Speech bubble text in Korean: "{p1_line}"

Panel 2 (top-right): {p2_scene}
Speech bubble text in Korean: "{p2_line}"

Panel 3 (bottom-left): {p3_scene}
Speech bubble text in Korean: "{p3_line}"

Panel 4 (bottom-right): {p4_scene}
Speech bubble text in Korean: "{p4_line}"

Flat vector children's book illustration style, clean solid backgrounds.
Each speech bubble sits in the upper part of its own panel.
No text anywhere except inside the four speech bubbles.
No posters, no signs, no writing on walls, boards, or books."""


# 에이전트가 생성할 스토리보드를 손으로 흉내낸 것 (구조 검증용)
STORYBOARD = {
    "character": (
        "a 13-year-old Korean boy, short black hair, "
        "round glasses, green hoodie, blue jeans"
    ),
    "p1_scene": "the boy sits at a desk looking confused at a physics textbook",
    "p1_line": "전자는 공처럼 한 곳에 있는 거 아니야?",
    "p2_scene": "the boy watches a spinning coin blurring on the desk",
    "p2_line": "동전이 돌 때는 앞뒤가 정해져 있지 않네?",
    "p3_scene": "the boy points at a cloud-shaped glow around a tiny dot",
    "p3_line": "전자도 여기 있을 확률로만 알 수 있구나!",
    "p4_scene": "the boy smiles confidently with one finger raised",
    "p4_line": "관측하기 전엔 정해지지 않는 게 양자역학이야!",
}

PROMPT = TEMPLATE.format(**STORYBOARD)


# ─────────────────────────────────────────────────────────
async def generate(client, model, size, quality, run):
    tag = f"{model}__{size}__{quality}__run{run}"
    async with SEM:
        t0 = time.perf_counter()
        try:
            resp = await client.images.generate(
                model=model, prompt=PROMPT, size=size, quality=quality, n=1
            )
            elapsed = time.perf_counter() - t0
        except Exception as e:
            print(f"[FAIL] {tag}: {type(e).__name__}: {e}")
            return None

    d = resp.data[0]
    if not getattr(d, "b64_json", None):
        print(f"[SKIP] {tag}: b64 미반환")
        return None

    raw = base64.b64decode(d.b64_json)
    full = OUT / f"{tag}.png"
    full.write_bytes(raw)

    # 정확히 4등분 — 격자가 어긋나면 이 분할에서 티가 난다
    img = Image.open(io.BytesIO(raw))
    w, h = img.size
    quads = []
    for i, box in enumerate([
        (0, 0, w // 2, h // 2),          # P1 top-left
        (w // 2, 0, w, h // 2),          # P2 top-right
        (0, h // 2, w // 2, h),          # P3 bottom-left
        (w // 2, h // 2, w, h),          # P4 bottom-right
    ], start=1):
        p = OUT / f"{tag}__P{i}.png"
        img.crop(box).save(p)
        quads.append(p.name)

    print(f"[ OK ] {tag:<50} {elapsed:5.1f}s  {w}x{h}")
    return {"tag": tag, "model": model, "size": size, "quality": quality,
            "run": run, "full": full.name, "quads": quads, "sec": elapsed}


async def run_all(models, sizes, quality, runs):
    client = AsyncOpenAI(organization=os.environ.get("OPENAI_ORG_ID") or None)
    jobs = [
        generate(client, m, s, quality, r)
        for m in models for s in sizes for r in range(1, runs + 1)
    ]
    print(f"총 {len(jobs)}장 생성 (동시 {SEM._value}개 제한)\n")
    t0 = time.perf_counter()
    results = [r for r in await asyncio.gather(*jobs) if r]
    print(f"\n벽시계 {time.perf_counter() - t0:.1f}s / 성공 {len(results)}/{len(jobs)}")
    return results


# ─────────────────────────────────────────────────────────
def build_report(results):
    blocks = []
    for r in results:
        expects = [STORYBOARD[f"p{i}_scene"] for i in range(1, 5)]
        lines = [STORYBOARD[f"p{i}_line"] for i in range(1, 5)]
        quads = "".join(
            f'<figure class="q"><img src="{q}"/>'
            f'<figcaption><b>P{i}</b> 기대: {e[:38]}…<br>대사: {l}</figcaption></figure>'
            for i, (q, e, l) in enumerate(zip(r["quads"], expects, lines), start=1)
        )
        blocks.append(f"""
<h2>{r['tag']} · {r['sec']:.1f}s</h2>
<div class="pair">
  <div>
    <div class="stack">
      <img class="full" src="{r['full']}"/>
      <div class="cross"><i class="v"></i><i class="h"></i></div>
    </div>
    <p class="cap">빨간 십자선 = 정확한 50% 지점.<br>패널 경계가 선에 맞는지 확인</p>
  </div>
  <div>
    <div class="quads">{quads}</div>
    <p class="cap">자동 4분할 결과.<br>네 명이 같은 인물인지, 대사가 온전한지 확인</p>
  </div>
</div>""")

    html = f"""<!doctype html><meta charset="utf-8">
<title>Tier 1 — 2x2 검증</title>
<style>
 body{{font-family:'Noto Sans KR',sans-serif;max-width:1400px;margin:40px auto;padding:0 24px;color:#222}}
 h1{{margin-bottom:4px}}
 h2{{margin-top:56px;border-bottom:2px solid #eee;padding-bottom:8px;font-size:17px}}
 .pair{{display:flex;gap:32px;flex-wrap:wrap;align-items:flex-start}}
 .stack{{position:relative;width:480px}}
 .full{{width:100%;display:block;border:1px solid #ddd;border-radius:8px}}
 .cross{{position:absolute;inset:0;pointer-events:none}}
 .cross i{{position:absolute;background:rgba(255,0,0,.75)}}
 .cross .v{{left:50%;top:0;bottom:0;width:1px}}
 .cross .h{{top:50%;left:0;right:0;height:1px}}
 .quads{{display:grid;grid-template-columns:repeat(2,232px);gap:8px}}
 .q{{margin:0}} .q img{{width:100%;border:1px solid #ddd;border-radius:6px;display:block}}
 figcaption{{font-size:11px;color:#999;text-align:center;margin-top:4px}}
 .cap{{font-size:12px;color:#777;line-height:1.6;margin-top:10px}}
 .check{{background:#fafafa;border-left:3px solid #333;padding:14px 18px;font-size:14px;line-height:1.9}}
</style>
<h1>Tier 1 — 2x2 4컷 만화 검증</h1>
<div class="check">
 <b>판정 기준</b><br>
 ① 패널 경계가 빨간 십자선에 맞는가 → 어긋나면 오버레이 좌표 계산 불가<br>
 ② P1~P4의 인물이 동일한가 → 다르면 2x2 방식의 전제가 무너짐<br>
 ③ 말풍선 한글이 온전한가 / 분할선에 잘리지 않는가<br>
 ④ 읽기 순서(좌상→우상→좌하→우하)가 스토리 순서와 일치하는가<br>
 ⑤ 말풍선 밖에 글자가 섞였는가
</div>
{"".join(blocks)}
"""
    p = OUT / "report.html"
    p.write_text(html, encoding="utf-8")
    print(f"\n▶ 리포트: {p.resolve()}")

def summarize(results):
    import statistics
    from collections import defaultdict

    groups = defaultdict(list)
    for r in results:
        groups[(r["model"], r["size"], r["quality"])].append(r["sec"])

    print("\n── 지연시간 요약 ──")
    print(f"{'조합':<42}{'n':>3}{'평균':>8}{'최악':>8}{'4컷예상':>10}")
    for (m, s, q), secs in sorted(groups.items()):
        label = f"{m} {s} {q}"
        print(f"{label:<42}{len(secs):>3}{statistics.mean(secs):>7.1f}s"
              f"{max(secs):>7.1f}s{max(secs):>9.1f}s")

    worst = max(max(v) for v in groups.values())
    budget = 90  # Surprise Task 실연산 예산(초)
    print(f"\n최악값 {worst:.1f}s / 예산 {budget}s → "
          f"분석·검증에 남는 시간 {budget - worst:.0f}s")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["gpt-image-2"])
    ap.add_argument("--sizes", nargs="+", default=["1024x1024"])
    ap.add_argument("--quality", default="low")
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()

    print("── 사용 프롬프트 ──")
    print(PROMPT)
    print("─" * 60 + "\n")

    results = asyncio.run(run_all(args.models, args.sizes, args.quality, args.runs))
    if results:
        build_report(results)
        summarize(results)          # ← 추가
    else:
        print("생성 실패. 에러 메시지를 확인하세요.")

if __name__ == "__main__":
    main()