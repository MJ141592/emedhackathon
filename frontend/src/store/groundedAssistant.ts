import type { ChatMessage, DemoState, EvidenceSource, JournalEntry } from "../types";
import { taperTreatmentActive } from "./recoveryGovernance";
import { dateInTimeZone } from "./patientTime";
import { deriveFoodSymptomPatterns } from "./dashboardDerivations";

type Reply = Omit<ChatMessage, "id" | "createdAt">;

const APPROVED_GUIDANCE = {
  flare: {
    label: "Crohn’s & Colitis UK: Flare-ups",
    url: "https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/symptoms/flare-ups",
    detail: "Approved general information about flare signs and contacting the IBD team; personal care plans still take priority.",
  },
  food: {
    label: "Crohn’s & Colitis UK: Food and IBD",
    url: "https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/living-with-crohns-or-colitis/food",
    detail: "Approved general food guidance; major exclusions should be reviewed with an IBD team or dietitian.",
  },
  steroids: {
    label: "Crohn’s & Colitis UK: Steroids",
    url: "https://crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/treatments/steroids",
    detail: "Approved general steroid-course guidance; only an authorised clinician can set or change a dose.",
  },
  calprotectin: {
    label: "NICE: Faecal calprotectin diagnostic tests",
    url: "https://www.nice.org.uk/guidance/htg320/chapter/1-recommendations",
    detail: "Approved general information about calprotectin testing inside a quality-assured clinical pathway.",
  },
  ibd: {
    label: "Crohn’s & Colitis UK: Crohn’s disease",
    url: "https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/understanding-crohns-and-colitis/crohns-disease",
    detail: "Approved general IBD education; an individual diagnosis and treatment plan belong with the clinical team.",
  },
} as const;

function approvedSource(key: keyof typeof APPROVED_GUIDANCE): EvidenceSource {
  const guidance = APPROVED_GUIDANCE[key];
  return { ...guidance, date: "Approved guidance · checked 18 Jul 2026", type: "guidance" };
}

function entrySource(entry: JournalEntry, type: EvidenceSource["type"] = "fact"): EvidenceSource {
  return { entryId: entry.id, label: entry.kind, date: `${entry.date}, ${entry.time}`, detail: entry.body, type, excluded: entry.excluded };
}

