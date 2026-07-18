import type { DemoState, Experiment, Profile } from "../types";

const REVIEW_PATTERN = /\b(restrict(?:ive|ion)|eliminat(?:e|ion)|remove|cut out|avoid all|fast(?:ing)?|keto|very low|low[- ]fodmap|gluten[- ]free|dairy[- ]free|weight loss|lose weight|whole food group|eat only|only (?:eat|drink)|juice cleanse|cleanse|liquid[- ]only|carnivore|skip(?:ping)? (?:a |one )?meal|no food(?: for)?(?: \d+)? ?h(?:ours?)?)\b/i;
const REVIEW_REQUEST_PATTERN = /\b(diet|dietitian|nutrition|experiment)\b/i;
const REVIEW_REPLY_PATTERN = /\b(approv(?:e|ed)|appropriate|safe to|may (?:start|proceed)|can (?:start|proceed)|proceed|okay to (?:start|proceed)|ok to (?:start|proceed))\b/i;
const REVIEW_REJECTION_PATTERN = /\b(not approved|not appropriate|do not (?:start|proceed)|should not|cannot|can't|must not|unsafe|not safe|danger(?:ous)?|contraindicat(?:ed|ion)|avoid(?: this)?)\b/i;
const NUTRITIONAL_VULNERABILITY_PATTERN = /\b(short bowel|malnutrition|malnourished|underweight|unintentional weight loss|eating disorder|feeding tube|enteral nutrition|parenteral nutrition|bowel obstruction|active stricture|food allerg(?:y|ies))\b/i;
const BASELINE_INSTRUCTION_PATTERN = /^(?:(?:please\s+)?(?:record|measure|track|enter|add|capture)\b|to\s+(?:record|measure|track|enter|add|capture)\b|not recorded\b|tbd\b|pending\b)/i;
const BASELINE_FUTURE_PATTERN = /\b(?:(?:i|we)\s+)?(?:will|shall|should|need to|plan to|intend to|(?:am|are) going to)\s+(?:record|measure|track|enter|add|capture)\b/i;
const BASELINE_GENERAL_FUTURE_PATTERN = /\b(?:will be|shall be|intend(?:ed)? to|plan(?:ned)? to|(?:am|are) going to|expect(?:ed)? to)\b/i;

export type RankedExperimentCandidate = {
  experiment: Experiment;
  rankScore: number;
  scores: {
    usefulness: number;
    safety: number;
    ease: number;
    measurability: number;
  };
  risk: "Low" | "Clinical review";
  rationale: string[];
};

export const SIMULATED_EXPERIMENT_REVIEWER = "IBD team (simulated)";

export function experimentRequiresReview(
  experiment: Pick<Experiment, "title" | "variable" | "goal" | "outcome" | "durationDays">,
  profile?: Pick<Profile, "conditions" | "surgeries" | "dietaryNeeds" | "allergies">,
): boolean {
  const text = [experiment.title, experiment.variable, experiment.goal, experiment.outcome].join(" ");
  const profileContext = profile ? [profile.conditions, profile.surgeries, profile.dietaryNeeds, profile.allergies].join(" ") : "";
  const allergyTerms = profile?.allergies.toLocaleLowerCase().match(/[a-z][a-z-]{2,}/g)
    ?.map((token) => token.replace(/s$/, ""))
    .filter((token) => !["allergy", "allergie", "allergic", "reaction", "unknown", "none"].includes(token)) ?? [];
  const allergyConflict = allergyTerms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i").test(text));
  return REVIEW_PATTERN.test(text) || experiment.durationDays > 28 || NUTRITIONAL_VULNERABILITY_PATTERN.test(profileContext) || allergyConflict;
}

export function experimentReviewDefinition(experiment: Experiment): string {
  return [
    `candidate id ${experiment.id}`,
    `title ${experiment.title}`,
    `variable ${experiment.variable}`,
    `goal ${experiment.goal}`,
    `baseline ${experiment.baseline}`,
    `outcome ${experiment.outcome}`,
    `duration ${experiment.durationDays} days`,
  ].join(" ").toLocaleLowerCase().trim().replace(/\s+/g, " ");
}

export function experimentCheckInDates(state: Pick<DemoState, "entries" | "experiment">, experimentId = state.experiment.id): string[] {
  return [...new Set(state.entries
    .filter((entry) => !entry.excluded
      && entry.kind === "LIFE EVENT"
      && entry.structured?.experimentEvent === "check-in"
      && entry.structured?.experimentId === experimentId)
    .map((entry) => entry.date))]
    .sort();
}

export function hasExperimentCheckInOnDate(state: Pick<DemoState, "entries" | "experiment">, date: string): boolean {
  return experimentCheckInDates(state).includes(date);
}

export type ExperimentTimelineObservation = {
  entryId: number;
  event: "check-in" | "complete";
  day: number;
  date: string;
  note: string;
  label: string;
};

function observationNote(entry: DemoState["entries"][number], event: "check-in" | "complete"): string {
  const recorded = entry.structured?.experimentObservation;
  if (typeof recorded === "string" && recorded.trim()) return recorded.trim();
  if (event === "check-in") return entry.body.match(/:\s*(.+)$/)?.[1]?.trim() || entry.body.trim();
  return entry.body
    .match(/(?:personal\s+)?outcome review(?:\s*\([^)]*\))?\s*:\s*(.+?)(?:\s+This is an observation|$)/i)?.[1]?.trim()
    || entry.body.trim();
}

