/**
 * 룩북 이미지 생성 도구 — 제공자 교체 가능.
 *
 * IMAGE_PROVIDER=nvidia : NVIDIA 호스팅 FLUX.1-dev (응답: artifacts[0].base64). 검증 완료.
 *   다른 모델을 쓰려면 NVIDIA_IMAGE_INVOKE_URL / NVIDIA_IMAGE_EXTRA_JSON 으로 덮어쓴다.
 *   본선(L40S)에서는 FLUX / SD3.5 NIM 컨테이너를 직접 띄우고 같은 env 만 바꾸면 된다.
 * IMAGE_PROVIDER=openai : 기존 gpt-image (예선 초반 fallback).
 */
export type GenerateResult = { imageUrl: string | null; error: string | null; provider: string };

const PROVIDER = process.env.IMAGE_PROVIDER ?? "nvidia";

export async function generateImage(prompt: string, size = 1024): Promise<GenerateResult> {
  try {
    if (PROVIDER === "openai") return await viaOpenAI(prompt, size);
    return await viaNvidia(prompt, size);
  } catch (e) {
    return { imageUrl: null, error: e instanceof Error ? e.message : "이미지 생성 중 알 수 없는 오류", provider: PROVIDER };
  }
}

async function viaNvidia(prompt: string, size: number): Promise<GenerateResult> {
  // 기본: NVIDIA 호스팅 FLUX.1-dev (ai.api.nvidia.com/v1/genai/...). 본선에서 자체 NIM 컨테이너로 바꾸려면 env 만 교체.
  const invokeUrl = process.env.NVIDIA_IMAGE_INVOKE_URL ?? "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev";
  const body: Record<string, unknown> = {
    prompt,               // FLUX 는 prompt 필드 하나만 받는다 (text_prompts 병행 시 422)
    mode: "base",
    width: size,
    height: size,
    cfg_scale: 3.5,
    steps: 30,
    seed: Math.floor(Math.random() * 1_000_000),
  };
  // 모델별 추가 파라미터를 JSON 으로 덮어쓸 수 있게 (예: {"steps":30,"cfg_scale":5})
  if (process.env.NVIDIA_IMAGE_EXTRA_JSON) Object.assign(body, JSON.parse(process.env.NVIDIA_IMAGE_EXTRA_JSON));

  const res = await fetch(invokeUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY ?? ""}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`NVIDIA 이미지 생성 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { artifacts?: { finishReason?: string }[] };
  const finish = json.artifacts?.[0]?.finishReason;
  if (finish && finish !== "SUCCESS") throw new Error(`이미지 생성 거부됨: ${finish}`); // CONTENT_FILTERED → 검은 이미지가 오므로 실패로 처리
  const b64 = findBase64Image(json);
  if (!b64) throw new Error("응답에서 이미지 데이터를 찾지 못했어요");
  return { imageUrl: b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`, error: null, provider: "nvidia" };
}

/** 응답 구조가 모델마다 달라서 (artifacts[].base64 / image / b64_json / data[].b64_json ...) 재귀 탐색 */
function findBase64Image(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of ["b64_json", "base64", "image", "b64_image", "b64"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 1000) return v;
  }
  for (const v of Object.values(obj)) {
    const found = findBase64Image(v, depth + 1);
    if (found) return found;
  }
  return null;
}

async function viaOpenAI(prompt: string, size: number): Promise<GenerateResult> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const image = await client.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2",
    prompt,
    size: `${size}x${size}` as "1024x1024",
    n: 1,
  });
  const b64 = image.data?.[0]?.b64_json;
  return { imageUrl: b64 ? `data:image/png;base64,${b64}` : null, error: b64 ? null : "빈 응답", provider: "openai" };
}
