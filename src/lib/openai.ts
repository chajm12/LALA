import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// completion.choices[0].message.content can be null OR an empty string
// (e.g. refusal, content filtering) - JSON.parse("") throws "Unexpected
// end of JSON input", so guard both cases here instead of `?? "{}"`.
export function parseJsonContent(content: string | null | undefined) {
  return JSON.parse(content && content.length > 0 ? content : "{}");
}
