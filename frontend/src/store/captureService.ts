import type { ChatMessage, JournalDraft, ProfileProposalField, SafetyAlert } from "../types";

export type ProfileProposalDraft = {
  field: ProfileProposalField;
  value: string;
};

export type CaptureResult = {
  entries: JournalDraft[];
  reply: Omit<ChatMessage, "id" | "createdAt">;
  safetyAlert?: Omit<SafetyAlert, "id" | "createdAt">;
  profileProposals: ProfileProposalDraft[];
};

export type StructuredSafetyResult = {
  level: "same-day" | "emergency";
  triggers: string[];
};

type StructuredSafetyDetails = NonNullable<JournalDraft["structured"]>;

const directNegations = {
  fever: /\b(?:i\s+)?(?:do\s+not|don't)\s+have\s+(?:a\s+)?fever\b|\b(?:i\s+)?(?:am\s+not|i'm\s+not)\s+feverish\b|\bno\s+(?:signs?\s+of\s+)?fever\b|\b(?:temperature|temp)\s+(?:is|was)\s+(?:normal|not\s+high)\b/i,
  numericTemperature: /\b(?:my\s+)?(?:temperature|temp)\b.{0,18}\bnot\s+\d{2,3}(?:\.\d+)?\s*(?:(?:°\s*)?[cf](?:elsius|ahrenheit)?\b|degrees?\b)?/i,
  faint: /\b(?:i\s+)?(?:do\s+not|don't|did\s+not|didn't)\s+feel\s+faint\b|\b(?:i\s+)?(?:am\s+not|i'm\s+not|was\s+not|wasn't)\s+(?:feeling\s+)?faint\b|\bno\s+faintness\b|\b(?:did\s+not|didn't|have\s+not|haven't)\s+(?:faint(?:ed)?|pass(?:ed)?\s+out|black(?:ed)?\s+out|lose|lost)\b/i,
  dehydration: /\b(?:i\s+)?(?:am\s+not|i'm\s+not)\s+dehydrated\b|\b(?:i\s+)?(?:do\s+not|don't|did\s+not|didn't)\s+feel\s+dehydrated\b|\bno\s+(?:signs?\s+of\s+)?dehydration\b/i,
  vomiting: /\b(?:i\s+)?(?:am\s+not|i'm\s+not)\s+vomiting\b|\bno\s+(?:persistent\s+|repeated\s+)?vomiting\b|\b(?:have\s+not|haven't|did\s+not|didn't)\s+vomit(?:ed)?\b/i,
  obstruction: /\bno\s+(?:bowel\s+)?obstruction\b|\b(?:bowel\s+)?(?:is\s+)?not\s+(?:blocked|obstructed)\b|\b(?:i\s+)?(?:can|am\s+able\s+to)\s+pass\s+(?:stool|wind|gas)\b/i,
  distension: /\bno\s+(?:abdominal\s+)?(?:distension|swelling|bloating)\b|\b(?:abdomen|abdominal|belly|stomach|tummy)\b.{0,12}\bnot\s+(?:swollen|bloated|distended)\b|\bnot\s+bloat(?:ed|ing)\b/i,
  bleeding: /\bno\s+(?:heavy|continuous|moderate)\s+(?:blood|bleeding)\b|\b(?:blood|bleeding)\s+(?:is|was)\s+not\s+(?:heavy|continuous|moderate)\b|\b(?:there\s+(?:is|was)\s+)?not\s+(?:a\s+)?lot\s+of\s+(?:blood|bleeding)\b|\bnot\s+(?:a\s+)?large\s+amount\s+of\s+(?:blood|bleeding)\b|\bno\s+large\s+(?:blood\s+)?clots?\b/i,
  severePain: /\b(?:pain|cramp(?:s|ing|y)?)\s+(?:is|was)\s+not\s+(?:severe|unbearable|excruciating)\b|\bno\s+(?:severe|unbearable|excruciating)\s+(?:abdominal|stomach|tummy|gut)?\s*(?:pain|cramp(?:s|ing|y)?)\b|\b(?:i\s+)?(?:do\s+not|don't|did\s+not|didn't)\s+have\s+(?:any\s+)?(?:severe|unbearable|excruciating)\s+(?:abdominal|stomach|tummy|gut)?\s*(?:pain|cramp(?:s|ing|y)?)\b/i,
  numericPain: /\b(?:pain|cramp(?:s|ing|y)?)\b.{0,18}\bnot\s+(?:10|[0-9]|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:(?:\/|out\s+of)\s*(?:10|ten))?|\bnot\s+(?:10|[0-9]|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:(?:\/|out\s+of)\s*(?:10|ten))\b.{0,20}\b(?:abdominal|stomach|tummy|gut|belly)?\s*(?:pain|cramp(?:s|ing|y)?)\b/i,
};

function isGeneralSafetyQuestion(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!/^(?:what|when|where|why|how|is|are|can|could|should|would)\b/.test(trimmed)) return false;
  return !/\b(?:i\s+(?:have|feel|am|keep|kept|cannot|can't|couldn't|passed|fainted|developed)|i'm|i've|my\s+(?:temperature|temp|pain|stomach|tummy|bowel)|not\s+passing)\b/.test(trimmed);
}

function safetyClauses(text: string): string[] {
  return text.split(/\b(?:but|however|although)\b|;|(?<!\d)\.(?!\d)/i).map((clause) => clause.trim()).filter(Boolean);
}

function nonNegatedMatch(text: string, mention: RegExp, negation: RegExp): RegExpMatchArray | undefined {
  for (const clause of safetyClauses(text)) {
    const match = clause.match(mention);
    if (match && !negation.test(clause)) return match;
  }
  return undefined;
}

const countWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  dozen: 12,
};
const countToken = `(?:\\d{1,3}|(?:a\\s+)?dozen|${Object.keys(countWords).join("|")})`;
const currentDayContext = "(?:today|since\\s+(?:this\\s+)?(?:morning|waking|midnight)|(?:in|over|within|during|for|the|past|last)\\s+(?:the\\s+)?(?:past\\s+|last\\s+)?24\\s*(?:hours?|hrs?)|(?:per|a|each)\\s+day)";