/** Journal events are the correctable source of truth for experiment conclusions. */
export function experimentTimelineObservations(
  state: Pick<DemoState, "entries" | "experiment">,
  experimentId = state.experiment.id,
): ExperimentTimelineObservation[] {
  return state.entries
    .filter((entry) => !entry.excluded
      && entry.kind === "LIFE EVENT"
      && entry.structured?.experimentId === experimentId
      && ["check-in", "complete"].includes(String(entry.structured?.experimentEvent)))
    .map((entry) => {
      const event = entry.structured?.experimentEvent === "complete" ? "complete" as const : "check-in" as const;
      const day = Number(entry.structured?.day ?? 0);
      const note = observationNote(entry, event);
      return {
        entryId: entry.id,
        event,
        day,
        date: entry.date,
        note,
        label: event === "check-in"
          ? `Day ${day}: ${note}`
          : `Outcome review (personal observation, not proof): ${note}`,
      };
    })
    .sort((left, right) => left.event === right.event
      ? left.day - right.day || left.date.localeCompare(right.date) || left.entryId - right.entryId
      : left.event === "check-in" ? -1 : 1);
}

export function experimentReviewThread(state: Pick<DemoState, "teamMessage" | "teamMessageHistory" | "experiment">) {
  const requestId = state.experiment.reviewRequestMessageId;
  if (!requestId) return undefined;
  const message = experimentReviewRequestMessage(state, requestId);
  const reply = message?.reply ?? "";
  return message?.status === "replied"
    && REVIEW_REPLY_PATTERN.test(reply)
    && !REVIEW_REJECTION_PATTERN.test(reply)
    ? message
    : undefined;
}

export function experimentReviewRequestMessage(
  state: Pick<DemoState, "teamMessage" | "teamMessageHistory" | "experiment">,
  requestId: string,
) {
  const definition = experimentReviewDefinition(state.experiment);
  return [state.teamMessage, ...(state.teamMessageHistory ?? [])].find((message) =>
    message.id === requestId
    && REVIEW_REQUEST_PATTERN.test(`${message.subject} ${message.body}`)
    && `${message.subject} ${message.body}`.toLocaleLowerCase().replace(/\s+/g, " ").includes(definition));
}

/**
 * A baseline must describe something the patient actually observed before day 1.
 * Planning prompts such as “record the score before starting” are intentionally
 * rejected so a generated instruction can never be mistaken for evidence.
 */
export function isRecordedExperimentBaseline(value: string): boolean {
  const baseline = value.trim();
  return baseline.length > 0
    && !BASELINE_INSTRUCTION_PATTERN.test(baseline)
    && !BASELINE_FUTURE_PATTERN.test(baseline)
    && !BASELINE_GENERAL_FUTURE_PATTERN.test(baseline)
    && !/^(?:baseline|usual|same)$/i.test(baseline);
}

