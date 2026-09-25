/**
 * 룩북 이미지 생성 도구 — 제공자 교체 가능.
 *
 * IMAGE_PROVIDER=nvidia : NVIDIA 호스팅 이미지 생성 NIM (cosmos3-nano 등).
 *   build.nvidia.com 은 로그인 후 Playground 에서 정확한 invoke URL/요청 형식을 보여주므로
 *   NVIDIA_IMAGE_INVOKE_URL 을 env 로 받고, 응답에서 base64 이미지를 찾아낸다.
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
  const invokeUrl = process.env.NVIDIA_IMAGE_INVOKE_URL;
  if (!invokeUrl) {
    throw new Error("NVIDIA_IMAGE_INVOKE_URL 이 설정되지 않았어요 (.env 참고). 임시로 IMAGE_PROVIDER=openai 를 쓸 수 있어요.");
  }
  const body: Record<string, unknown> = {
    prompt,
    negative_prompt: "blurry, distorted body, extra limbs, cropped head, cropped feet, text, watermark, nsfw",
    width: size,
    height: size,
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
  const json = (await res.json()) as unknown;
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
