"""
AGENT:24 사전 점검 — 이미지 생성 API 접근성 / 지연시간 진단

사용법:
    pip install openai python-dotenv
    python cartoon.py            # 접근성 점검만
    python cartoon.py --bench 10 # 지연시간 10회 측정까지

.env 예시 (반드시 '팀 org' 기준으로):
    OPENAI_API_KEY=sk-proj-...
    OPENAI_ORG_ID=org-...
"""

import argparse
import asyncio
import base64
import os
import statistics
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import AsyncOpenAI, OpenAI

load_dotenv()

OUT = Path("_probe_out")
OUT.mkdir(exist_ok=True)

# 실제 사용 가능한 모델명은 시점에 따라 다르므로 후보를 순회하며 확인한다.
CANDIDATE_MODELS = [
    "gpt-image-1",
    "gpt-image-1-mini",
    "gpt-image-2",
    "dall-e-3",
]

# 4컷 만화 한 컷을 가정한 실전 프롬프트 (말풍선/텍스트 없이 생성)
PROMPT = (
    "Simple flat vector illustration, children's educational comic style. "
    "A curious student character looking at a glowing lightbulb. "
    "Clean solid background. Yes text, Yes letters, Yes speech bubbles. "
    "Leave the top third of the image as empty plain background."
)


# ─────────────────────────────────────────────────────────
# 0. 환경 확인
# ─────────────────────────────────────────────────────────
def check_env():
    key = os.environ.get("OPENAI_API_KEY")
    org = os.environ.get("OPENAI_ORG_ID")

    if not key:
        sys.exit("[FAIL] OPENAI_API_KEY 없음. .env 파일과 위치를 확인하세요.")

    print(f"[ OK ] API key   : {key[:10]}...")
    masked = f"{org[:7]}...{org[-3:]}" if org else None
    print(f"[{'OK ' if org else 'WARN'}] org id    : {masked or '미지정 (기본 org로 호출됨)'}")
    if not org:
        print("       └ 팀 org 기준으로 테스트하려면 OPENAI_ORG_ID를 반드시 지정하세요.")
    return OpenAI(organization=org) if org else OpenAI()


# ─────────────────────────────────────────────────────────
# 1. 접근 가능한 이미지 모델 탐색
# ─────────────────────────────────────────────────────────
def list_image_models(client):
    print("\n── 1. 모델 목록 조회 ──")
    try:
        ids = sorted(m.id for m in client.models.list().data)
    except Exception as e:
        print(f"[FAIL] 모델 목록 조회 실패: {type(e).__name__}: {e}")
        return []

    image_like = [m for m in ids if "image" in m or "dall" in m]
    print(f"[ OK ] 전체 {len(ids)}개 모델 접근 가능")
    print(f"       이미지 관련: {image_like or '없음'}")
    return image_like


# ─────────────────────────────────────────────────────────
# 2. 실제 생성 1회 — 에러 원인 분류가 핵심
# ─────────────────────────────────────────────────────────
def diagnose(e):
    """실패 원인을 대회 대응 관점에서 분류한다."""
    msg = str(e).lower()
    if "verif" in msg or "not allowed to sample" in msg:
        return "조직 인증 필요 — Platform > Settings > Organization 에서 즉시 신청할 것"
    if "does not exist" in msg or "model_not_found" in msg or "invalid model" in msg:
        return "모델명 오류 — 위 1단계 목록에 있는 이름으로 교체"
    if "quota" in msg or "billing" in msg or "credit" in msg:
        return "크레딧/결제 문제 — org에 크레딧이 지급됐는지 확인"
    if "rate limit" in msg or "429" in msg:
        return "레이트 리밋 — 병렬 호출 수를 줄여야 함 (대회 당일 치명적)"
    if "permission" in msg or "403" in msg:
        return "권한 문제 — API 키의 프로젝트 스코프 확인"
    return "원인 불명 — 메시지 전문을 그대로 Discord #code 채널에 문의"