type CandidateTemplate = {
  key: "milk" | "hydration" | "breakfast" | "evening";
  title: string;
  variable: string;
  durationDays: number;
  ease: number;
};

const CANDIDATE_TEMPLATES: CandidateTemplate[] = [
  { key: "milk", title: "Oat milk instead of dairy milk", variable: "Milk choice at breakfast only", durationDays: 14, ease: 4 },
  { key: "hydration", title: "Consistent morning hydration", variable: "One glass of water with breakfast", durationDays: 7, ease: 5 },
  { key: "breakfast", title: "Consistent breakfast timing", variable: "Breakfast within the same one-hour window", durationDays: 7, ease: 4 },
  { key: "evening", title: "Consistent evening meal timing", variable: "Evening meal within the same one-hour window", durationDays: 7, ease: 4 },
];

function boundedScore(value: number): number {
  return Math.max(1, Math.min(5, value));
}

function outcomeFromPermittedContext(goal: string, journal: string): { goal: string; outcome: string; label: string } {
  const context = `${goal} ${journal}`;
  if (/urgenc|bowel|stool/i.test(context)) return { goal: "Observe whether morning urgency changes", outcome: "Morning urgency score", label: "morning-urgency" };
  if (/pain|cramp/i.test(context)) return { goal: "Observe whether daily discomfort changes", outcome: "Daily pain score", label: "daily-pain" };
  if (/fatigue|energy|tired/i.test(context)) return { goal: "Observe whether daily energy changes", outcome: "One-tap daily energy", label: "daily-energy" };
  if (/sleep|night wak/i.test(context)) return { goal: "Observe whether sleep quality changes", outcome: "One-tap sleep quality", label: "sleep-quality" };
  return { goal: "Observe whether morning wellbeing changes", outcome: "One-tap morning wellbeing", label: "morning-wellbeing" };
}

function candidateUsefulness(
  key: CandidateTemplate["key"],
  target: ReturnType<typeof outcomeFromPermittedContext>,
  context: { milk: boolean; hydration: boolean; breakfast: boolean; evening: boolean },
): number {
  if (context[key]) return 5;
  if (key === "milk") return target.label === "morning-urgency" ? 4 : 2;
  if (key === "hydration") return ["morning-wellbeing", "daily-energy"].includes(target.label) ? 5 : 4;
  if (key === "breakfast") return ["morning-wellbeing", "morning-urgency"].includes(target.label) ? 4 : 3;
  return ["sleep-quality", "daily-pain"].includes(target.label) ? 5 : 3;
}

function candidateRationale(
  template: CandidateTemplate,
  target: ReturnType<typeof outcomeFromPermittedContext>,
  context: { milk: boolean; hydration: boolean; breakfast: boolean; evening: boolean },
  hasPermittedGoal: boolean,
  reviewRequired: boolean,
): string[] {
  const reasons = [
    hasPermittedGoal
      ? `Tracks the permitted patient goal with one ${target.outcome.toLowerCase()} check-in.`
      : `Uses one ${target.outcome.toLowerCase()} check-in, which is simple to compare with a recorded baseline.`,
  ];
  if (context[template.key]) reasons.push("This option matches a pattern in the profile or journal context Penny is allowed to use.");
  if (template.key === "milk") reasons.push("Changes one breakfast choice without proposing a broad food-group exclusion.");
  if (template.key === "hydration") reasons.push("Adds one consistent action and does not remove any food.");
  if (template.key === "breakfast") reasons.push("Keeps food choice open and changes timing only.");
  if (template.key === "evening") reasons.push("Keeps food choice open and changes evening timing only.");
  reasons.push(reviewRequired
    ? "Recorded profile context activates the existing clinical-review gate before this could start."
    : "The wording is non-restrictive and stays inside the low-risk candidate gate.");
  return reasons;
}

/**
 * Produces competing, low-burden options rather than treating one suggestion as
 * the answer. Only explicitly permitted profile/journal context affects ranking.
 * The returned baseline is always blank because the patient must enter an actual
 * pre-start observation themselves.
 */
