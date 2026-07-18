import type {
  ChatMessage,
  DemoState,
  JournalEntry,
  PhaseContent,
  PhaseId,
  TrendPoint,
} from "./types";

export const TODAY_DATE = "2026-07-17";

export const PHASE_LABELS: { id: PhaseId; label: string }[] = [
  { id: "stable", label: "Steady" },
  { id: "watch", label: "Watchful" },
  { id: "flare", label: "Flare" },
  { id: "recovery", label: "Recovery" },
];

const DAYS = ["4 Jul", "5", "6", "7", "8", "9", "10 Jul", "11", "12", "13", "14", "15", "16", "17 Jul"];

function trend(symptoms: number[], heartRates: number[], bowel: number[]): TrendPoint[] {
  return DAYS.map((day, index) => ({ day, symptom: symptoms[index], heartRate: heartRates[index], bowel: bowel[index] }));
}

export const TODAY: Record<PhaseId, PhaseContent> = {
  stable: {
    pill: { label: "Steady — at your baseline", className: "pill ok" },
    sub: "Friday 17 July · a quiet week, in a good way",
    gauge: { percent: 14, label: "Pennyssion" },
    metrics: [
      { k: "Bowel movements / day", v: "2.8", d: "at your 2–3 baseline", dClass: "ok" },
      { k: "Average pain", v: "0", unit: "/10", d: "usual for you", dClass: "flat" },
      { k: "Heart rate · resting / max", v: "58 / 96", unit: " bpm", d: "right on baseline", dClass: "ok" },
      { k: "Sleep", v: "8h 30m", d: "at your usual", dClass: "ok" },
    ],
    suggestions: [
      { kind: "experiment", icon: "note", title: "Oat milk experiment — day 9 of 14", desc: "No clear change so far — an observation, not proof.", cta: "Open experiment" },
      { kind: "summary", icon: "message", title: "Prepare your August clinic summary", desc: "Drafted from your journal — you edit before sharing.", cta: "Preview summary" },
    ],
    suggestionsNote: "When things are steady, Penny stays out of the way.",
    trend: trend([2, 2, 1, 2, 1, 2, 1, 1, 2, 1, 1, 1, 2, 1], [58, 57, 58, 58, 57, 58, 58, 57, 58, 58, 57, 58, 58, 58], [2, 2, 1, 2, 2, 2, 1, 2, 2, 1, 2, 2, 2, 2]),
  },
  watch: {
    pill: { label: "Watchful — symptoms rising", className: "pill watch" },
    sub: "Friday 17 July · here’s what your week is saying",
    gauge: { percent: 62, label: "Watchful" },
    metrics: [
      { k: "Bowel movements / day", v: "5.1", d: "↑ from 2.8 baseline", dClass: "up" },
      { k: "Average pain", v: "4", unit: "/10", d: "↑ from 2", dClass: "up" },
      { k: "Heart rate · resting / max", v: "64 / 104", unit: " bpm", d: "↑ 6 above baseline", dClass: "warn" },
      { k: "Sleep", v: "6h 30m", d: "below your usual", dClass: "warn" },
    ],
    suggestions: [
      { kind: "test", icon: "flask", title: "Order a calprotectin home test", desc: "Changes across two recorded days met the rule. Confirm the sources and delivery first.", cta: "Review test order" },
      { kind: "team", icon: "message", title: "Share this week with your IBD team", desc: "An editable draft with trends and flagged entries.", cta: "Review team message" },
    ],
    suggestionsNote: "Nothing is sent or ordered until you confirm.",
    trend: trend([2, 2, 1, 2, 2, 2, 3, 3, 3, 4, 6, 7, 7, 8], [58, 58, 57, 59, 58, 58, 59, 58, 59, 60, 62, 63, 64, 64], [2, 2, 2, 2, 3, 2, 3, 3, 3, 4, 5, 5, 6, 6]),
  },
  flare: {
    pill: { label: "Flare — extra support active", className: "pill flag" },
    sub: "Friday 17 July · your IBD team has this week’s picture",
    gauge: { percent: 90, label: "Flare" },
    metrics: [
      { k: "Bowel movements / day", v: "7.4", d: "↑ from 2.8 baseline", dClass: "up" },
      { k: "Average pain", v: "6", unit: "/10", d: "↑ from 2", dClass: "up" },
      { k: "Heart rate · resting / max", v: "67 / 146", unit: " bpm", d: "↑ 9 above baseline", dClass: "up" },
      { k: "Sleep", v: "5h 00m", d: "night waking · high fatigue", dClass: "up" },
    ],
    suggestions: [
      { kind: "urgent", icon: "phone", title: "Run today’s safety check", desc: "Heavy bleeding, severe pain, fever or faintness need urgent care.", cta: "Check symptoms" },
      { kind: "prescription", icon: "message", title: "Clinician-owned rescue pathway", desc: "Prepared only under your documented plan; Dr Ferreira must approve.", cta: "View prescription flow" },
    ],
    suggestionsNote: "Penny never prescribes or changes medicine. Contact your team first.",
    trend: trend([3, 3, 4, 4, 5, 5, 6, 7, 7, 8, 8, 9, 8, 8], [59, 60, 60, 61, 62, 62, 64, 65, 66, 67, 67, 68, 67, 67], [3, 3, 4, 4, 5, 5, 6, 6, 7, 8, 8, 8, 7, 7]),
  },
  recovery: {
    pill: { label: "Recovering — taper day 12 of 42", className: "pill ok" },
    sub: "Friday 17 July · settling, one prescribed dose at a time",
    gauge: { percent: 36, label: "Recovering" },
    metrics: [
      { k: "Bowel movements / day", v: "3.0", d: "↓ from 7.4 last week", dClass: "ok" },
      { k: "Average pain", v: "2", unit: "/10", d: "↓ from 6", dClass: "ok" },
      { k: "Heart rate · resting / max", v: "60 / 99", unit: " bpm", d: "nearly back to 58", dClass: "flat" },
      { k: "Sleep", v: "7h 45m", d: "climbing back to usual", dClass: "ok" },
    ],
    suggestions: [
      { kind: "taper", icon: "note", title: "Today’s prescribed dose: 25 mg", desc: "5 × 5 mg prednisolone with breakfast. Next step: 20 mg on Monday.", cta: "Open taper" },
      { kind: "summary", icon: "message", title: "Preview your recovery summary", desc: "An editable follow-up draft from your records.", cta: "Preview summary" },
    ],
    suggestionsNote: "Gutsy shows the verified prescription and cannot change it.",
    trend: trend([8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2], [67, 66, 66, 65, 64, 64, 63, 62, 62, 61, 61, 60, 60, 60], [7, 7, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 3]),
  },
};

