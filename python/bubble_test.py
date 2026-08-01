"""
말풍선 처리 방식 비교 테스트

세 가지를 한 번에 검증한다:
  A. 말풍선 없이 상단을 비운 그림  → 코드 합성용 (권장안)
  B. 빈 말풍선을 모델이 그린 그림  → 3회 반복해 '위치가 매번 달라지는지' 확인
  C. 한글 대사를 모델이 직접 쓴 그림 → 한글이 깨지는지 확인

결과는 _bubble_test/report.html 에 나란히 정리된다.
A 이미지 위에 코드로 말풍선을 얹은 데모도 함께 렌더링되므로,
"모델에 맡기기 vs 코드로 그리기" 를 눈으로 바로 비교할 수 있다.

사용법:
    python bubble_test.py
    python bubble_test.py --models gpt-image-1 gpt-image-2
"""

import argparse
import asyncio
import base64
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

OUT = Path("_bubble_test")
OUT.mkdir(exist_ok=True)

TESTS = {
    "A_말풍선없음": (
        "Flat vector comic panel, children's educational style. "
        "A student character standing in the lower half of the frame. "
        "The upper 40% must be plain empty background with nothing in it. "
        "Absolutely no text, no letters, no numbers, no speech bubbles, no signs."
    ),
    "B_빈말풍선": (
        "Flat vector comic panel, children's educational style. "
        "A student character in the lower half. "
        "One empty white speech bubble in the upper left, no text inside."
    ),
    "C_한글대사": (
        "Flat vector comic panel, children's educational style. "
        "A student character with a speech bubble "
        "containing the Korean text: 어텐션이 뭐야?"
    ),
}

# B는 말풍선 '위치 편차'를 보는 것이 목적이므로 여러 번 돌린다
REPEATS = {"B_빈말풍선": 3}


async def generate(client, model, name, prompt, idx):
    tag = f"{model}__{name}" + (f"_{idx}" if idx else "")
    t0 = time.perf_counter()
    try:
        resp = await client.images.generate(
            model=model, prompt=prompt, size="1024x1024", quality="low", n=1
        )
        elapsed = time.perf_counter() - t0
        d = resp.data[0]
        if not getattr(d, "b64_json", None):
            print(f"[SKIP] {tag}: b64 미반환")
            return None
        path = OUT / f"{tag}.png"
        path.write_bytes(base64.b64decode(d.b64_json))
        print(f"[ OK ] {tag:<45} {elapsed:5.1f}s")
        return {"tag": tag, "model": model, "name": name, "file": path.name, "sec": elapsed}
    except Exception as e:
        print(f"[FAIL] {tag}: {type(e).__name__}: {str(e)[:120]}")
        return None


async def run(models):
    client = AsyncOpenAI(organization=os.environ.get("OPENAI_ORG_ID") or None)

    jobs = []
    for model in models:
        for name, prompt in TESTS.items():
            for i in range(REPEATS.get(name, 1)):
                jobs.append(generate(client, model, name, prompt, i + 1 if REPEATS.get(name) else 0))

    print(f"총 {len(jobs)}장 생성 (병렬)\n")
    t0 = time.perf_counter()
    results = [r for r in await asyncio.gather(*jobs) if r]
    print(f"\n벽시계 {time.perf_counter() - t0:.1f}s / 성공 {len(results)}/{len(jobs)}")
    return results


# ── 권장안 시연: A 이미지 위에 코드로 말풍선을 얹는다 ──────────────
BUBBLE_SVG = """
<svg class="overlay" viewBox="0 0 1024 1024">
  <ellipse cx="330" cy="180" rx="270" ry="120"
           fill="white" stroke="#222" stroke-width="6"/>
  <path d="M270 285 L300 400 L390 292 Z"
        fill="white" stroke="#222" stroke-width="6"/>
  <text x="330" y="165" text-anchor="middle"
        font-family="'Noto Sans KR','Malgun Gothic',sans-serif"
        font-size="58" fill="#111">어텐션이</text>
  <text x="330" y="235" text-anchor="middle"
        font-family="'Noto Sans KR','Malgun Gothic',sans-serif"
        font-size="58" fill="#111">뭐야?</text>
</svg>
"""


def build_report(results):
    by_name = {}
    for r in results:
        by_name.setdefault(r["name"], []).append(r)

    blocks = []

    # 권장안 데모를 맨 위에
    a_imgs = by_name.get("A_말풍선없음", [])
    if a_imgs:
        demo = "".join(
            f'<figure class="card"><div class="stack">'
            f'<img src="{r["file"]}"/>{BUBBLE_SVG}</div>'
            f'<figcaption>{r["model"]} · 코드 합성</figcaption></figure>'
            for r in a_imgs
        )
        blocks.append(
            "<h2>★ 권장안 — A 이미지 + 코드로 그린 말풍선</h2>"
            "<p>한글이 정확하고, 위치가 고정이며, 대사만 바꿔도 이미지 재생성이 불필요합니다.</p>"
            f'<div class="row">{demo}</div>'
        )

    for name in TESTS:
        items = by_name.get(name, [])
        if not items:
            continue
        cards = "".join(
            f'<figure class="card"><img src="{r["file"]}"/>'
            f'<figcaption>{r["model"]} · {r["sec"]:.1f}s</figcaption></figure>'
            for r in items
        )
        note = {
            "A_말풍선없음": "상단이 실제로 비었는지, 글자가 섞이지 않았는지 확인",
            "B_빈말풍선": "3장의 말풍선 위치·크기가 서로 다른지 확인 → 다르면 좌표를 알 수 없다는 증거",
            "C_한글대사": "한글이 깨졌는지 확인",
        }[name]
        blocks.append(f"<h2>{name}</h2><p>{note}</p><div class='row'>{cards}</div>")

    html = f"""<!doctype html><meta charset="utf-8">
<title>말풍선 테스트</title>
<style>
 body{{font-family:'Noto Sans KR',sans-serif;max-width:1200px;margin:40px auto;padding:0 20px;color:#222}}
 h2{{margin-top:48px;border-bottom:2px solid #eee;padding-bottom:8px}}
 p{{color:#666;font-size:14px}}
 .row{{display:flex;flex-wrap:wrap;gap:16px}}
 .card{{margin:0;width:320px}}
 .card img{{width:100%;border:1px solid #ddd;border-radius:8px;display:block}}
 figcaption{{font-size:12px;color:#888;margin-top:6px;text-align:center}}
 .stack{{position:relative}}
 .stack .overlay{{position:absolute;inset:0;width:100%;height:100%}}
</style>
<h1>말풍선 처리 방식 비교</h1>
{"".join(blocks)}
"""
    path = OUT / "report.html"
    path.write_text(html, encoding="utf-8")
    print(f"\n▶ 결과 리포트: {path.resolve()}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["gpt-image-1", "gpt-image-2"])
    args = ap.parse_args()

    results = asyncio.run(run_all(args.models, args.sizes, args.quality, args.runs))
    if results:
        build_report(results)
        summarize(results)          # ← 추가
    else:
        print("생성 실패. 에러 메시지를 확인하세요.")


if __name__ == "__main__":
    main()