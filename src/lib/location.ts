/** Extract a destination from a request; never treat the last conversational word as a place. */
const SEOUL_PLACES = [
  "을지로", "성수", "홍대", "연남", "한남", "이태원", "청담", "압구정", "도산", "강남", "삼성", "잠실",
  "가로수길", "신촌", "종로", "건대", "건대입구", "합정", "망원", "여의도", "서울숲",
];
const BUSAN_PLACES = ["해운대", "광안리", "서면"];
const JEJU_PLACES = ["애월", "서귀포"];
const REGIONS = [
  "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시", "울산광역시", "세종특별자치시",
  "제주특별자치도", "강원특별자치도", "전북특별자치도", "경기도", "충청북도", "충청남도", "전라남도", "경상북도", "경상남도",
  "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "제주", "수원", "성남", "용인", "고양", "파주",
  "전주", "경주", "안동", "강릉", "속초", "춘천", "청주", "천안", "여수", "순천", "목포", "포항", "창원", "진주",
];
const aliases = [...REGIONS, ...SEOUL_PLACES, ...BUSAN_PLACES, ...JEJU_PLACES].sort((a, b) => b.length - a.length);
const knownPlace = new RegExp(
  `(?:^|[^가-힣A-Za-z0-9])(${aliases.join("|")})(동(?:\\d가)?|역|시|구)?(?=(?:에서(?:는)?|에(?:는)?|으로(?:는)?|로(?:는)?|근처|인근|주변|쪽|의|를|을|은|는)?(?:[^가-힣A-Za-z0-9]|$))`,
  "u",
);
const notAPlace = /^(?:오늘|내일|모레|다음|이번|주말|아침|점심|저녁|오전|오후|밤|낮|봄|여름|가을|겨울|남자|여자|남성|여성|실내|실외|회사|학교|집|카페|식당|호텔|공원|결혼식|장례식|회의|약속|데이트|여행|이동|운동|활동|정도|추천|상황|기준|키|몸무게|사이즈|핏|소재|레이어링|기온|날씨|이야|이에요)$/;
const clothingWord = /(?:캐주얼|포멀|스트리트|스타일|코디|룩|의상|상의|하의|신발|반팔|긴팔|팬츠|바지|셔츠|재킷|자켓|코트|아우터|니트|색|톤|브랜드|뉴발란스|컨버스|스니커즈|kg|cm)/i;

function plausiblePlace(value: string) {
  return value.length >= 2 && !notAPlace.test(value) && !clothingWord.test(value) && !/^\d/.test(value);
}

export function extractLocationHint(input: string): string | undefined {
  const text = input
    .replace(/\d{2,3}(?:\.\d+)?\s*(?:cm|센티(?:미터)?|kg|킬로(?:그램)?)/gi, " ")
    .replace(/20\d{2}[./년-]\s*\d{1,2}[./월-]\s*\d{1,2}일?/g, " ")
    .replace(/\d{1,2}월\s*\d{1,2}일?/g, " ");
  const known = knownPlace.exec(text);
  if (known) {
    const place = known[1] + (known[2] ?? "");
    // Keep a supplied district/address attached to an explicit city/province.
    if (REGIONS.includes(known[1])) {
      const remaining = text.slice(known.index + known[0].length);
      const address = remaining.match(/^(?:\s+[가-힣0-9]+(?:시|군|구|동|읍|면|리|역)(?:\d가)?)+/u)?.[0] ?? "";
      const nearby = knownPlace.exec(remaining);
      const neighborhood = !address && nearby && nearby.index === 0 ? " " + nearby[1] + (nearby[2] ?? "") : "";
      return place + address + neighborhood;
    }
    return place;
  }

  // A locative particle is evidence of a place. Without it, only a station or
  // an explicit administrative name is accepted; arbitrary sentence tails are not.
  for (const match of text.matchAll(/(?:^|[\s,·/])([가-힣A-Za-z][가-힣A-Za-z0-9-]*?)(?:에서는|에서|으로는|으로|에는|에|로)(?=$|[\s,.!?])/gu)) {
    if (plausiblePlace(match[1])) return match[1];
  }
  for (const match of text.matchAll(/(?:^|[\s,·/])([가-힣A-Za-z0-9]+(?:특별시|광역시|자치시|특별자치도|시|군|구|동|읍|면|역))(?=$|[\s,.!?])/gu)) {
    if (plausiblePlace(match[1])) return match[1];
  }
  return undefined;
}

/** Only known geography may supply a broader weather region. Unknown Korean text is not Seoul. */
export function weatherParentRegion(location: string): string | undefined {
  const name = location.trim().replace(/(?:동(?:\d가)?|역)$/u, "");
  if (/^서울(?:특별시)?(?:\s|$)/u.test(name) || SEOUL_PLACES.includes(name)) return "Seoul";
  if (/^부산(?:광역시)?(?:\s|$)/u.test(name) || BUSAN_PLACES.includes(name)) return "Busan";
  if (/^제주(?:특별자치도)?(?:\s|$)/u.test(name) || JEJU_PLACES.includes(name)) return "Jeju";
  return undefined;
}
