import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export const IMAGE_MODEL = "gpt-image-2";
export const OPENAI_SHOPPING_MODEL =
  process.env.OPENAI_SHOPPING_MODEL ?? "gpt-5.4-mini";
export const OPENAI_TREND_MODEL =
  process.env.OPENAI_TREND_MODEL ?? "gpt-5.4-mini";
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
  let lastTopLevelObject: Record<string, unknown> | null = null;
  let cursor = 0;

  // Walk from one top-level object to the next. Parsing every `{` separately
  // would eventually return the last nested candidate instead of the response
  // object containing the full `concepts`/`candidates` array.
  while (cursor < jsonLike.length) {
    const start = jsonLike.indexOf("{", cursor);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let index = start; index < jsonLike.length; index += 1) {
      const character = jsonLike[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }

    if (end < 0) break;
    try {
      const parsed = JSON.parse(jsonLike.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        lastTopLevelObject = parsed as Record<string, unknown>;
      }
    } catch {
      // The model may have printed an illustrative schema before its real answer.
    }
    cursor = end + 1;
  }

  if (lastTopLevelObject) return lastTopLevelObject;
  return {};
}