export const ONBOARDING_TODAY: PhaseContent = {
  pill: { label: "Set up your private baseline", className: "pill watch" },
  sub: "Complete adult eligibility and health-data consent before tracking starts",
  gauge: { percent: 0, label: "Not yet set" },
  metrics: [
    { k: "Bowel baseline", v: "—", d: "Add what is usual for you", dClass: "flat" },
    { k: "Pain baseline", v: "—", d: "Not recorded", dClass: "flat" },
    { k: "Heart rate · resting / max", v: "—", d: "Optional", dClass: "flat" },
    { k: "Sleep", v: "—", d: "Not recorded", dClass: "flat" },
  ],
  suggestions: [],
  suggestionsNote: "Penny and health tracking remain off until onboarding and consent are complete.",
  trend: [],
};

export const INITIAL_CHAT: ChatMessage[] = [
  { id: 1, from: "penny", createdAt: "2026-07-17T08:12:00.000Z", category: "recorded fact", text: "Morning, Matthew. You logged more urgency than usual yesterday, and your watch shows your resting heart rate was up overnight. How are you feeling this morning?", sources: [
    { entryId: 2, label: "Watch sync", date: "17 Jul, 08:00", detail: "Resting heart rate 64 bpm", type: "fact" },
    { entryId: 6, label: "Bowel log", date: "16 Jul, 21:10", detail: "Urgency recorded", type: "fact" },
  ] },
  { id: 2, from: "me", createdAt: "2026-07-17T08:14:00.000Z", text: "Rough night honestly. Crampy, and I was up twice." },
  { id: 3, from: "penny", createdAt: "2026-07-17T08:14:30.000Z", category: "possible pattern", text: "I’m sorry it was a rough night. Several included records across two recorded days differ from your baseline, but they do not diagnose a flare. I’ve linked each source in Trends & evidence so you can correct it.", sources: [
    { entryId: 1, label: "Bowel log", date: "17 Jul, 07:40", detail: "Bristol type 6, urgency and a small amount of blood", type: "fact" },
    { entryId: 5, label: "Pain log", date: "16 Jul, 22:15", detail: "Pain 5/10 and high fatigue", type: "fact" },
    { entryId: 6, label: "Bowel log", date: "16 Jul, 21:10", detail: "Bristol type 6 with urgency", type: "fact" },
    { entryId: 2, label: "Watch sync", date: "17 Jul, 08:00", detail: "Resting heart rate 64 bpm and sleep 5 h 10 m", type: "fact" },
  ] },
  { id: 4, from: "me", createdAt: "2026-07-17T08:15:30.000Z", text: "There was a bit of blood again this morning. Should I be worried?" },
  { id: 5, from: "penny", createdAt: "2026-07-17T08:16:00.000Z", category: "general information", text: "A small amount of blood alongside looser stools is common during a bump like this, and on its own it isn’t an emergency. If bleeding becomes heavy or continuous, or you feel faint or feverish, that needs urgent care today. Given two days of change, this is exactly what your calprotectin home test is for — I’ve prepared the order for you to review." },
  { id: 6, from: "me", createdAt: "2026-07-17T08:18:00.000Z", text: "Ok, I’ll do the test. Anything else I should do today?" },
  { id: 7, from: "penny", createdAt: "2026-07-17T08:18:40.000Z", category: "general information", text: "Keep it gentle today: plenty of fluids, smaller and simpler meals, and log anything you notice — it all sharpens the picture. I’ve also drafted a short summary of your week for Jade, your IBD nurse. Nothing is sent until you’ve read and approved every word." },
  { id: 8, from: "me", createdAt: "2026-07-17T08:20:00.000Z", text: "Thanks. Porridge and a peppermint tea for breakfast, by the way." },
  { id: 9, from: "penny", createdAt: "2026-07-17T08:20:20.000Z", category: "recorded fact", text: "Logged: porridge and peppermint tea, 17 July. That’s a kind choice on a crampy morning. I’ll check in with you this evening — and if anything changes before then, just message me." },
];

