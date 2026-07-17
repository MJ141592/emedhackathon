import type { ChatMessage, JournalEntry, PhaseContent, PhaseId } from "./types";

export const PHASE_LABELS: { id: PhaseId; label: string }[] = [
  { id: "stable", label: "Steady" },
  { id: "watch", label: "Watchful" },
  { id: "flare", label: "Flare" },
  { id: "recovery", label: "Recovery" },
];

export const TODAY: Record<PhaseId, PhaseContent> = {
  stable: {
    pill: { label: "Steady — at your baseline", className: "pill ok" },
    sub: "Friday 17 July · a quiet week, in a good way",
    gauge: { percent: 14, label: "Remission" },
    metrics: [
      { k: "Bowel movements / day", v: "1.8", d: "at your 1–2 baseline", dClass: "ok" },
      { k: "Average pain", v: "1", unit: "/10", d: "usual for you", dClass: "flat" },
      { k: "Resting heart rate", v: "58", unit: " bpm", d: "right on baseline", dClass: "ok" },
      { k: "Fatigue", v: "Low", d: "1 of the last 7 days", dClass: "flat" },
    ],
    suggestions: [
      {
        icon: "note",
        title: "Oat milk experiment — day 9 of 14",
        desc: "No symptom change so far. One variable at a time, results are observations not proof.",
        cta: "View",
      },
      {
        icon: "message",
        title: "Prepare your August clinic summary",
        desc: "Penny drafts it from your journal — you edit before anything is shared.",
        cta: "Preview",
      },
    ],
    suggestionsNote: "When things are steady, Penny stays out of the way.",
  },
  watch: {
    pill: { label: "Watchful — symptoms rising", className: "pill watch" },
    sub: "Friday 17 July · here's what your week is saying",
    gauge: { percent: 62, label: "Watchful" },
    metrics: [
      { k: "Bowel movements / day", v: "5.1", d: "↑ from 2.8 baseline", dClass: "up" },
      { k: "Average pain", v: "4", unit: "/10", d: "↑ from 2", dClass: "up" },
      { k: "Resting heart rate", v: "64", unit: " bpm", d: "↑ 6 above baseline", dClass: "warn" },
      { k: "Fatigue", v: "High", d: "4 of the last 7 days", dClass: "flat" },
    ],
    suggestions: [
      {
        icon: "flask",
        title: "Order a calprotectin home test",
        desc: "Six days of rising symptoms — a stool test would confirm whether inflammation is driving this.",
        cta: "Order kit",
      },
      {
        icon: "message",
        title: "Share this week with your IBD team",
        desc: "Sends your trends and flagged entries to the St Mary's IBD nurses for review.",
        cta: "Review & send",
      },
    ],
    suggestionsNote: "Penny suggests — you decide. Nothing is sent or ordered until you confirm, and prescriptions are always approved by a clinician.",
  },
  flare: {
    pill: { label: "Flare — extra support active", className: "pill flag" },
    sub: "Friday 17 July · your IBD team has this week's picture",
    gauge: { percent: 90, label: "Flare" },
    metrics: [
      { k: "Bowel movements / day", v: "7.4", d: "↑ from 2.8 baseline", dClass: "up" },
      { k: "Average pain", v: "6", unit: "/10", d: "↑ from 2", dClass: "up" },
      { k: "Resting heart rate", v: "67", unit: " bpm", d: "↑ 9 above baseline", dClass: "up" },
      { k: "Fatigue", v: "High", d: "7 of the last 7 days", dClass: "flat" },
    ],
    suggestions: [
      {
        icon: "phone",
        title: "IBD advice line — call anytime",
        desc: "Jade Okafor read yesterday's update. Heavy bleeding, severe pain or fever: 111 or 999 now, not an app.",
        cta: "Call",
      },
      {
        icon: "message",
        title: "Review tonight's update to your team",
        desc: "Penny drafts a short evening summary of today's entries — you approve before it sends.",
        cta: "Review",
      },
    ],
    suggestionsNote: "A steroid course request is with Dr Ferreira — nothing is dispensed until a prescriber approves.",
  },
  recovery: {
    pill: { label: "Recovering — taper day 12 of 42", className: "pill ok" },
    sub: "Friday 17 July · settling, one dose at a time",
    gauge: { percent: 36, label: "Recovering" },
    metrics: [
      { k: "Bowel movements / day", v: "3.0", d: "↓ from 7.4 last week", dClass: "ok" },
      { k: "Average pain", v: "2", unit: "/10", d: "↓ from 6", dClass: "ok" },
      { k: "Resting heart rate", v: "60", unit: " bpm", d: "nearly back to 58", dClass: "flat" },
      { k: "Sleep", v: "6h 10m", d: "still below your usual", dClass: "warn" },
    ],
    suggestions: [
      {
        icon: "note",
        title: "Today's dose: 25 mg prednisolone",
        desc: "5 × 5 mg with breakfast · steps down to 20 mg on Monday. Penny never changes a dose — every step is Dr Ferreira's prescription.",
        cta: "Mark as taken",
      },
      {
        icon: "message",
        title: "Preview your recovery summary",
        desc: "Adherence 12/12, symptoms settling, sleep still short. Ready for your 4 August follow-up.",
        cta: "Preview",
      },
    ],
    suggestionsNote: "Missed a dose? Penny shows approved guidance and a direct line to your pharmacist — never guesswork.",
  },
};

export const INITIAL_CHAT: ChatMessage[] = [
  {
    id: 1,
    from: "penny",
    text: "Morning, Amara. You logged more urgency than usual yesterday, and your watch shows your resting heart rate was up overnight. How are you feeling this morning?",
  },
  {
    id: 2,
    from: "me",
    text: "Rough night honestly. Crampy, and I was up twice. Also what does “urgency” actually count as? I never know if I'm logging it right.",
  },
  {
    id: 3,
    from: "penny",
    text: "Urgency means a sudden, hard-to-hold need to get to the toilet — the kind where you have to stop what you're doing right away. A normal signal you can comfortably wait on doesn't count. From what you've described this week, you're logging it right.",
  },
];

export const CHAT_CHIPS = [
  "Loose stool with a bit of blood this morning",
  "Pain's about a 6 and I'm shattered",
  "Porridge and a coffee for breakfast",
  "Is the blood something to panic about?",
];

export const INITIAL_TODAY_ENTRIES: JournalEntry[] = [
  {
    id: 1,
    time: "07:40",
    kind: "BOWEL MOVEMENT",
    body: "Bristol type 6, urgency, small amount of blood",
    flagged: true,
  },
  {
    id: 2,
    time: "08:00",
    kind: "FROM YOUR WATCH",
    body: "Resting HR 64 bpm · sleep 5 h 10 m — both outside your usual range",
  },
  {
    id: 3,
    time: "08:05",
    kind: "Penny noticed",
    body: "Blood this morning, a rising heart rate, and six days of looser stools fit an early flare pattern. Worth confirming with a calprotectin test before anything else.",
    penny: true,
  },
];

export const YESTERDAY_ENTRIES: JournalEntry[] = [
  {
    id: -1,
    time: "19:30",
    kind: "MEAL",
    body: "Lamb madras, naan, two beers — out with friends 📷",
  },
  {
    id: -2,
    time: "22:15",
    kind: "PAIN",
    body: "Cramping, lower right, 5/10 · fatigue high",
  },
];