export function rankLowBurdenExperiments(
  state: DemoState,
  permissions: { profile: boolean; journal: boolean },
): RankedExperimentCandidate[] {
  const permittedMeals = permissions.journal
    ? state.entries.filter((entry) => !entry.excluded && entry.kind === "MEAL")
    : [];
  const permittedJournal = permissions.journal
    ? state.entries.filter((entry) => !entry.excluded).map((entry) => `${entry.time} ${entry.body}`).join(" ")
    : "";
  const permittedGoal = permissions.profile ? state.experiment.goal : "";
  const permittedProfile = permissions.profile
    ? `${state.profile.dietaryNeeds} ${state.profile.usualBowel} ${state.profile.usualPain} ${state.profile.usualSleep}`
    : "";
  const permittedContext = `${permittedProfile} ${permittedJournal}`;
  const target = outcomeFromPermittedContext(permittedGoal, permittedJournal);
  const context = {
    milk: /\b(milk|dairy|oat)\b/i.test(permittedContext),
    hydration: /\b(water|hydrat\w*|drink|coffee|tea)\b/i.test(permittedContext)
      || permittedMeals.some((entry) => Boolean(entry.structured?.hydration)),
    breakfast: /\b(breakfast|morning meal|porridge|cereal)\b/i.test(permittedContext),
    evening: /\b(late meal|late dinner|evening meal|night out)\b/i.test(permittedContext)
      || permittedMeals.some((entry) => Number(entry.time.slice(0, 2)) >= 20),
  };
  const milkAllergy = permissions.profile && /\b(milk|dairy|oat)\b.{0,24}\ballerg|\ballerg\w*\b.{0,24}\b(milk|dairy|oat)\b/i.test(state.profile.allergies);

  return CANDIDATE_TEMPLATES
    .filter((template) => template.key !== "milk" || !milkAllergy)
    .map((template): RankedExperimentCandidate => {
      const draft: Experiment = {
        id: "",
        title: template.title,
        variable: template.variable,
        goal: target.goal,
        baseline: "",
        outcome: target.outcome,
        startDate: "",
        durationDays: template.durationDays,
        day: 0,
        status: "suggested",
        observations: [],
        reviewRequired: false,
      };
      const reviewRequired = experimentRequiresReview(draft, permissions.profile ? state.profile : undefined);
      const scores = {
        usefulness: boundedScore(candidateUsefulness(template.key, target, context)),
        safety: reviewRequired ? 2 : 5,
        ease: boundedScore(template.ease),
        measurability: 5,
      };
      const contextBonus = context[template.key]
        ? ({ milk: 8, hydration: 3, breakfast: 4, evening: 4 } as const)[template.key]
        : 0;
      const experiment = { ...draft, reviewRequired };
      return {
        experiment,
        scores,
        risk: reviewRequired ? "Clinical review" : "Low",
        rankScore: scores.usefulness * 7 + scores.safety * 6 + scores.ease * 3 + scores.measurability * 4 + contextBonus,
        rationale: candidateRationale(template, target, context, Boolean(permittedGoal), reviewRequired),
      };
    })
    .sort((left, right) => right.rankScore - left.rankScore || left.experiment.title.localeCompare(right.experiment.title));
}

export function suggestLowBurdenExperiment(
  state: DemoState,
  permissions: { profile: boolean; journal: boolean },
): Experiment {
  return rankLowBurdenExperiments(state, permissions)[0].experiment;
}

export function experimentScores(experiment: Experiment, profile?: Pick<Profile, "conditions" | "surgeries" | "dietaryNeeds" | "allergies">) {
  return {
    usefulness: experiment.goal.trim() && experiment.outcome.trim() ? "High" : "Needs definition",
    measurable: experiment.outcome.trim() ? "High" : "Needs definition",
    burden: experiment.durationDays <= 14 ? "Low" : experiment.durationDays <= 28 ? "Moderate" : "Review",
    risk: experiment.reviewRequired || experimentRequiresReview(experiment, profile) ? "Review" : "Low",
  } as const;
}