function latestIncluded(state: DemoState, kinds: JournalEntry["kind"][], limit = 4): JournalEntry[] {
  return state.entries
    .filter((entry) => !entry.excluded && kinds.includes(entry.kind))
    .sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`))
    .slice(0, limit);
}

export function answerFromPermittedRecords(state: DemoState, question: string): Reply | null {
  const lower = question.toLowerCase();

  if (/\b(what did i (?:tell|say|mention)|what have i (?:told|said|mentioned)|did i (?:tell|say|mention)|earlier (?:message|conversation)|our (?:earlier |previous )?conversation)\b/.test(lower)) {
    if (!state.privacy.assistantConversationAccess) {
      return {
        from: "penny",
        category: "general information",
        text: "Earlier-conversation access is off, so I cannot retrieve what you previously told Penny. You can review the conversation yourself or enable that separate permission in Privacy.",
      };
    }
    const priorMessages = state.messages
      .filter((message) => message.from === "me")
      .slice(-5)
      .reverse();
    if (!priorMessages.length) {
      return { from: "penny", category: "recorded fact", text: "There are no earlier patient messages in this conversation to retrieve.", sources: [] };
    }
    return {
      from: "penny",
      category: "recorded fact",
      text: `Your ${priorMessages.length === 1 ? "most recent earlier message was" : `${priorMessages.length} most recent earlier messages were`}: ${priorMessages.map((message) => `“${message.text}”`).join("; ")}. These are conversation records, not independently verified facts.`,
      sources: priorMessages.map((message) => ({
        messageId: message.id,
        label: "Earlier patient message",
        date: message.createdAt,
        detail: message.text,
        type: "fact" as const,
      })),
    };
  }

  if (/\b(food|meal|eat|ate).{0,32}(pattern|trigger|cause|symptom|pain|bowel|urgency)|\b(pattern|trigger|cause).{0,32}(food|meal|eat|ate)\b/.test(lower)) {
    if (!state.privacy.assistantJournalAccess) return { from: "penny", category: "general information", text: "Journal access is off, so I cannot align meals with later symptom records. You can review both directly in your journal or enable that permission in Privacy." };
    const pattern = deriveFoodSymptomPatterns(state, 12, 1)[0];
    if (!pattern) return { from: "penny", category: "recorded fact", text: "I could not find an included meal followed by an included symptom record inside the bounded 12-hour diary window. That is missing diary evidence, not proof that food is unrelated.", sources: [] };
    return {
      from: "penny",
      category: "possible pattern",
      text: `${pattern.summary} ${pattern.disclaimer} I have cited the exact source entries so you can correct or exclude any of them.`,
      sources: pattern.sources.map((entry) => entrySource(entry, "pattern")),
    };
  }

  if (/\b(what did i (?:eat|have)|what have i eaten|which meals? did i|food (?:did i )?(?:log|record)|bad weekend|before that)\b/.test(lower)) {
    if (!state.privacy.assistantJournalAccess) return { from: "penny", category: "general information", text: "Journal access is off, so I cannot retrieve meals or events. You can review them manually in your journal or enable that permission in Privacy." };
    const records = latestIncluded(state, ["MEAL", "LIFE EVENT"], 5);
    if (!records.length) return { from: "penny", category: "recorded fact", text: "I could not find an included meal or life-event record for that question.", sources: [] };
    return { from: "penny", category: "recorded fact", text: `I found ${records.length} recent included meal or event record${records.length === 1 ? "" : "s"}. These are records, not proof that anything caused symptoms: ${records.map((entry) => entry.body).join("; ")}.`, sources: records.map((entry) => entrySource(entry)) };
  }

  if (/\b(current|my|taking|take).{0,18}(medicine|medication|drug)|azathioprine/.test(lower) && !/\b(drink|alcohol|beer|wine)\b/.test(lower)) {
    if (!state.privacy.assistantProfileAccess) return { from: "penny", category: "general information", text: "Profile and PMH access is off, so I cannot retrieve your medicine list. Check the medicine label or ask your pharmacist or IBD team for personal advice." };
    return { from: "penny", category: "recorded fact", text: state.profile.currentMedicines ? `Your patient-maintained profile records: ${state.profile.currentMedicines}. Please correct the profile if that is no longer current.` : "Your profile does not currently contain a medicine list.", sources: state.profile.currentMedicines ? [{ target: "profile", label: "Current medicines in profile", date: "Current patient-maintained record", detail: state.profile.currentMedicines, type: "fact" }] : [] };
  }

  if (/\b(drink|alcohol|beer|wine).{0,24}(azathioprine|medicine|medication)|\bazathioprine.{0,24}(drink|alcohol)/.test(lower)) {
    const profileSource: EvidenceSource[] = state.privacy.assistantProfileAccess && state.profile.currentMedicines ? [{ target: "profile", label: "Current medicines in profile", date: "Current patient-maintained record", detail: state.profile.currentMedicines, type: "fact" }] : [];
    return { from: "penny", category: "general information", text: `I cannot decide what is safe for you to drink. ${profileSource.length ? "Your profile records azathioprine, but " : "Because profile access is off, I have not checked your medicines; "}use the medicine leaflet and ask your pharmacist or IBD team about alcohol, liver monitoring and your own circumstances.`, sources: [...profileSource, { label: "NHS azathioprine common questions", date: "Official NHS medicines guidance · checked July 2026", detail: "General azathioprine information; personal medicine decisions remain with the pharmacist or clinical team.", type: "guidance", url: "https://www.nhs.uk/medicines/azathioprine/common-questions-about-azathioprine/" }] };
  }

  if (/\b(allerg(?:y|ies|ic)|medical history|past medical|pmh|conditions?|immunosuppress(?:ed|ion))\b/.test(lower)) {
    if (!state.privacy.assistantProfileAccess) return { from: "penny", category: "general information", text: "Profile and PMH access is off, so I cannot retrieve conditions, allergies or immunosuppression status." };
    const facts = [
      state.profile.conditions && `Conditions: ${state.profile.conditions}`,
      state.profile.allergies && `Allergies: ${state.profile.allergies}`,
      `Immunosuppression status: ${state.profile.immunosuppressed ? "recorded as immunosuppressed" : "not recorded as immunosuppressed"}`,
      state.profile.surgeries && `Prior surgery: ${state.profile.surgeries}`,
    ].filter((value): value is string => Boolean(value));
    return {
      from: "penny",
      category: "recorded fact",
      text: `Your patient-maintained history records: ${facts.join("; ")}. Please correct Profile if any of this is outdated.`,
      sources: facts.map((detail) => ({ target: "profile" as const, label: "Patient-maintained PMH", date: "Current profile record", detail, type: "fact" as const })),
    };
  }

  if (/\b(prednisolone|steroid).{0,35}(risk|safe|side effect|infection|bone|osteop|diabet|mood)|\b(osteop|diabet|infection).{0,35}(prednisolone|steroid)\b/.test(lower)) {
    if (!state.privacy.assistantProfileAccess) return { from: "penny", category: "general information", text: "Profile and PMH access is off, so I cannot check personal risk context. Ask your pharmacist, prescriber or IBD team before making any medicine decision." };
    const relevant = [
      state.profile.conditions && `Recorded conditions: ${state.profile.conditions}`,
      state.profile.allergies && `Recorded allergies: ${state.profile.allergies}`,
      state.profile.immunosuppressed && "Profile records immunosuppression, which makes possible infection important to raise promptly.",
    ].filter((value): value is string => Boolean(value));
    return {
      from: "penny",
      category: "general information",
      text: `I cannot decide whether a steroid is safe or change its dose. ${relevant.join(" ")} These records are context—not a clinical conclusion—so use the prescribed plan and ask your prescriber or pharmacist about infection, bone, mood, glucose or other personal risks.`,
      sources: [
        ...relevant.map((detail) => ({ target: "profile" as const, label: "Relevant PMH context", date: "Current patient-maintained profile", detail, type: "fact" as const })),
        { label: "NHS prednisolone safety information", date: "Official NHS medicines guidance · checked July 2026", detail: "General prednisolone information; steroid risk assessment and changes belong with the authorised clinical team.", type: "guidance" as const, url: "https://www.nhs.uk/medicines/prednisolone/who-can-and-cannot-take-prednisolone-tablets-and-liquid/" },
      ],
    };
  }

  if (/\b(baseline|usual|normal for me)/.test(lower)) {
    if (!state.privacy.assistantProfileAccess) return { from: "penny", category: "general information", text: "Profile access is off, so I cannot retrieve your personal baseline." };
    const detail = [state.profile.usualBowel, state.profile.usualPain, state.profile.usualHeartRate, state.profile.usualSleep].filter(Boolean).join("; ");
    return { from: "penny", category: "recorded fact", text: detail ? `Your maintained baseline says: ${detail}.` : "Your personal baseline has not been completed yet.", sources: detail ? [{ target: "profile", label: "Personal baseline", date: "Current patient-maintained profile", detail, type: "fact" }] : [] };
  }

  if (/\b(what (?:is|does)|how does|why (?:do|is)).{0,25}(faecal |fecal )?calprotectin|\bcalprotectin.{0,20}(mean|measure|work)\b/.test(lower)
    && !/\b(my|status|result|order|ordered|kit|delivery|posted|lab)\b/.test(lower)) {
    return {
      from: "penny",
      category: "general information",
      text: "Faecal calprotectin is a stool marker that can provide objective evidence of intestinal inflammation. It does not diagnose a flare by itself: the IBD team interprets a result alongside symptoms, history and the local care pathway.",
      sources: [approvedSource("calprotectin")],
    };
  }

  if (/\b(why|how|can|should|must|what).{0,32}(steroid|prednisolone|taper)|\b(steroid|prednisolone).{0,32}(course|taper|stop|suddenly)\b/.test(lower)
    && !/\b(today'?s|my|current|prescribed|what dose|how (?:much|many)|missed)\b/.test(lower)) {
    return {
      from: "penny",
      category: "general information",
      text: "Steroids can be used for a limited clinician-prescribed course to control inflammation. A prescribed course or taper should be followed exactly and not stopped suddenly. Penny can display a verified schedule, but only the authorised prescriber can start, stop or change it.",
      sources: [approvedSource("steroids")],
    };
  }

  if (/\b(what|which|how).{0,28}(eat|food|diet|fibre|fiber|dairy)|\b(food|diet).{0,24}(trigger|avoid|exclude|safe)|\b(elimination|low[- ]?residue) diet\b/.test(lower)) {
    return {
      from: "penny",
      category: "general information",
      text: "There is no single diet that works for everyone with Crohn’s or Colitis. A food diary may help you notice personal observations, but it cannot prove a food caused symptoms. Discuss major exclusions, weight loss or nutritional risk with your IBD team or dietitian.",
      sources: [approvedSource("food")],
    };
  }

  if (/\b(what|which) (?:are |signs? |symptoms? )?.{0,24}(?:an? |in an? |during an? )?(?:ibd )?flare(?:-up)?\b|\b(signs?|symptoms?) (?:can happen |of ).{0,20}(?:an? |ibd )?flare(?:-up)?\b|\b(how (?:do|can) i recognise|could this be).{0,24}(?:an? )?flare(?:-up)?\b|\bflare(?:-up)?.{0,20}(signs?|symptoms?|mean)\b/.test(lower)) {
    return {
      from: "penny",
      category: "general information",
      text: "A flare means symptoms or inflammation may be more active, but signs vary between people. Changes can include more frequent or looser stools, blood, urgency, pain, fatigue or night waking. Follow your personal care plan or contact your IBD team; heavy bleeding, severe pain, fever, faintness, dehydration or obstruction symptoms need urgent assessment.",
      sources: [approvedSource("flare")],
    };
  }

  if (/\b(stress|meal|food|sleep|alcohol).{0,24}(cause|caused|trigger).{0,20}(flare|symptoms?)|\bcorrelation|\bprove(?:d)? (?:a )?trigger\b/.test(lower)) {
    return {
      from: "penny",
      category: "general information",
      text: "A repeated diary pattern can be useful to discuss, but timing alone does not prove cause. Gutsy keeps recorded facts separate from possible patterns and lets you correct or exclude every source before sharing an observation.",
      sources: [approvedSource("food"), approvedSource("flare")],
    };
  }

  if (/\b(what is|explain|difference between).{0,24}(crohn'?s|colitis|inflammatory bowel disease|\bibd\b)/.test(lower)) {
    return {
      from: "penny",
      category: "general information",
      text: "Inflammatory bowel disease is the umbrella term for conditions including Crohn’s disease and ulcerative colitis. They can affect people differently, so diagnosis, monitoring and treatment are individual clinical decisions rather than something Penny infers from a chat.",
      sources: [approvedSource("ibd")],
    };
  }

  if (/\b(my|our|status|result|order|ordered|kit|delivery|posted|lab).{0,30}(calprotectin|home test|test)|\b(calprotectin|home test|kit).{0,30}(status|result|order|delivery|arrive|posted|lab)\b/.test(lower)) {
    if (!state.privacy.assistantCareAccess) return { from: "penny", category: "general information", text: "Care-record access is off, so I cannot retrieve your test order or result. You can still inspect it directly under Care." };
    const order = state.testOrder;
    const detail = order.result == null ? `Home-test status: ${order.status}; no result is recorded.` : `Home-test status: ${order.status}; result ${order.result} µg/g. The IBD team must interpret it with symptoms.`;
    return { from: "penny", category: "recorded fact", text: detail, sources: [{ target: "care", label: "Calprotectin workflow", date: "Current care record", detail, type: "fact" }] };
  }

  if (/\b(today'?s|my|current|prescribed|what).{0,20}(dose|taper|prednisolone|steroid)|\b(steroid|prednisolone).{0,12}(dose|schedule)\b/.test(lower)) {
    if (!state.privacy.assistantCareAccess) return { from: "penny", category: "general information", text: "Care-record access is off, so I cannot retrieve the prescribed taper. Check the medicine label and Care screen or contact your pharmacist." };
    if (!taperTreatmentActive(state)) return { from: "penny", category: "general information", text: "Dose support is not active, so I cannot present a current dose or dose action. The imported clinician schedule remains available for review and verification in Care; use the medicine label or contact your pharmacist or IBD team if a dose is due." };
    const patientToday = dateInTimeZone(new Date(), state.profile.timeZone);
    const day = state.taper.days.find((candidate) => candidate.date === patientToday);
    if (!state.taper.verified) return { from: "penny", category: "general information", text: "No verified clinician-authored dose is available in the care record. Do not calculate or change a dose in Gutsy." };
    if (!day) return { from: "penny", category: "recorded fact", text: `The verified clinician-authored schedule has no dose dated ${patientToday} in your recorded home time zone. Check the dispensing label or contact your pharmacist or IBD team if that is unexpected.`, sources: [{ target: "care", label: "Verified prescribed taper", date: patientToday, detail: "No schedule row is recorded for this patient-local calendar date.", type: "fact" }] };
    const detail = `Verified ${state.taper.medicine} taper day ${day.day}: ${day.doseMg} mg, prescribed by ${state.taper.prescribedBy}; ${day.taken ? "recorded taken" : "not yet confirmed taken"}.`;
    return { from: "penny", category: "recorded fact", text: detail, sources: [{ target: "care", label: "Verified prescribed taper", date: day.date, detail, type: "fact" }] };
  }

  if (/\b(care plan|contact|nurse|gastro|pharmacist|pharmacy)\b/.test(lower)) {
    if (!state.privacy.assistantCareAccess) return { from: "penny", category: "general information", text: "Care-record access is off, so I cannot retrieve named contacts. Urgent help remains available at all times." };
    const detail = state.contacts.map((contact) => `${contact.name} — ${contact.role}, ${contact.phone}`).join("; ");
    return { from: "penny", category: "recorded fact", text: detail ? `Your maintained care contacts are: ${detail}. A team message is not an emergency route.` : "No named care contacts are recorded.", sources: detail ? [{ target: "care", label: "Care contacts", date: "Current patient-maintained record", detail, type: "fact" }] : [] };
  }

  if (/\b(what changed|why.{0,12}(watch|worse)|recent symptoms|this week)\b/.test(lower)) {
    if (!state.privacy.assistantJournalAccess) return { from: "penny", category: "general information", text: "Journal access is off, so I cannot explain a pattern from your source entries." };
    const records = latestIncluded(state, ["BOWEL MOVEMENT", "PAIN", "FATIGUE", "WELLBEING", "FROM YOUR WATCH"], 5);
    return records.length ? { from: "penny", category: "possible pattern", text: "Several recent included records may have moved together. That is a possible pattern, not a diagnosis; review or correct every cited source in Trends & evidence.", sources: records.map((entry) => entrySource(entry, "pattern")) } : { from: "penny", category: "recorded fact", text: "There are no included recent symptom records to compare." };
  }

  return null;
}
