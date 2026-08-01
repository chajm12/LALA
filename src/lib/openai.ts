import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export const TEXT_MODEL = "gpt-5.4-mini";
export const VISION_MODEL = "gpt-5.4-nano";
export const TREND_MODEL = "gpt-5.6-luna";
export const PLAN_MODEL = "gpt-5.6-luna";
export const IMAGE_MODEL = "gpt-image-2";
export const OPENAI_SERVICE_TIER = "priority";

// completion.choices[0].message.content can be null OR an empty string
// (e.g. refusal, content filtering) - JSON.parse("") throws "Unexpected
// end of JSON input", so guard both cases here instead of `?? "{}"`.
export function parseJsonContent(content: string | null | undefined) {
  return JSON.parse(content && content.length > 0 ? content : "{}");
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