function experimentHistory(): JournalEntry[] {
  return Array.from({ length: 9 }, (_, index) => {
    const recorded = new Date("2026-07-08T12:00:00.000Z");
    recorded.setUTCDate(recorded.getUTCDate() + index);
    return {
      id: 20 + index,
      date: recorded.toISOString().slice(0, 10),
      time: "08:30",
      kind: "LIFE EVENT",
      body: `Diet experiment check-in — day ${index + 1} of 14: Personal morning-urgency observation recorded.`,
      source: "manual",
      structured: { experimentEvent: "check-in", experimentId: "EXP-12", experimentObservation: "Personal morning-urgency observation recorded.", day: index + 1, durationDays: 14 },
    };
  });
}

export const INITIAL_ENTRIES: JournalEntry[] = [
  { id: 1, date: TODAY_DATE, time: "07:40", kind: "BOWEL MOVEMENT", body: "Bristol type 6, urgency, small amount of blood", source: "manual", flagged: true, structured: { bristol: 6, urgency: true, blood: "small", mucus: false, nightWaking: true, pain: 4 } },
  { id: 2, date: TODAY_DATE, time: "08:00", kind: "FROM YOUR WATCH", body: "Resting HR 64 bpm · HRV 38 ms · sleep 5 h 10 m — supporting context only", source: "wearable", structured: { restingHeartRate: 64, heartRateVariabilityMs: 38, sleepHours: 5.17, softSignal: true } },
  { id: 3, date: TODAY_DATE, time: "08:05", kind: "Penny noticed", body: "Several included records across 16–17 July differ from baseline: two Bristol type 6 bowel logs with urgency, one with a small amount of blood, pain up to 5/10 with high fatigue, and a resting heart rate of 64 bpm. Confirm the source records before acting.", source: "penny" },
  { id: 4, date: "2026-07-16", time: "19:30", kind: "MEAL", body: "Lamb madras, naan, two beers — out with friends", source: "manual", structured: { portion: "usual", hydration: "two beers" } },
  { id: 5, date: "2026-07-16", time: "22:15", kind: "PAIN", body: "Cramping, lower right, 5/10 · fatigue high", source: "manual", structured: { pain: 5, site: "lower right", fatigue: "high" } },
  { id: 6, date: "2026-07-16", time: "21:10", kind: "BOWEL MOVEMENT", body: "Bristol type 6 with urgency", source: "chat", structured: { bristol: 6, urgency: true } },
  { id: 7, date: "2026-07-13", time: "23:50", kind: "LIFE EVENT", body: "Night out — around six drinks, late night and takeaway", source: "manual" },
  { id: 8, date: "2026-07-12", time: "09:00", kind: "MEDICATION", body: "Azathioprine 100 mg taken", source: "manual", structured: { taken: true, doseMg: 100 } },
  ...experimentHistory(),
];

