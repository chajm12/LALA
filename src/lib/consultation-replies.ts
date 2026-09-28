import { sanitizeCoreText } from "./garments";

export type ConsultationStage = "place" | "fit" | "material";

export type DirectConsultationInput = {
  keyword: string;
  feedback?: string[];
  stage: ConsultationStage;
  trend?: string;
};

const ACTION_ONLY = /^(?:좋아(?:요)?|네|응|오케이|확인|추천해\s*줘|추천해\s*주세요|알아서\s*(?:해\s*줘|추천해\s*줘)|진행해\s*줘)[.!\s]*$/;

function preferenceState(pattern: RegExp, texts: string[]): boolean | null {
  let state: boolean | null = null;
  const matcher = new RegExp(pattern.source, "gi");
  for (const text of texts) {
    for (const match of text.matchAll(matcher)) {
      const suffix = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 25);
      state = !/^\s*(?:은|는|이|가|을|를)?\s*(?:말고|제외|빼|싫|피해|없이|안\s*입|입지\s*않|원하지\s*않|필요\s*없)/.test(suffix);
    }
  }
  return state;
}

const DENIM_OUTER = /데님(?:\s*(?:자켓|재킷))?|청재킷|청자켓/;
const TRENCH_OUTER = /트렌치(?:\s*코트)?/;
const WIDE_FIT = /와이드(?:\s*(?:핏|팬츠|바지))?/;
const SLIM_FIT = /슬림(?:\s*(?:핏|팬츠|바지))?/;

function latestFit(texts: string[]) {
  let fit = "";
  for (const text of texts) {
    for (const match of text.matchAll(/와이드(?:\s*(?:핏|팬츠|바지))?|슬림(?:\s*(?:핏|팬츠|바지))?|스트레이트(?:\s*(?:핏|팬츠|바지))?/g)) {
      const token = match[0];
      if (preferenceState(new RegExp(token), [text.slice(match.index)]) === false) {
        if ((token.startsWith("와이드") && fit === "와이드") || (token.startsWith("슬림") && fit === "슬림")) fit = "";
      } else fit = token.startsWith("와이드") ? "와이드" : token.startsWith("슬림") ? "슬림" : "스트레이트";
    }
  }
  return fit;
}