function countValue(raw: string): number | undefined {
  const normalized = raw.toLowerCase().replace(/^a\s+/, "");
  const parsed = countWords[normalized] ?? Number(normalized);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

const painScoreWords: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const painScoreToken = `(?:10|[0-9]|${Object.keys(painScoreWords).join("|")})`;

function painScoreValue(raw: string): number | undefined {
  const score = painScoreWords[raw.toLowerCase()] ?? Number(raw);
  return Number.isInteger(score) && score >= 0 && score <= 10 ? score : undefined;
}

function extractBowelMovements24h(text: string): number | undefined {
  const expressions = [
    new RegExp(`\\b(?<count>${countToken})\\s+(?:(?:very\\s+)?(?:loose|watery|bloody)\\s+)*(?:bowel\\s+movements?|stools?|poos?|motions?)\\b.{0,30}\\b${currentDayContext}\\b`, "i"),
    new RegExp(`\\b(?:diarrh(?:oea|ea)|loose\\s+stools?|bowel\\s+movements?|stools?|poos?)\\b.{0,24}\\b(?<count>${countToken})\\s+times?\\b.{0,24}\\b${currentDayContext}\\b`, "i"),
    new RegExp(`\\b(?:been|went|going|go)\\s+(?:to\\s+)?(?:the\\s+)?toilet\\b.{0,20}\\b(?<count>${countToken})\\s+times?\\b.{0,24}\\b${currentDayContext}\\b`, "i"),
  ];
  const directNegation = /\b(?:have|has|had|did)\s+not\b|\b(?:haven't|hasn't|hadn't|didn't|never)\b|\b(?:fewer|less)\s+than\b|\bunder\b/i;
  for (const clause of safetyClauses(text)) {
    for (const expression of expressions) {
      const match = clause.match(expression);
      if (!match?.groups?.count) continue;
      const prefix = clause.slice(Math.max(0, match.index! - 28), match.index! + match[0].indexOf(match.groups.count));
      if (directNegation.test(prefix)) continue;
      const count = countValue(match.groups.count);
      if (count !== undefined) return count;
    }
  }
  return undefined;
}

/** Extract deterministic, explicitly reportable safety fields without assigning a diagnosis. */
export function extractStructuredSafetyDetails(text: string): StructuredSafetyDetails {
  text = text.replace(/[’‘]/g, "'").replace(/[–—]/g, "-");
  if (isGeneralSafetyQuestion(text)) return {};
  const details: StructuredSafetyDetails = {};
  const bowelCount = extractBowelMovements24h(text);
  if (bowelCount !== undefined) details.bowelMovements24h = bowelCount;
  const temperatureC = nonNegatedMatch(text, /\b(3\d(?:\.\d+)?|4[0-5](?:\.\d+)?)\s*(?:(?:°\s*)?c(?:elsius)?\b|degrees?\s+c(?:elsius)?\b)/i, directNegations.numericTemperature);
  const temperatureBare = nonNegatedMatch(text, /\b(?:temperature|temp)\b.{0,16}\b(3\d(?:\.\d+)?|4[0-5](?:\.\d+)?)(?!\s*(?:degrees?\s*)?(?:°\s*)?f(?:ahrenheit)?\b)\s*(?:degrees?)?\b/i, directNegations.numericTemperature);
  const temperatureF = nonNegatedMatch(text, /\b(9\d(?:\.\d+)?|10\d(?:\.\d+)?|11[0-3](?:\.\d+)?)\s*(?:(?:°\s*)?f(?:ahrenheit)?\b|degrees?\s+f(?:ahrenheit)?\b)/i, directNegations.numericTemperature);
  if (temperatureF) details.feverC = Math.round(((Number(temperatureF[1]) - 32) * 5 / 9) * 10) / 10;
  else if (temperatureC || temperatureBare) details.feverC = Number((temperatureC ?? temperatureBare)![1]);

  if (nonNegatedMatch(text, /\b(?:fever|feverish|high temperature)\b/i, directNegations.fever)) details.fever = true;

  if (nonNegatedMatch(text, /\b(?:faint(?:ed|ing|ness)?|feel(?:ing)?\s+faint|pass(?:ed)?\s+out|black(?:ed|ing)?\s+out|lost\s+consciousness|collaps(?:e|ed|ing)|dizzy\s+and\s+weak)\b/i, directNegations.faint)) details.faint = true;

  if (nonNegatedMatch(text, /\b(?:dehydrat(?:ed|ion)|can(?:not|'t)\s+keep\s+(?:anything|food|fluids|water)\s+down|(?:have\s+not|haven't|not)\s+(?:peed|urin(?:ated|ating))|very\s+dark\s+urine)\b/i, directNegations.dehydration)) details.dehydration = true;

  const vomitingMention = nonNegatedMatch(text, /\b(?:vomit(?:ed|ing|s)?|throw(?:ing|s|n)?\s+up|(?:being|been)\s+sick)\b/i, directNegations.vomiting);
  let persistentVomiting = nonNegatedMatch(text, /\b(?:persistent|repeated|recurrent|continuous)\s+(?:vomit(?:ing|s)?|sickness)\b|\b(?:keep|kept)\s+(?:vomiting|throwing\s+up)\b|\bcan(?:not|'t)\s+stop\s+(?:vomiting|throwing\s+up|being\s+sick)\b|\bcan(?:not|'t)\s+keep\s+anything\s+down\b|\b(?:vomit(?:ed|ing)|(?:being|been)\s+sick)\s+(?:repeatedly|persistently|all\s+day)\b|\b(?:have\s+)?been\s+sick\s+all\s+day\b/i, directNegations.vomiting);
  const repeatedVomiting = nonNegatedMatch(
    text,
    new RegExp(`\\b(?:vomit(?:ed|ing)?|(?:have\\s+)?been\\s+sick)\\b.{0,16}\\b(?<count>${countToken})\\s+times?\\b.{0,24}\\b${currentDayContext}\\b`, "i"),
    directNegations.vomiting,
  );
  if (repeatedVomiting?.groups?.count && (countValue(repeatedVomiting.groups.count) ?? 0) >= 3) persistentVomiting = repeatedVomiting;
  if (vomitingMention) details.vomiting = true;
  if (persistentVomiting) details.persistentVomiting = true;

  const cannotPass = Boolean(nonNegatedMatch(text, /\b(?:(?:have\s+not|haven't)\s+passed|(?:not|unable\s+to|can(?:not|'t))\s+(?:passing|pass))\s+(?:stool|poo|wind|gas)\b|\bno\s+(?:stool|poo|bowel\s+movement)\s+(?:or|and)\s+(?:wind|gas)\b|\bcan(?:not|'t)\s+(?:poo|defecate)\b/i, directNegations.obstruction));
  const explicitObstruction = Boolean(nonNegatedMatch(text, /\b(?:bowel\s+)?(?:obstruction|obstructed)\b|\b(?:blocked\s+bowel|bowel\s+(?:(?:is|feels?)\s+)?blocked)\b/i, directNegations.obstruction));
  if (cannotPass || explicitObstruction) {
    details.possibleObstruction = true;
    if (cannotPass) details.cannotPassStoolOrGas = true;
  }
  if (nonNegatedMatch(text, /\b(?:abdominal\s+)?(?:distension|distended|swelling)\b|\b(?:abdomen|abdominal|belly|stomach|tummy)\b.{0,12}\b(?:swollen|bloated|distended)\b|\b(?:severe\s+)?bloat(?:ing|ed)\b/i, directNegations.distension)) details.abdominalDistension = true;

  const heavyBleeding = nonNegatedMatch(text, /\b(?:heavy|continuous|won'?t\s+stop|will\s+not\s+stop|can(?:not|'t)\s+stop|a\s+lot\s+of|lots\s+of|large\s+amount\s+of)\b.{0,28}\b(?:blood|bleed(?:ing)?)\b|\b(?:blood|bleed(?:ing)?)\b.{0,28}\b(?:heavy|continuous|won'?t\s+stop|will\s+not\s+stop|can(?:not|'t)\s+stop|a\s+lot|lots|large\s+amount)\b|\blarge\s+(?:blood\s+)?clots?\b/i, directNegations.bleeding);
  if (heavyBleeding) {
    details.blood = /\b(?:continuous|won'?t\s+stop|will\s+not\s+stop|can(?:not|'t)\s+stop)\b/i.test(text) ? "continuous" : "heavy";
  } else if (nonNegatedMatch(text, /\bmoderate\b.{0,22}\b(?:blood|bleeding)\b/i, directNegations.bleeding)) {
    details.blood = "moderate";
  }

  const painScore = nonNegatedMatch(text, new RegExp(`\\b(?:pain|cramp(?:s|ing|y)?)\\b.{0,20}?\\b(?<score>${painScoreToken})\\s*(?:(?:\\/|out\\s+of)\\s*(?:10|ten))?\\b`, "i"), directNegations.numericPain)
    ?? nonNegatedMatch(text, new RegExp(`\\b(?<score>${painScoreToken})\\s*(?:(?:\\/|out\\s+of)\\s*(?:10|ten))\\b.{0,20}\\b(?:abdominal|stomach|tummy|gut|belly)?\\s*(?:pain|cramp(?:s|ing|y)?)\\b`, "i"), directNegations.numericPain);
  if (painScore?.groups?.score) {
    const value = painScoreValue(painScore.groups.score);
    if (value !== undefined) details.pain = value;
  }
  if (nonNegatedMatch(text, /\b(?:severe|unbearable|excruciating)\b.{0,20}\b(?:abdominal|stomach|tummy|gut|pain|cramp(?:s|ing|y)?)\b|\b(?:abdominal|stomach|tummy|gut)?\s*(?:pain|cramp(?:s|ing|y)?)\b.{0,12}\b(?:unbearable|excruciating)\b/i, directNegations.severePain)) details.severePain = true;

  return details;
}