def try_generate(client, model, quality=None, size="1024x1024"):
    kwargs = dict(model=model, prompt=PROMPT, size=size, n=1)
    if quality:
        kwargs["quality"] = quality

    t0 = time.perf_counter()
    resp = client.images.generate(**kwargs)
    elapsed = time.perf_counter() - t0

    d = resp.data[0]
    if getattr(d, "b64_json", None):
        raw = base64.b64decode(d.b64_json)
        path = OUT / f"{model}_{quality or 'default'}.png"
        path.write_bytes(raw)
        return elapsed, f"{len(raw)//1024}KB → {path}"
    return elapsed, f"URL 반환: {getattr(d, 'url', '?')[:60]}"


def probe_models(client, discovered):
    print("\n── 2. 이미지 생성 실호출 ──")
    targets = discovered or CANDIDATE_MODELS
    working = []

    for model in targets:
        # quality 파라미터는 모델마다 허용값이 다르므로 낮은 것부터 시도
        for quality in ["low", "standard", None]:
            try:
                elapsed, info = try_generate(client, model, quality)
                label = f"{model} (quality={quality or '기본'})"
                print(f"[ OK ] {label:<40} {elapsed:6.1f}s  {info}")
                working.append((model, quality))
                break
            except Exception as e:
                if quality is None:  # 마지막 시도까지 실패
                    print(f"[FAIL] {model}")
                    print(f"       {type(e).__name__}: {str(e)[:160]}")
                    print(f"       ▶ {diagnose(e)}")

    return working


# ─────────────────────────────────────────────────────────
# 3. 지연시간 측정 — 평균이 아니라 '최악값'이 중요하다
# ─────────────────────────────────────────────────────────
async def one_call(aclient, model, quality, idx):
    t0 = time.perf_counter()
    kwargs = dict(model=model, prompt=PROMPT, size="1024x1024", n=1)
    if quality:
        kwargs["quality"] = quality
    try:
        await aclient.images.generate(**kwargs)
        return time.perf_counter() - t0
    except Exception as e:
        print(f"   [{idx}] 실패: {type(e).__name__}: {str(e)[:80]}")
        return None


async def bench(model, quality, n, org):
    aclient = AsyncOpenAI(organization=org) if org else AsyncOpenAI()

    print(f"\n── 3-1. 순차 {n}회 (편차 확인) ──")
    seq = []
    for i in range(n):
        t = await one_call(aclient, model, quality, i)
        if t:
            seq.append(t)
            print(f"   [{i}] {t:5.1f}s")

    if seq:
        print(f"\n   평균 {statistics.mean(seq):.1f}s / "
              f"중앙 {statistics.median(seq):.1f}s / "
              f"최악 {max(seq):.1f}s")
        print(f"   ▶ 4컷 순차 예상: {max(seq)*4:.0f}s  (2분 예산 대비)")

    print(f"\n── 3-2. 병렬 4회 (실전 구조) ──")
    t0 = time.perf_counter()
    results = await asyncio.gather(*[one_call(aclient, model, quality, i) for i in range(4)])
    wall = time.perf_counter() - t0
    ok = [r for r in results if r]
    print(f"   벽시계 {wall:.1f}s / 성공 {len(ok)}/4")

    print("\n── 판정 ──")
    if not seq:
        print("   ✗ 생성 자체가 실패. 만화 아이디어 보류.")
    elif wall <= 40 and len(ok) == 4:
        print("   ✓ 병렬 4컷이 40초 이내. 진행 가능.")
    elif wall <= 70:
        print("   △ 아슬아슬. 폴백 렌더러 필수.")
    else:
        print("   ✗ 2분 예산 초과 위험. 컷 수를 줄이거나 주제 재고.")


# ─────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench", type=int, default=0, help="지연 측정 반복 횟수")
    args = ap.parse_args()

    client = check_env()
    discovered = list_image_models(client)
    working = probe_models(client, discovered)

    if not working:
        print("\n[결론] 사용 가능한 이미지 모델 없음. 위 진단 메시지를 먼저 해결하세요.")
        return

    if args.bench:
        model, quality = working[0]
        print(f"\n[벤치 대상] {model} (quality={quality or '기본'})")
        asyncio.run(bench(model, quality, args.bench, os.environ.get("OPENAI_ORG_ID")))
    else:
        print("\n[다음] python check_image_api.py --bench 10 으로 지연시간을 측정하세요.")


if __name__ == "__main__":
    main()