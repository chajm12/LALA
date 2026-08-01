"""
Tier 2 — 장면 서술 규칙 A/B + 비전 검증기 프로토타입

Tier 1에서 확인된 문제: "도는 동전"이 9장 중 2장만 의도대로 나옴.
원인 가설: 프롬프트가 '개념'을 서술하고 '시각'을 서술하지 않았다.

이 스크립트가 검증하는 것:
  1. 시각형 서술(B)이 개념형 서술(A)보다 성공률이 높은가
  2. 비전 모델이 "이 패널이 의도대로 그려졌는가"를 사람만큼 판정하는가
     → 이 판정기가 그대로 본선 파이프라인의 검증 도구가 된다

사용법:
    python tier2_test.py                 # A/B 각 3회 = 6장
    python tier2_test.py --runs 4
    python tier2_test.py --judge gpt-5.2 # 판정 모델 직접 지정
"""

import argparse
import asyncio
import base64
import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

OUT = Path(__file__).parent / "_tier2"
OUT.mkdir(exist_ok=True)
SEM = asyncio.Semaphore(4)

SIZE = "1536x1024"      # Tier 1 결과 채택
QUALITY = "low"
IMAGE_MODEL = "gpt-image-2"

# 판정 모델은 시점마다 다르므로 후보를 순회한다
JUDGE_CANDIDATES = ["gpt-5.2", "gpt-5.6", "gpt-5.5", "gpt-5", "gpt-4.1"]

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

CHARACTER = ("a 13-year-old Korean boy, short black hair, "
             "round glasses, green hoodie, blue jeans")

LINES = {
    "p1_line": "전자는 공처럼 한 곳에 있는 거 아니야?",
    "p2_line": "동전이 돌 때는 앞뒤가 정해져 있지 않네?",
    "p3_line": "전자도 여기 있을 확률로만 알 수 있구나!",
    "p4_line": "관측하기 전엔 정해지지 않는 게 양자역학이야!",
}

# ── A: 개념형 서술 (Tier 1 원본) ──────────────────────────
VARIANT_A = {
    "p1_scene": "the boy sits at a desk looking confused at a physics textbook",
    "p2_scene": "the boy watches a spinning coin blurring on the desk",
    "p3_scene": "the boy points at a cloud-shaped glow around a tiny dot",
    "p4_scene": "the boy smiles confidently with one finger raised",
}

# ── B: 시각형 서술 (물리적 자세를 명시) ────────────────────
VARIANT_B = {
    "p1_scene": ("the boy sits at a desk, one hand on his cheek, eyebrows "
                 "furrowed, staring down at an open textbook"),
    "p2_scene": ("the boy leans over a desk watching a coin spinning so fast "
                 "on its edge that its surface is a blurred translucent smear "
                 "with NO readable design, portrait, or lettering on it; "
                 "its outline is doubled and ghosted from motion, tilted and "
                 "wobbling, with concentric motion rings on the desk beneath"),
    "p3_scene": ("the boy points his index finger at a soft blurry blue "
                 "sphere of light with one small solid dot at its center"),
    "p4_scene": ("the boy faces forward smiling with his mouth open, "
                 "right index finger raised above shoulder height"),
}

# 각 패널에서 '반드시 보여야 하는 것' — 비전 판정 기준
CRITERIA = [
    "The boy sits at a desk with an open book and looks confused or puzzled.",
    "A coin stands upright on its edge (not lying flat) AND its surface is "
    "motion-blurred with no readable design or portrait. "
    "If the coin's face is sharp and readable, this FAILS.",
    "The boy points at a blurry glowing sphere or cloud with a dot inside.",
    "The boy faces forward smiling with one index finger raised.",
]


# ─────────────────────────────────────────────────────────
async def generate(client, variant, scenes, run):
    tag = f"{variant}_run{run}"
    prompt = TEMPLATE.format(character=CHARACTER, **scenes, **LINES)
    async with SEM:
        t0 = time.perf_counter()
        try:
            resp = await client.images.generate(
                model=IMAGE_MODEL, prompt=prompt, size=SIZE,
                quality=QUALITY, n=1,
            )
        except Exception as e:
            print(f"[FAIL] {tag}: {type(e).__name__}: {e}")
            return None
        sec = time.perf_counter() - t0

    b64 = resp.data[0].b64_json
    path = OUT / f"{tag}.png"
    path.write_bytes(base64.b64decode(b64))
    print(f"[ OK ] {tag:<20} {sec:5.1f}s")
    return {"tag": tag, "variant": variant, "run": run,
            "file": path.name, "b64": b64, "sec": sec}


# ── 비전 검증기 — 본선 파이프라인에 그대로 들어갈 코드 ──────
JUDGE_PROMPT = """You are checking whether a generated 4-panel comic matches
the intended scenes. The image is a 2x2 grid read as:
P1 top-left, P2 top-right, P3 bottom-left, P4 bottom-right.

Required content for each panel:
{criteria}

For each panel answer strictly whether the requirement is satisfied.
Be strict: if a coin is lying flat instead of standing on its edge, that FAILS.

Respond with JSON only, no markdown:
{{"panels": [{{"panel": 1, "pass": true, "reason": "..."}}, ...]}}"""


