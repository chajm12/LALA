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
/** 호스팅 nano-omni 가 워커 한도(16/16)로 503 을 자주 내서, 같은 NIM 카탈로그의 다른 VLM 을 대체로 둔다. */
export const VISION_FALLBACK_MODEL =
  process.env.NIM_VISION_FALLBACK_MODEL ?? "meta/llama-3.2-11b-vision-instruct";
export const EMBED_MODEL =
  process.env.NIM_EMBED_MODEL ?? "nvidia/nemotron-3-embed-1b";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type ChatOptions = {
  thinking?: boolean;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  /** 호출 실패/지연 시 대신 시도할 모델 (기본: JUDGE→PLANNER) */
  fallbackModel?: string | null;
  /** 명시적 타임아웃(ms). 생략 시 max_tokens 에 비례해 자동 계산 */
  timeoutMs?: number;
  /** 1차 모델에만 적용할 짧은 타임아웃(ms). 대기열이 긴 모델을 빨리 포기하고 대체 모델로 넘어갈 때 */
  primaryTimeoutMs?: number;
  /** 에러 메시지에 붙일 단계 이름 */
  label?: string;
  onFallback?: (from: string, to: string, reason: string) => void;
};

/** 호스팅 무료 엔드포인트는 모델별로 대기열이 크게 출렁이므로 타임아웃 + 재시도 + 대체 모델을 둔다. */
const NIM_TIMEOUT_MS = Number(process.env.NIM_TIMEOUT_MS ?? 45_000);
const NIM_RETRIES = Number(process.env.NIM_RETRIES ?? 0);
/** 긴 JSON 출력(후보 5개 생성 등)은 120B 모델에서 1분을 넘기므로 max_tokens 당 25ms 를 더 준다 */
const NIM_MS_PER_TOKEN = Number(process.env.NIM_MS_PER_TOKEN ?? 25);

function timeoutFor(opts: ChatOptions) {
  return opts.timeoutMs ?? Math.max(NIM_TIMEOUT_MS, (opts.maxTokens ?? 8192) * NIM_MS_PER_TOKEN);
}

function defaultFallback(model: string) {
  if (model === JUDGE_MODEL && JUDGE_MODEL !== PLANNER_MODEL) return PLANNER_MODEL;
  if (model === PLANNER_MODEL && JUDGE_MODEL !== PLANNER_MODEL) return JUDGE_MODEL;
  return null;
}

async function chatOnce(model: string, messages: Msg[], opts: ChatOptions, timeoutOverride?: number) {
  const completion = await nim.chat.completions.create(
    {
      model,
      messages,
      temperature: opts.temperature ?? 0.6,
      top_p: 0.95,
      max_tokens: opts.maxTokens ?? 8192,
      ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
      // @ts-expect-error NVIDIA 확장 필드: Nemotron 3.x reasoning on/off
      chat_template_kwargs: { enable_thinking: opts.thinking ?? false },
    },
    { timeout: timeoutOverride ?? timeoutFor(opts), maxRetries: 0 },
  );
  return completion.choices[0]?.message?.content ?? "";
}

function isRetryable(e: unknown) {
  const status = (e as { status?: number })?.status;
  const name = (e as { name?: string })?.name ?? "";
  const message = (e as { message?: string })?.message ?? "";
  return (
    /timeout|timed out|connection|ECONNRESET|fetch failed/i.test(`${name} ${message}`) ||
    status === 429 ||
    (status !== undefined && status >= 500)
  );
}

export async function chat(model: string, messages: Msg[], opts: ChatOptions = {}) {
  let lastError: unknown;
  const fallbackCandidate = opts.fallbackModel === undefined ? defaultFallback(model) : opts.fallbackModel;
  const primaryTimeout = fallbackCandidate && opts.primaryTimeoutMs ? Math.min(opts.primaryTimeoutMs, timeoutFor(opts)) : undefined;
  for (let attempt = 0; attempt <= NIM_RETRIES; attempt++) {
    try {
      return await chatOnce(model, messages, opts, primaryTimeout);
    } catch (e) {
      lastError = e;
      if (!isRetryable(e)) throw e;
      if (attempt < NIM_RETRIES) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  const fallback = opts.fallbackModel === undefined ? defaultFallback(model) : opts.fallbackModel;
  if (fallback) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    opts.onFallback?.(model, fallback, reason);
    try {
      return await chatOnce(fallback, messages, opts);
    } catch (e) {
      lastError = e;
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${opts.label ? `[${opts.label}] ` : ""}${model}${fallback ? ` 및 대체 모델 ${fallback}` : ""} 호출 실패 (${Math.round(timeoutFor(opts) / 1000)}초 제한): ${msg}. NVIDIA 호스팅 엔드포인트가 혼잡할 때 생기며, 잠시 후 다시 시도하거나 .env 의 NIM_TIMEOUT_MS 를 늘려보세요.`);
}

/** 모델이 가끔 붙이는 주석/trailing comma/코드펜스를 걷어내고 파싱 */
export function parseJsonObjectFromText(text: string | null | undefined) {
  const source = text && text.length > 0 ? text.trim() : "{}";
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const jsonLike = fenced ?? source;
  const start = jsonLike.indexOf("{");
  const end = jsonLike.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  const slice = jsonLike.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    const repaired = slice
      .replace(/\/\/[^\n]*$/gm, "")          // 줄 주석
      .replace(/\/\*[\s\S]*?\*\//g, "")   // 블록 주석
      .replace(/,\s*([}\]])/g, "$1");     // trailing comma
    return JSON.parse(repaired);
  }
}

export async function chatJson<T = Record<string, unknown>>(
  model: string,
  messages: Msg[],
  opts: Omit<ChatOptions, "thinking" | "json"> = {},
): Promise<T> {
  const text = await chat(model, messages, { ...opts, thinking: false, json: true });
  try {
    return parseJsonObjectFromText(text) as T;
  } catch {
    // 파싱 실패 시 한 번 더 (temperature 낮춰서)
    const retry = await chat(model, [...messages, { role: "user", content: "위 응답이 유효한 JSON 이 아니었어. 설명 없이 JSON 객체만 다시 출력해." }], { ...opts, temperature: 0.1, thinking: false, json: true });
    return parseJsonObjectFromText(retry) as T;
  }
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
