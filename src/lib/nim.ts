import OpenAI from "openai";

/**
 * NVIDIA NIM client.
 *
 * 예선: build.nvidia.com 호스팅 엔드포인트 (NVIDIA_BASE_URL 기본값).
 * 본선: L40S 위에 NIM 컨테이너를 직접 띄우면 NVIDIA_BASE_URL만
 *       http://<host>:8000/v1 로 바꾸면 코드 수정 없이 동일하게 동작.
 */
export const NVIDIA_BASE_URL =
  process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";

export const nim = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY ?? "missing-nvidia-api-key",
  baseURL: NVIDIA_BASE_URL,
});

// 역할별 모델. 큰 모델 하나로 다 하지 않고 역할을 나누는 것이 핵심.
// PLANNER  : 계획/후보 생성/수정 (tool calling, 긴 컨텍스트)
// JUDGE    : 평가·채점·리랭킹 (빠르고 저렴한 30B A3B MoE)
// VISION   : 룩북 이미지 검증 (omni-modal)
// EMBED    : 카탈로그 검색용 임베딩 (query/passage 모드 필수)
export const PLANNER_MODEL =
  process.env.NIM_PLANNER_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
export const JUDGE_MODEL =
  process.env.NIM_JUDGE_MODEL ?? "nvidia/nemotron-3.5-lightning-30b-a3b";
export const VISION_MODEL =
  process.env.NIM_VISION_MODEL ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
export const EMBED_MODEL =
  process.env.NIM_EMBED_MODEL ?? "nvidia/nemotron-3-embed-1b";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Nemotron 3.x 는 chat_template_kwargs.enable_thinking 로 reasoning 을 켜고 끈다.
 * JSON 만 받아야 하는 호출은 thinking 을 끄는 편이 안정적이다.
 */
export async function chat(
  model: string,
  messages: Msg[],
  opts: { thinking?: boolean; temperature?: number; maxTokens?: number } = {},
) {
  const completion = await nim.chat.completions.create({
    model,
    messages,
    temperature: opts.temperature ?? 0.6,
    top_p: 0.95,
    max_tokens: opts.maxTokens ?? 8192,
    // @ts-expect-error NVIDIA 확장 필드
    chat_template_kwargs: { enable_thinking: opts.thinking ?? false },
  });
  return completion.choices[0]?.message?.content ?? "";
}

export function parseJsonObjectFromText(text: string | null | undefined) {
  const source = text && text.length > 0 ? text.trim() : "{}";
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const jsonLike = fenced ?? source;
  const start = jsonLike.indexOf("{");
  const end = jsonLike.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  return JSON.parse(jsonLike.slice(start, end + 1));
}

export async function chatJson<T = Record<string, unknown>>(
  model: string,
  messages: Msg[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<T> {
  const text = await chat(model, messages, { ...opts, thinking: false });
  return parseJsonObjectFromText(text) as T;
}

/**
 * nemotron-3-embed-1b 는 input_type 이 필수 (query | passage).
 * 인덱싱 = passage, 검색 질의 = query. 틀리면 검색 정확도가 크게 떨어진다.
 */
export async function embed(
  inputs: string[],
  inputType: "query" | "passage",
): Promise<number[][]> {
  const res = await nim.embeddings.create({
    model: EMBED_MODEL,
    input: inputs,
    encoding_format: "float",
    // @ts-expect-error NVIDIA 확장 필드
    input_type: inputType,
    truncate: "END",
  });
  return res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding as number[]);
}