async def judge(client, model, item):
    crit = "\n".join(f"P{i}: {c}" for i, c in enumerate(CRITERIA, 1))
    try:
        resp = await client.responses.create(
            model=model,
            input=[{"role": "user", "content": [
                {"type": "input_text",
                 "text": JUDGE_PROMPT.format(criteria=crit)},
                {"type": "input_image",
                 "image_url": f"data:image/png;base64,{item['b64']}"},
            ]}],
        )
        txt = resp.output_text.replace("```json", "").replace("```", "").strip()
        return json.loads(txt)["panels"]
    except Exception as e:
        print(f"[JUDGE FAIL] {item['tag']}: {type(e).__name__}: {str(e)[:100]}")
        return None


async def pick_judge(client):
    for m in JUDGE_CANDIDATES:
        try:
            await client.responses.create(model=m, input="ok")
            print(f"[판정 모델] {m}")
            return m
        except Exception:
            continue
    print("[WARN] 판정 모델을 찾지 못했습니다. --judge 로 직접 지정하세요.")
    return None


# ─────────────────────────────────────────────────────────
def report(items, judged):
    rows = []
    stats = {"A": [0, 0], "B": [0, 0]}   # [통과 패널 수, 전체 패널 수]
    p2 = {"A": [0, 0], "B": [0, 0]}      # P2(동전)만 따로

    for it in items:
        verdicts = judged.get(it["tag"])
        cells = ""
        if verdicts:
            for v in verdicts:
                ok = v.get("pass")
                stats[it["variant"]][1] += 1
                stats[it["variant"]][0] += bool(ok)
                if v.get("panel") == 2:
                    p2[it["variant"]][1] += 1
                    p2[it["variant"]][0] += bool(ok)
                cells += (f'<li class="{"ok" if ok else "no"}">'
                          f'P{v.get("panel")} {"통과" if ok else "실패"} — '
                          f'{v.get("reason","")}</li>')
        else:
            cells = "<li>판정 없음</li>"

        rows.append(f"""<div class="card">
  <h3>{it['tag']} · {it['sec']:.1f}s</h3>
  <img src="{it['file']}"/>
  <ul>{cells}</ul>
</div>""")

    def pct(a):
        return f"{a[0]}/{a[1]} ({100*a[0]/a[1]:.0f}%)" if a[1] else "n/a"

    summary = f"""<table>
<tr><th></th><th>전체 패널 통과</th><th>P2(동전) 통과</th></tr>
<tr><td><b>A 개념형</b></td><td>{pct(stats['A'])}</td><td>{pct(p2['A'])}</td></tr>
<tr><td><b>B 시각형</b></td><td>{pct(stats['B'])}</td><td>{pct(p2['B'])}</td></tr>
</table>"""

    print("\n── 판정 요약 ──")
    print(f"A 개념형: 전체 {pct(stats['A'])} / P2 {pct(p2['A'])}")
    print(f"B 시각형: 전체 {pct(stats['B'])} / P2 {pct(p2['B'])}")

    html = f"""<!doctype html><meta charset="utf-8"><title>Tier 2</title>
<style>
body{{font-family:'Noto Sans KR',sans-serif;max-width:1300px;margin:36px auto;padding:0 20px}}
table{{border-collapse:collapse;margin:16px 0}}
th,td{{border:1px solid #ddd;padding:8px 16px;text-align:center;font-size:14px}}
.grid{{display:flex;flex-wrap:wrap;gap:20px}}
.card{{width:600px}} .card img{{width:100%;border:1px solid #ddd;border-radius:8px}}
h3{{font-size:14px;margin:0 0 8px}}
ul{{list-style:none;padding:0;font-size:12px;line-height:1.7}}
.ok{{color:#0a7}} .no{{color:#d33;font-weight:600}}
</style>
<h1>Tier 2 — 장면 서술 A/B + 비전 검증</h1>
{summary}
<p style="font-size:13px;color:#666">각 이미지의 판정 결과가 실제와 맞는지 눈으로 대조하십시오.
비전 판정이 틀리면 검증기를 본선에 쓸 수 없습니다.</p>
<div class="grid">{"".join(rows)}</div>"""
    p = OUT / "report.html"
    p.write_text(html, encoding="utf-8")
    print(f"\n▶ 리포트: {p.resolve()}")


async def main_async(runs, judge_model):
    client = AsyncOpenAI(organization=os.environ.get("OPENAI_ORG_ID") or None)

    jobs = ([generate(client, "A", VARIANT_A, r) for r in range(1, runs + 1)]
            + [generate(client, "B", VARIANT_B, r) for r in range(1, runs + 1)])
    print(f"이미지 {len(jobs)}장 생성\n")
    t0 = time.perf_counter()
    items = [i for i in await asyncio.gather(*jobs) if i]
    print(f"벽시계 {time.perf_counter()-t0:.1f}s / 성공 {len(items)}/{len(jobs)}")

    if not items:
        return
    jm = judge_model or await pick_judge(client)
    judged = {}
    if jm:
        print("\n비전 판정 중...")
        verdicts = await asyncio.gather(*[judge(client, jm, i) for i in items])
        judged = {i["tag"]: v for i, v in zip(items, verdicts) if v}
    report(items, judged)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--judge", default=None)
    args = ap.parse_args()
    asyncio.run(main_async(args.runs, args.judge))


if __name__ == "__main__":
    main()