/** Concrete proposals, not claims that an existing outfit has already changed. */
export function buildDirectConsultationReply(input: DirectConsultationInput): string {
  const latestRaw = input.feedback?.at(-1) ?? input.keyword;
  if (latestRaw.trim() && !sanitizeCoreText(latestRaw)) {
    return "코디는 상의·하의·신발과 필요한 아우터로 구성할게요. 색상이나 핏으로 포인트를 주는 조합을 추천해요.";
  }
  input = { ...input, keyword: sanitizeCoreText(input.keyword) };
  const feedback = (input.feedback ?? []).map(sanitizeCoreText).filter(Boolean);
  const latest = feedback.at(-1) ?? input.keyword;
  const previous = [...feedback].reverse().find((value) => !ACTION_ONLY.test(value));
  const request = ACTION_ONLY.test(latest) ? previous ?? input.keyword : latest;
  const texts = [input.keyword, ...feedback];
  const context = texts.join(" ");
  const outerExcluded = /(?:아우터|겉옷|재킷|자켓).{0,8}(?:없이|빼|제외|안\s*입|필요\s*없)/.test(request)
    || (!/(?:아우터|겉옷|재킷|자켓|코트).{0,12}(?:추가|추천|입고|입을)/.test(request)
      && /(?:아우터|겉옷).{0,8}(?:없이|빼|제외|안\s*입|필요\s*없)/.test(context));

  if (outerExcluded && /아우터|겉옷|재킷|자켓/.test(request)) {
    return "겉옷을 제외하고 상의·하의·신발로 조합을 준비할게요. 기존에 말씀하신 색상과 신발 조건은 유지하겠습니다.";
  }

  if (/아우터|겉옷|재킷|자켓|코트/.test(request) && !outerExcluded) {
    const avoidsBlack = preferenceState(/검정(?:색)?|블랙|검은색/, texts) === false;
    const denim = preferenceState(DENIM_OUTER, [request]) === true;
    const camel = preferenceState(/카멜(?:색)?|캐멀(?:색)?/, [request]) === true;
    const trench = preferenceState(TRENCH_OUTER, [request]) === true;
    const black = preferenceState(/검정(?:색)?|블랙|검은색/, [request]) === true;
    const outer = denim && !(black && avoidsBlack)
      ? `${black ? "검정색 " : ""}데님 재킷`
      : trench
        ? `${camel ? "카멜색 " : ""}트렌치코트`
        : "얇은 셔츠형 겉옷";
    const preserve = /(?:흰색|흰|화이트).{0,15}(?:티셔츠|무지티|티)/.test(context)
      ? "흰 티셔츠는 그대로 두고"
      : "기존 상의는 그대로 두고";
    return `${preserve} 그 위에 ${outer}${outer.endsWith("코트") ? "를" : "을"} 더하는 조합을 추천해요. 벗었을 때도 기존 상의·하의·신발 조합이 유지되도록 준비할게요.`;
  }

  if (/(?:이동|걷|걸음|도보).{0,8}(?:많|오래)|많이\s*걷|오래\s*걸/.test(request)) {
    const shoes = preferenceState(/뉴발란스/, texts) === true ? "뉴발란스 스니커즈"
      : preferenceState(/컨버스/, texts) === true ? "컨버스 스니커즈" : "스니커즈";
    const fit = latestFit(texts);
    const trousers = fit ? `요청하신 ${fit} 팬츠` : "움직이기 편한 여유 있는 팬츠";
    return `이동이 많으니 ${shoes}에 ${trousers}를 맞추는 조합을 추천해요. ${outerExcluded ? "겉옷 없이 상의·하의·신발로 준비할게요." : "겉옷은 벗어 들기 쉬운 얇은 겉옷을 더한 안도 함께 준비할게요."}`;
  }

  if (preferenceState(/스트리트(?:\s*(?:스타일|룩|느낌))?|힙하게|힙한/, [request]) === true) {
    return "여유 있는 상의와 곧게 떨어지는 팬츠, 스니커즈 조합으로 스트리트 느낌을 추천해요. 색상과 신발 브랜드는 말씀하신 조건 안에서 고를게요.";
  }
  if (preferenceState(WIDE_FIT, [request]) === true) {
    return "하의는 와이드 팬츠로 추천해요. 상의는 밑단이 너무 길게 겹치지 않는 조합으로 맞춰 바지의 넉넉한 실루엣을 살릴게요.";
  }
  if (preferenceState(SLIM_FIT, [request]) === true) {
    return "하의는 요청하신 슬림 핏으로 추천해요. 상의는 바지 위로 길게 겹치지 않는 조합으로 준비할게요.";
  }
  if (/단정|깔끔|차분|담백/.test(request)) {
    return "장식이 적은 상의와 곧게 떨어지는 팬츠로 깔끔하게 추천해요. 색상 수를 줄이고 요청하신 신발을 중심으로 조합할게요.";
  }
  if (preferenceState(/여유(?:\s*있는\s*핏)?|편안|오버(?:핏)?/, [request]) === true) {
    return "상의와 하의가 몸에 붙지 않는 여유 있는 핏을 추천해요. 소매와 바지 밑단이 과하게 길지 않은 조합으로 준비할게요.";
  }
  if (/실내/.test(request)) {
    return `실내에서는 가벼운 상의와 팬츠를 중심으로 추천해요. ${outerExcluded ? "겉옷은 제외할게요." : "이동할 때 입고 실내에서 벗을 수 있는 얇은 겉옷을 더한 안도 비교할게요."}`;
  }
  if (preferenceState(/패턴|질감|체크|스트라이프/, [request]) === true) {
    return "상의 한 곳에 패턴이나 질감으로 포인트를 주고 하의는 단순하게 맞추는 조합을 추천해요. 요청하신 색상과 신발 조건은 유지할게요.";
  }

  // A novel specific request must stay visible instead of being silently replaced
  // by a supposedly accepted generic recommendation.
  if (feedback.length && !ACTION_ONLY.test(request) && request.length <= 160) {
    return `“${request}” 조건을 기준으로 조합을 준비할게요. 기존에 정한 다른 조건은 유지하고, 바뀌는 아이템을 후보에서 보여드리겠습니다.`;
  }

  const formal = /결혼|장례|면접|격식|세미포멀|포멀/.test(context);
  if (formal) {
    return "장식이 적은 셔츠나 니트에 곧게 떨어지는 슬랙스를 추천해요. 신발과 색상은 요청하신 조건을 지키면서 단정하게 맞출게요.";
  }
  if (input.stage === "fit") {
    return "살짝 여유 있는 상의와 스트레이트 팬츠를 추천해요. 소매와 바지 밑단이 과하게 길지 않은 비율로 맞출게요.";
  }
  if (input.stage === "material") {
    return `상의를 단순하게 두고 하의의 질감으로 변화를 주는 조합을 추천해요. ${outerExcluded ? "겉옷 없이 요청하신 구성으로 준비할게요." : "얇은 겉옷을 더한 안도 함께 비교할게요."}`;
  }
  return "기본 상의에 스트레이트 팬츠, 요청하신 신발을 맞춘 캐주얼 조합을 추천해요. 여유 있는 조합과 좀 더 단정한 조합을 나란히 준비할게요.";
}

export function isGenericConsultationReply(value: string): boolean {
  const vague = /말씀해?\s*주신.{0,16}(?:방향|조건|요청)|반영해.{0,12}(?:준비|후보)|원하는\s*룩을\s*골라|분위기에\s*맞[춰는]/.test(value);
  const concrete = /셔츠|니트|티셔츠|팬츠|바지|슬랙스|신발|스니커즈|로퍼|재킷|자켓|겉옷|코트|데님|와이드|스트레이트|레이어/.test(value);
  return vague && !concrete;
}
