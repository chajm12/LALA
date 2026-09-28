import OpenAI from "openai";

export const NVIDIA_BASE_URL =
  process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const DEFAULT_NEMOTRON_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
function resolveMainModel(value: string | undefined) {
  return !value || value === "openai/gpt-oss-20b" ? DEFAULT_NEMOTRON_MODEL : value;
}

export const NVIDIA_TEXT_MODEL = resolveMainModel(process.env.NVIDIA_TEXT_MODEL);
export const NVIDIA_PLAN_MODEL = resolveMainModel(process.env.NVIDIA_PLAN_MODEL);
export const NVIDIA_AGENT_MODEL = resolveMainModel(process.env.NVIDIA_AGENT_MODEL);
export const NVIDIA_VISION_MODEL =
  process.env.NVIDIA_VISION_MODEL ?? "moonshotai/kimi-k3";
export const NVIDIA_FAST_MODEL = resolveMainModel(process.env.NVIDIA_FAST_MODEL);

let client: OpenAI | null = null;

export function getNvidiaClient() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "NVIDIA_API_KEY가 없습니다. build.nvidia.com에서 API 키를 발급해 .env에 추가해주세요.",
    );
  }

  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: NVIDIA_BASE_URL,
      // NIM free endpoints can queue briefly. One bounded request is more
      // predictable than the SDK retrying a large planning response.
      timeout: 180_000,
      maxRetries: 0,
    });
  }

  return client;
}