export function screenForUrgency(text: string): string[] {
  if (isGeneralSafetyQuestion(text)) return [];
  return screenStructuredEntry({
    kind: "WELLBEING",
    body: text,
    source: "chat",
    structured: extractStructuredSafetyDetails(text),
  });
}

export function safetyLevelForTriggers(triggers: string[]): "same-day" | "emergency" {
  return triggers.some((trigger) => [
    "heavy or continuous bleeding",
    "severe abdominal pain",
    "faintness",
    "vomiting or possible obstruction",
  ].includes(trigger)) ? "emergency" : "same-day";
}

export function parseBloodAmountClarification(text: string): "none" | "trace" | "small" | "moderate" | "heavy" | "continuous" | "unspecified" | undefined {
  const lower = text.trim().toLowerCase().replace(/[’‘]/g, "'");
  if (!lower) return undefined;
  if (/\b(?:heavy|a lot|large amount)\b/.test(lower)) return "heavy";
  if (/\bcontinuous|won'?t stop\b/.test(lower)) return "continuous";
  if (/\bmoderate\b/.test(lower)) return "moderate";
  if (/\btrace|tiny|little\b/.test(lower)) return "trace";
  if (/\bsmall\b/.test(lower)) return "small";
  if (/\b(?:none|no blood|didn'?t see any)\b/.test(lower)) return "none";
  if (/\b(?:not sure|unsure|don'?t know|cannot tell|can'?t tell)\b/.test(lower)) return "unspecified";
  return undefined;
}

function cleanProposedValue(value: string): string {
  return value.trim().replace(/[.!?]+$/, "").trim();
}

/** Extract only explicit first-person PMH statements. The returned text is still a proposal. */
export function extractProfileProposals(text: string): ProfileProposalDraft[] {
  const trimmed = text.trim();
  if (!trimmed || /\?\s*$/.test(trimmed)) return [];
  const proposals: ProfileProposalDraft[] = [];
  const patterns: Array<{ field: ProfileProposalField; expression: RegExp }> = [
    {
      field: "surgeries",
      expression: /\b(?:i\s+(?:have\s+)?(?:had|undergone)|i\s+underwent)\s+(?:an?\s+)?(.+?\b(?:surgery|operation|resection|colectomy|proctocolectomy|ileostomy|colostomy|stoma)\b.*?)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
    {
      field: "surgeries",
      expression: /\bi\s+have\s+(an?\s+)?((?:ileostomy|colostomy|stoma)\b.*?)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
    {
      field: "allergies",
      expression: /\bi(?:'m|\s+am)\s+allergic\s+to\s+(.+?)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
    {
      field: "allergies",
      expression: /\bi\s+have\s+(?:an?\s+)?allerg(?:y|ies)\s+to\s+(.+?)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
    {
      field: "conditions",
      expression: /\bi\s+(?:was|have\s+been)\s+diagnosed\s+with\s+(.+?)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
    {
      field: "conditions",
      expression: /\b(?:my\s+medical\s+history\s+includes|i\s+have\s+(?:a\s+)?history\s+of)\s+(.+?)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
    {
      field: "conditions",
      expression: /\bi\s+have\s+((?:type\s+[12]\s+)?(?:diabetes|osteopenia|osteoporosis|coeliac\s+disease|celiac\s+disease|arthritis|anxiety|depression|asthma|hypertension|anaemia|anemia|primary\s+sclerosing\s+cholangitis|psc)\b.*?)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
    {
      field: "pastMedicines",
      expression: /\bi\s+(?:used\s+to|previously)\s+(?:take|took)\s+(.+?)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
    {
      field: "pastMedicines",
      expression: /\bi\s+stopped\s+(?:taking\s+)?(.+?)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
    {
      field: "pastMedicines",
      expression: /\bi\s+took\s+(.+?)\s+(?:in\s+the\s+past|previously|before)(?=\s+and\s+i\b|[.!?]|$)/i,
    },
  ];
  for (const { field, expression } of patterns) {
    const match = trimmed.match(expression);
    if (!match) continue;
    const captured = cleanProposedValue(match[2] ?? match[1]);
    if (!captured) continue;
    if (!proposals.some((proposal) => proposal.field === field && proposal.value.toLowerCase() === captured.toLowerCase())) {
      proposals.push({ field, value: captured });
    }
  }
  return proposals;
}

/** Deterministic red-flag screening for manual/structured capture, kept outside Penny. */
export function screenStructuredEntry(
  entry: JournalDraft,
  profile?: { immunosuppressed: boolean },
): string[] {
  if (entry.excluded) return [];
  const structured = {
    ...(entry.structured ?? {}),
    ...extractStructuredSafetyDetails(entry.body),
  };
  const triggers: string[] = [];
  if (["heavy", "continuous"].includes(String(structured.blood ?? "").toLowerCase())) triggers.push("heavy or continuous bleeding");
  if (String(structured.blood ?? "").toLowerCase() === "moderate") triggers.push("moderate bleeding");
  if ((typeof structured.pain === "number" && structured.pain >= 8) || structured.severePain === true) triggers.push("severe abdominal pain");
  if (typeof structured.feverC === "number" && structured.feverC >= 38) triggers.push("fever");
  else if (profile?.immunosuppressed && typeof structured.feverC === "number" && structured.feverC >= 37.5) triggers.push("possible infection while immunosuppressed");
  else if (structured.fever === true) triggers.push("fever");
  if (structured.faint === true) triggers.push("faintness");
  if (structured.dehydration === true) triggers.push("possible dehydration");
  const dailyCount = structured.bowelMovements24h ?? structured.dailyCount;
  if (typeof dailyCount === "number" && dailyCount >= 10) triggers.push("very high bowel output");
  if (structured.possibleObstruction === true || (structured.vomiting === true && (structured.cannotPassStoolOrGas === true || structured.abdominalDistension === true))) {
    triggers.push("vomiting or possible obstruction");
  } else if (structured.persistentVomiting === true) {
    triggers.push("persistent vomiting");
  }
  if (structured.infectionConcern === true) triggers.push("possible infection while taking steroids");
  if (structured.seriousMoodConcern === true || structured.moodConcern === true) triggers.push("serious mood change while taking steroids");
  if (structured.newSwellingConcern === true) triggers.push("new swelling while taking steroids");
  if (structured.taperCheckIn === true && (structured.symptomsWorse === true || structured.wellbeing === "worse")) triggers.push("symptoms worsening during taper");
  return triggers;
}

export function structureUtterance(text: string, profile?: { immunosuppressed: boolean }): CaptureResult {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const profileProposals = extractProfileProposals(trimmed);
  const safetyDetails = extractStructuredSafetyDetails(trimmed);
  const urgent = isGeneralSafetyQuestion(trimmed) ? [] : screenStructuredEntry({
    kind: "WELLBEING",
    body: trimmed,
    source: "chat",
    structured: safetyDetails,
  }, profile);
  if (urgent.length) {
    const level = safetyLevelForTriggers(urgent);
    const body = `Reported ${urgent.join(" and ")} in chat — safety guidance shown`;
    const sharedStructured = { redFlagScreen: true, reportedText: trimmed, ...safetyDetails };
    const urgentEntries: JournalDraft[] = [];
    const isBowelReport = safetyDetails.bowelMovements24h !== undefined
      || safetyDetails.blood !== undefined
      || safetyDetails.possibleObstruction === true
      || /\b(?:stool|poo|bowel|diarrh(?:oea|ea)?|loose|toilet|urgency|blood|bleed(?:ing)?|mucus|wind|gas)\b/.test(lower);
    const isPainReport = safetyDetails.pain !== undefined
      || safetyDetails.severePain === true
      || /\b(?:pain|cramp(?:s|ing|y)?)\b/.test(lower);
    if (isBowelReport) urgentEntries.push({ kind: "BOWEL MOVEMENT", body, source: "chat", flagged: true, structured: sharedStructured });
    if (isPainReport) urgentEntries.push({ kind: "PAIN", body, source: "chat", flagged: true, structured: sharedStructured });
    if (!urgentEntries.length) urgentEntries.push({ kind: "WELLBEING", body, source: "chat", flagged: true, structured: sharedStructured });
    return {
      entries: urgentEntries,
      reply: {
        from: "penny",
        category: "general information",
        text: level === "emergency"
          ? "Please stop here and use urgent care now. I can record what you said, but I cannot safely assess or reassure you in chat. Use 111 now, or 999 / A&E if symptoms are severe or you may be in immediate danger."
          : "This wording needs same-day clinical advice. Contact your IBD team or GP today. If symptoms become severe, you feel unsafe, or you cannot get timely advice, use urgent care rather than waiting in the app.",
      },
      safetyAlert: {
        level,
        triggers: urgent,
        message: "Your words matched the app’s deterministic red-flag screen. This was not decided by AI.",
      },
      profileProposals,
    };
  }

  const entries: JournalDraft[] = [];
  const logged: string[] = [];
  const isQuestion = /\?\s*$/.test(trimmed);

  if (!isQuestion && /(stool|poo|bowel|diarrh|loose|toilet|urgency|blood|mucus)/.test(lower)) {
    const explicitBristol = lower.match(/bristol(?:\s+type)?\s*([1-7])/);
    const bloodMentioned = /\bblood|bleed(?:ing)?\b/.test(lower);
    const bloodNegated = /\b(?:no|without)\s+(?:visible\s+)?(?:blood|bleeding)\b|\b(?:did(?:\s+not|n't)\s+(?:see|notice)|saw\s+no)\s+(?:any\s+)?blood\b/.test(lower);
    const hasBlood = bloodMentioned && !bloodNegated;
    const bloodAmount = lower.match(/\b(small|tiny|trace|moderate)\s+(?:amount of\s+)?blood\b/)?.[1];
    const urgencyNegated = /\b(?:no|without)\s+urgency\b|\b(?:did(?:\s+not|n't)|do(?:\s+not|n't))\s+feel\s+urgent\b/.test(lower);
    const hasUrgency = /\burgency|urgent\b/.test(lower) && !urgencyNegated;
    const mucusNegated = /\b(?:no|without)\s+mucus\b/.test(lower);
    const hasMucus = /\bmucus\b/.test(lower) && !mucusNegated;
    const nightWakingNegated = /\b(?:no|without)\s+(?:night\s+waking|waking\s+at\s+night)\b|\bdid(?:\s+not|n't)\s+wake\b.{0,12}\bnight\b/.test(lower);
    const hasNightWaking = /\bnight\s+waking\b|\bwok(?:e|en)\b.{0,12}\bnight\b/.test(lower) && !nightWakingNegated;
    const attributes: string[] = [];
    if (explicitBristol) attributes.push(`Bristol type ${explicitBristol[1]}`);
    else if (/\bloose|diarrh/.test(lower)) attributes.push("Loose stool (Bristol type not confirmed)");
    else attributes.push("Bowel movement (Bristol type not confirmed)");
    if (hasUrgency) attributes.push("urgency");
    else if (urgencyNegated) attributes.push("no urgency");
    if (hasBlood) attributes.push(bloodAmount ? `${bloodAmount} amount of blood` : "blood (amount not specified)");
    else if (bloodNegated) attributes.push("no blood noticed");
    if (hasMucus) attributes.push("mucus");
    else if (mucusNegated) attributes.push("no mucus");
    if (hasNightWaking) attributes.push("night waking");
    else if (nightWakingNegated) attributes.push("no night waking");
    entries.push({
      kind: "BOWEL MOVEMENT",
      body: `${attributes.join(", ")} — logged from chat; tap Edit to confirm missing detail`,
      source: "chat",
      flagged: hasBlood,
      structured: {
        ...(explicitBristol ? { bristol: Number(explicitBristol[1]) } : {}),
        ...(/\bloose|diarrh/.test(lower) ? { consistency: "loose" } : {}),
        ...(hasUrgency ? { urgency: true } : urgencyNegated ? { urgency: false } : {}),
        ...(hasBlood ? { blood: bloodAmount ?? "reported; amount not specified" } : {}),
        ...(bloodNegated ? { blood: "none" } : {}),
        ...(hasBlood && !bloodAmount ? { needsClarification: "bloodAmount" } : {}),
        ...(hasMucus ? { mucus: true } : mucusNegated ? { mucus: false } : {}),
        ...(hasNightWaking ? { nightWaking: true } : nightWakingNegated ? { nightWaking: false } : {}),
        ...safetyDetails,
      },
    });
    logged.push("the bowel movement");
  }

  if (!isQuestion && /(breakfast|lunch|dinner|ate|porridge|coffee|meal|snack|takeaway|drank|water)/.test(lower)) {
    entries.push({ kind: "MEAL", body: `${trimmed.replace(/^i\s+(had|ate)\s+/i, "")} — added neutrally; tap Edit to add ingredients, portion or hydration`, source: "chat", structured: { description: trimmed } });
    logged.push("the meal");
  }

  const painMatch = lower.match(/(?:pain|cramp(?:ing|s)?)[^0-9]{0,12}(10|[0-9])\s*(?:\/\s*10)?/);
  const pain = painMatch ? Number(painMatch[1]) : typeof safetyDetails.pain === "number" ? safetyDetails.pain : undefined;
  if (!isQuestion && pain !== undefined) {
    entries.push({ kind: "PAIN", body: `${pain}/10 — logged from chat`, source: "chat", flagged: pain >= 7, structured: { pain } });
    logged.push(`pain at ${pain}/10`);
  }
  if (!isQuestion && /(tired|fatigue|shattered|exhausted|knackered)/.test(lower)) {
    entries.push({ kind: "FATIGUE", body: "Fatigue reported in chat; severity not assumed", source: "chat", structured: { reportedText: trimmed } });
    logged.push("fatigue");
  }
  if (!isQuestion) {
    const wellbeing: Record<string, string | number | boolean> = {};
    const comparison = lower.match(/(?:feel(?:ing)?|been|i(?:'m| am))\s+(better|same|worse)\b|\b(better|same|worse)\s+than\s+(?:usual|normal)/)?.slice(1, 3).find(Boolean);
    const sleepMatch = lower.match(/(?:slept|sleep(?:ing)?(?:\s+for)?|got)\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
    const weightMatch = lower.match(/(?:weigh|weight(?:\s+is)?|i(?:'m| am))\s*(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b/);
    const moodMatch = lower.match(/(?:mood\s+(?:is\s+)?|feel(?:ing)?\s+)(anxious|low|irritable|good)\b/);
    const appetiteMatch = lower.match(/(?:appetite\s+(?:is\s+)?|feel(?:ing)?\s+)(reduced|low|poor|usual|increased)|\b(no appetite)\b/);
    if (comparison) wellbeing.wellbeing = comparison;
    if (sleepMatch) wellbeing.sleepHours = Number(sleepMatch[1]);
    if (weightMatch) wellbeing.weightKg = Number(weightMatch[1]);
    if (moodMatch) wellbeing.mood = moodMatch[1];
    if (appetiteMatch) wellbeing.appetite = appetiteMatch[2] ? "none" : appetiteMatch[1];
    if (Object.keys(wellbeing).length) {
      entries.push({ kind: "WELLBEING", body: `${trimmed} — logged from chat as an editable wellbeing record`, source: "chat", flagged: wellbeing.wellbeing === "worse", structured: wellbeing });
      logged.push("the wellbeing detail");
    }
  }
  if (!isQuestion && !profileProposals.some((proposal) => proposal.field === "pastMedicines") && /(took|taken).{0,24}(azathioprine|prednisolone|mesalazine|medicine|medication|dose)/.test(lower)) {
    entries.push({ kind: "MEDICATION", body: `${trimmed} — recorded as reported`, source: "chat", structured: { taken: true, reportedText: trimmed } });
    logged.push("the medication");
  }
  if (!isQuestion && /(night out|drinks|beers|alcohol|stressful|bereavement|travel)/.test(lower) && !/(breakfast|lunch|dinner|meal)/.test(lower)) {
    entries.push({ kind: "LIFE EVENT", body: `${trimmed} — added as context, without judging it as a cause`, source: "chat" });
    logged.push("the life event");
  }

  if (logged.length) {
    const structuredTriggers = [...new Set(entries.flatMap((entry) => screenStructuredEntry(entry, profile)))];
    if (structuredTriggers.length) {
      const level = safetyLevelForTriggers(structuredTriggers);
      return {
        entries,
        reply: {
          from: "penny",
          category: "general information",
          text: level === "emergency"
            ? "I saved an editable draft, but the separate safety screen found wording that needs urgent care now. Do not wait for Penny or a team message."
            : "I saved an editable draft and the separate safety screen found a reason for same-day clinical advice. Contact your IBD team or GP today; use urgent care if symptoms become severe or you cannot safely wait.",
        },
        safetyAlert: {
          level,
          triggers: structuredTriggers,
          message: "Structured details matched the app’s deterministic safety screen. This was not decided by AI.",
        },
        profileProposals,
      };
    }
    const needsBloodAmount = entries.some((entry) => entry.structured?.needsClarification === "bloodAmount");
    return {
      entries,
      reply: { from: "penny", category: "recorded fact", text: needsBloodAmount
        ? `I logged ${logged.join(" and ")} as an editable record. One safety-relevant detail is missing: how much blood did you notice — trace or small, moderate, heavy or continuous, none, or not sure? A few words is enough.`
        : `I logged ${logged.join(" and ")} in your journal. I left anything you didn’t specify as unconfirmed — use Edit on the entry to correct or complete it.${profileProposals.length ? " I also prepared a separate profile proposal for you to review; your PMH has not changed." : ""}` },
      profileProposals,
    };
  }

  if (profileProposals.length) {
    return {
      entries: [],
      profileProposals,
      reply: {
        from: "penny",
        category: "recorded fact",
        text: `I prepared ${profileProposals.length === 1 ? "a profile proposal" : `${profileProposals.length} profile proposals`} from that explicit history statement. Review the exact wording under Profile; nothing has been added to your PMH.`,
      },
    };
  }

  if (lower.includes("blood") && (lower.includes("panic") || isQuestion)) {
    return {
      entries: [],
      profileProposals,
      reply: { from: "penny", category: "general information", text: "A blood report needs context, so I won’t assume the amount or tell you it is harmless. Follow your care plan and contact the IBD advice line, particularly because your symptoms have changed for several days. Heavy or continuous bleeding, faintness, fever or severe pain needs urgent care now.", sources: [{ label: "Crohn’s & Colitis UK: Flare-ups", date: "Accessed 18 Jul 2026", detail: "Approved general information about signs of a flare-up and when to contact the IBD team; it does not replace personal clinical advice.", type: "guidance", url: "https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/symptoms/flare-ups" }] },
    };
  }
  if (lower.includes("ibuprofen") || lower.includes("nsaid")) {
    return {
      entries: [],
      profileProposals,
      reply: { from: "penny", category: "general information", text: "Approved IBD guidance says NSAIDs such as ibuprofen can worsen symptoms for some people. Ask your pharmacist or IBD team what is appropriate for you; this is general information, not a prescription decision.", sources: [{ label: "Crohn’s & Colitis UK: Crohn’s disease", date: "Accessed 18 Jul 2026", detail: "General information about pain relief and IBD", type: "guidance", url: "https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/understanding-crohns-and-colitis/crohns-disease" }] },
    };
  }

  return {
    entries: [],
    profileProposals,
    reply: { from: "penny", category: "general information", text: "Tell me a meal, symptom, medicine or worry in your own words. I’ll keep uncertain fields unconfirmed, show the source records I use, and route safety-sensitive wording through the separate red-flag screen." },
  };
}
