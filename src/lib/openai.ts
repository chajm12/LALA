import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export const TEXT_MODEL = "gpt-5.4-mini";
export const VISION_MODEL = "gpt-5.4-nano";
export const TREND_MODEL = "gpt-5.6-luna";
export const IMAGE_MODEL = "gpt-image-2";

// completion.choices[0].message.content can be null OR an empty string
// (e.g. refusal, content filtering) - JSON.parse("") throws "Unexpected
// end of JSON input", so guard both cases here instead of `?? "{}"`.
export function parseJsonContent(content: string | null | undefined) {
  return JSON.parse(content && content.length > 0 ? content : "{}");
}