function taperDays(): DemoState["taper"]["days"] {
  const blocks = [30, 25, 20, 15, 10, 5];
  const start = new Date("2026-07-06T12:00:00.000Z");
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return { day: index + 1, doseMg: blocks[Math.floor(index / 7)], date: date.toISOString().slice(0, 10), taken: false };
  });
}

export const INITIAL_STATE: DemoState = {
  version: 2,
  phase: "watch",
  phaseConfirmed: false,
  messages: INITIAL_CHAT,
  profileProposals: [],
  entries: INITIAL_ENTRIES,
  profile: {
    name: "Matthew Johnson", timeZone: "Europe/London", dateOfBirth: "1992-03-18", diagnosis: "Crohn’s disease", subtype: "Ileocolonic", diagnosedYear: "2016", extent: "Terminal ileum and colon", surgeries: "Ileocecal resection, 2019", conditions: "Osteopenia; anxiety", allergies: "Penicillin — rash", immunosuppressed: true, familyHistory: "Maternal aunt with Crohn’s", usualBowel: "2–3 formed bowel movements/day (2.8 average)", usualPain: "1–2/10", usualHeartRate: "58 bpm resting", usualSleep: "7 hours", dietaryNeeds: "No formal exclusions; prefers oat milk", currentMedicines: "Azathioprine 100 mg daily", pastMedicines: "Mesalazine — stopped 2018, limited response", carePlan: "Contact St Mary’s IBD advice line if symptoms rise for 3 days, blood increases, or night waking begins.", address: "24 Marikina Road, London", postcode: "W2 1NY", adultEligibilityConfirmed: true, healthDataConsent: true, consentVersion: "demo-v1", consentRecordedAt: "2026-07-01T09:00:00.000Z", onboardingComplete: true,
  },
  contacts: [
    { id: "jade", initials: "JO", name: "Jade Johnson", role: "IBD Clinical Nurse Specialist", organisation: "St Mary’s IBD service", phone: "020 7946 0000" },
    { id: "rui", initials: "RF", name: "Dr Rui Ferreira", role: "Consultant gastroenterologist", organisation: "St Mary’s Hospital", phone: "020 7946 0100" },
    { id: "pharmacy", initials: "WP", name: "Wellfield Pharmacy", role: "Nominated pharmacy", organisation: "Marikina Road", phone: "020 7946 0200" },
  ],
  trustedSupporter: { enabled: false, name: "", relationship: "", canViewSummary: false, canSeeReminders: false, canHelpLog: false },
  testOrder: { id: "FC-2481", status: "prepared", clinicalOwner: "St Mary’s IBD service (simulated clinical owner)", eligibilityRule: "IBD-WATCH-CALPROTECTIN-DEMO-v1", eligibilityReason: "Configured sustained-change rule: at least two current included clinical signals across recorded days after patient evidence review; never an LLM- or image-only decision.", statusUpdatedAt: "2026-07-17T08:05:00.000Z", addressConfirmed: false, consent: false },
  teamMessage: { id: "MSG-104", subject: "Recent recorded symptoms for Matthew Johnson", body: "Matthew has two included bowel records across 16–17 July; both record Bristol type 6 with urgency, and one records a small amount of blood and night waking. A separate record notes pain up to 5/10 with high fatigue. The latest included watch record is resting heart rate 64 bpm versus a recorded 58 bpm baseline, with 5 h 10 m sleep versus a recorded usual 7 hours. These records do not establish total daily bowel frequency. A home calprotectin test is prepared but not yet ordered. Please review the attached entries and advise on the agreed pathway.", status: "draft", statusUpdatedAt: "2026-07-17T08:05:00.000Z", clinicalOwner: "St Mary’s IBD service (simulated clinical owner)", notificationRule: "IBD-CHANGE-NOTIFY-DEMO-v1", notificationReason: "Patient-reviewed sustained-change evidence prepared a contact-first draft; nothing is sent until the patient reviews and approves every word.", expectedResponse: "Within one working day" },
  teamMessageHistory: [],
  teamMessageStale: false,
  prescription: { status: "prepared", medicine: "Prednisolone course — dose set by prescriber", prescriber: "Dr Rui Ferreira", pharmacy: "Wellfield Pharmacy", clinicalOwner: "Dr Rui Ferreira (simulated prescribing owner)", eligibilityRule: "IBD-RESCUE-PRED-DEMO-v1", eligibilityReason: "A documented rescue pathway still requires confirmed Flare support, an included raised objective result and explicit prescriber authorisation.", rescuePlanEligible: true, reviewAfterHours: 24 },
  taper: { verified: true, medicine: "Prednisolone", prescribedBy: "Dr Rui Ferreira", currentDay: 12, days: taperDays(), missedDays: [], sideEffects: [], checkInComplete: false },
  experiment: { id: "EXP-12", title: "Oat milk instead of dairy milk", variable: "Milk choice only", goal: "See whether morning urgency changes", baseline: "Morning urgency score 3/10 before day 1 (patient-entered)", outcome: "Morning urgency score", startDate: "2026-07-08", durationDays: 14, day: 9, status: "paused", observations: Array.from({ length: 9 }, (_, index) => `Day ${index + 1}: Personal morning-urgency observation recorded.`), reviewRequired: false },
  wearable: { provider: "Apple Health", connected: true, heartRate: true, hrv: true, sleep: true, activity: true, lastSync: "Today, 08:00" },
  privacy: { photoRetentionDays: 30, toiletPhotoConsent: false, assistantProfileAccess: true, assistantJournalAccess: true, assistantCareAccess: true, assistantConversationAccess: true, secondaryUseConsent: false, discreetNotifications: true, notificationBudget: "balanced" },
  clinicianSummary: "Matthew has two included bowel records across 16–17 July; both record Bristol type 6 with urgency, and one records a small amount of blood and night waking. A separate record notes pain up to 5/10 with high fatigue. The latest included watch record is resting heart rate 64 bpm versus a recorded 58 bpm baseline, with 5 h 10 m sleep versus a recorded usual 7 hours. These records do not establish total daily bowel frequency. A home calprotectin test has been prepared but requires Matthew’s confirmation. Current treatment: azathioprine 100 mg daily. The prepared prednisolone schedule has no doses marked taken or missed. No medication change has been made by Gutsy.",
  clinicianSummaryEdited: false,
  clinicianSummaryStale: false,
  audit: [{ id: 1, at: "17 Jul, 08:05", action: "Penny surfaced several included records across two recorded days for patient review." }],
};

export const CHAT_CHIPS = [
  "Loose stool with a bit of blood this morning",
  "Pain’s about a 6 and I’m shattered",
  "Porridge and a coffee for breakfast",
  "Is the blood something to panic about?",
];
