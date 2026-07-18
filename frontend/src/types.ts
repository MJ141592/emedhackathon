export type PhaseId = "stable" | "watch" | "flare" | "recovery";

export type EntryKind =
  | "BOWEL MOVEMENT"
  | "MEAL"
  | "PAIN"
  | "FATIGUE"
  | "WELLBEING"
  | "LIFE EVENT"
  | "MEDICATION"
  | "FROM YOUR WATCH"
  | "TEST RESULT"
  | "Remi noticed";

export type PhotoAttachment = {
  name: string;
  previewUrl: string;
  purpose: "meal" | "toilet";
  retentionDays: 7 | 30 | 90;
  consented: boolean;
  derivedObservation?: string;
};

export type JournalEntry = {
  id: number;
  date: string;
  time: string;
  kind: EntryKind;
  body: string;
  source: "manual" | "chat" | "wearable" | "penny" | "care" | "supporter";
  flagged?: boolean;
  excluded?: boolean;
  structured?: Record<string, string | number | boolean>;
  photo?: PhotoAttachment;
};

export type EvidenceSource = {
  entryId?: number;
  messageId?: number;
  url?: string;
  target?: "profile" | "care" | "trends" | "privacy";
  label: string;
  date: string;
  detail: string;
  type: "fact" | "pattern" | "guidance";
  excluded?: boolean;
};

export type ChatMessage = {
  id: number;
  from: "penny" | "me";
  text: string;
  createdAt: string;
  sources?: EvidenceSource[];
  category?: "recorded fact" | "possible pattern" | "general information";
};

export type Metric = {
  k: string;
  v: string;
  unit?: string;
  d: string;
  dClass: "up" | "warn" | "flat" | "ok";
};

export type SuggestionKind = "test" | "team" | "prescription" | "taper" | "experiment" | "summary" | "urgent";

export type Suggestion = {
  kind: SuggestionKind;
  icon: "flask" | "message" | "phone" | "note";
  title: string;
  desc: string;
  cta: string;
  sources?: EvidenceSource[];
};

export type TrendPoint = {
  day: string;
  symptom?: number;
  heartRate?: number;
  bowel: number;
};

export type PhaseContent = {
  pill: { label: string; className: string };
  sub: string;
  gauge: { percent: number; label: string };
  metrics: Metric[];
  suggestions: Suggestion[];
  suggestionsNote: string;
  trend: TrendPoint[];
};

export type Profile = {
  name: string;
  /** IANA zone used for patient-facing calendar days, schedules and reminders. */
  timeZone: string;
  dateOfBirth: string;
  diagnosis: string;
  subtype: string;
  diagnosedYear: string;
  extent: string;
  surgeries: string;
  conditions: string;
  allergies: string;
  immunosuppressed: boolean;
  familyHistory: string;
  usualBowel: string;
  usualPain: string;
  usualHeartRate: string;
  usualSleep: string;
  dietaryNeeds: string;
  currentMedicines: string;
  pastMedicines: string;
  carePlan: string;
  address: string;
  postcode: string;
  adultEligibilityConfirmed: boolean;
  healthDataConsent: boolean;
  consentVersion: string;
  consentRecordedAt?: string;
  onboardingComplete: boolean;
};

export type ProfileProposalField = "surgeries" | "conditions" | "allergies" | "pastMedicines";

export type ProfileProposal = {
  id: number;
  field: ProfileProposalField;
  value: string;
  sourceMessageId: number;
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
};

export type CareContact = {
  id: string;
  initials: string;
  name: string;
  role: string;
  organisation: string;
  phone: string;
};

export type TrustedSupporter = {
  enabled: boolean;
  name: string;
  relationship: string;
  canViewSummary: boolean;
  canSeeReminders: boolean;
  canHelpLog: boolean;
  accessCode?: string | null;
  accessCreatedAt?: string | null;
};

export type SupporterView = {
  simulation: true;
  patientFirstName: string;
  supporterName: string;
  relationship: string;
  permissions: Pick<TrustedSupporter, "canViewSummary" | "canSeeReminders" | "canHelpLog">;
  summary?: string;
  reminders?: string[];
  reviewableLogs?: JournalEntry[];
  notice: string;
};

export type TestStatus =
  | "prepared"
  | "ordered"
  | "shipped"
  | "delivered"
  | "sampled"
  | "posted"
  | "lab"
  | "result"
  | "shared";

export type TestOrder = {
  id: string;
  status: TestStatus;
  /** Named accountable service for this configured simulated pathway. */
  clinicalOwner: string;
  /** Versioned, deterministic rule identifier; not an LLM or image decision. */
  eligibilityRule: string;
  /** Human-readable reason this order can be prepared or placed. */
  eligibilityReason: string;
  /** Server-compatible provenance for fulfilment reminders; never supplied by a model. */
  statusUpdatedAt?: string;
  addressConfirmed: boolean;
  consent: boolean;
  /** Immutable server-authored shipment snapshot captured when the order is confirmed. */
  deliveryAddress?: string;
  deliveryPostcode?: string;
  confirmedAt?: string;
  result?: number;
  resultNote?: string;
};

export type TeamMessage = {
  id: string;
  subject: string;
  body: string;
  status: "draft" | "sent" | "read" | "replied";
  /** Immutable send instant used to honour the stated response window. */
  sentAt?: string;
  /** Timestamp for the current workflow state, set only by a governed transition. */
  statusUpdatedAt?: string;
  clinicalOwner: string;
  notificationRule: string;
  notificationReason: string;
  expectedResponse: string;
  reply?: string;
};

export type PrescriptionFlow = {
  status: "not-started" | "prepared" | "requested" | "approved" | "ready" | "collected";
  medicine: string;
  prescriber: string;
  pharmacy: string;
  clinicalOwner: string;
  eligibilityRule: string;
  eligibilityReason: string;
  rescuePlanEligible: boolean;
  treatmentStartedAt?: string;
  reviewAfterHours: number;
};

export type TaperDay = {
  day: number;
  doseMg: number;
  date: string;
  taken: boolean;
};

export type Taper = {
  verified: boolean;
  medicine: string;
  prescribedBy: string;
  currentDay: number;
  snoozedUntil?: string;
  days: TaperDay[];
  missedDays: number[];
  sideEffects: string[];
  checkInComplete: boolean;
};

export type Experiment = {
  id: string;
  title: string;
  variable: string;
  goal: string;
  baseline: string;
  outcome: string;
  startDate: string;
  durationDays: number;
  day: number;
  status: "suggested" | "active" | "paused" | "complete";
  observations: string[];
  reviewRequired: boolean;
  reviewRequestMessageId?: string;
  reviewApprovedAt?: string;
  reviewApprovedBy?: string;
};

export type WearableSettings = {
  provider: "Apple Health" | "Health Connect";
  connected: boolean;
  heartRate: boolean;
  hrv: boolean;
  sleep: boolean;
  activity: boolean;
  lastSync?: string;
};

export type PrivacySettings = {
  photoRetentionDays: 7 | 30 | 90;
  toiletPhotoConsent: boolean;
  assistantProfileAccess: boolean;
  assistantJournalAccess: boolean;
  assistantCareAccess: boolean;
  assistantConversationAccess: boolean;
  secondaryUseConsent: boolean;
  discreetNotifications: boolean;
  notificationBudget: "low" | "balanced" | "supportive";
};

export type AuditEvent = {
  id: number;
  at: string;
  action: string;
};

export type SafetyAlert = {
  id: number;
  level: "same-day" | "emergency";
  triggers: string[];
  message: string;
  createdAt: string;
  /** Journal sources that can be corrected, excluded or deleted and then recomputed. */
  sourceEntryIds?: number[];
  /** Checklist/chat alerts with no saved journal source remain until explicit acknowledgement. */
  unlinkedTriggers?: string[];
};

export type DemoState = {
  version: number;
  phase: PhaseId;
  pendingPhase?: PhaseId;
  phaseConfirmed: boolean;
  messages: ChatMessage[];
  profileProposals: ProfileProposal[];
  entries: JournalEntry[];
  profile: Profile;
  contacts: CareContact[];
  trustedSupporter: TrustedSupporter;
  testOrder: TestOrder;
  teamMessage: TeamMessage;
  teamMessageHistory: TeamMessage[];
  teamMessageStale: boolean;
  prescription: PrescriptionFlow;
  taper: Taper;
  experiment: Experiment;
  wearable: WearableSettings;
  privacy: PrivacySettings;
  clinicianSummary: string;
  clinicianSummaryEdited: boolean;
  clinicianSummaryStale: boolean;
  audit: AuditEvent[];
  safetyAlert?: SafetyAlert;
};

export type JournalDraft = Omit<JournalEntry, "id" | "date" | "time"> & { date?: string; time?: string };

export type DemoStore = {
  state: DemoState;
  syncStatus: "loading" | "local" | "saving" | "saved" | "error";
  syncError?: string;
  mutationsBlocked: boolean;
  retryAvailable: boolean;
  retrySync: () => Promise<boolean>;
  reset: () => void;
  setDemoPhase: (phase: PhaseId) => void;
  proposePhase: (phase: PhaseId) => void;
  confirmPhase: () => void;
  confirmCurrentPhase: () => void;
  addEntry: (entry: JournalDraft) => JournalEntry;
  saveEntry: (entry: JournalDraft) => Promise<JournalEntry | undefined>;
  updateEntry: (id: number, patch: Partial<JournalEntry>) => Promise<boolean>;
  deleteEntry: (id: number) => Promise<boolean>;
  sendChat: (text: string) => Promise<boolean>;
  correctChatMessage: (id: number, text: string) => Promise<boolean>;
  deleteChatMessage: (id: number) => Promise<boolean>;
  resolveProfileProposal: (id: number, status: "accepted" | "dismissed") => void;
  updateProfile: (patch: Partial<Profile>) => Promise<boolean>;
  updateContacts: (contacts: CareContact[]) => void;
  updateTrustedSupporter: (patch: Partial<TrustedSupporter>) => void;
  generateSupporterInvitation: () => Promise<SupporterView | undefined>;
  revokeSupporterInvitation: () => Promise<boolean>;
  loadSupporterView: (accessCode: string) => Promise<SupporterView | undefined>;
  submitSupporterLog: (accessCode: string, text: string) => Promise<SupporterView | undefined>;
  updateTest: (patch: Partial<TestOrder>) => void;
  updateTeamMessage: (patch: Partial<TeamMessage>) => void;
  refreshTeamMessage: () => void;
  updatePrescription: (patch: Partial<PrescriptionFlow>) => void;
  updateTaper: (patch: Partial<Taper>) => void;
  markDoseTaken: () => void;
  markDoseMissed: (day: number) => void;
  correctDoseRecord: (day: number, fact: "taken" | "missed") => void;
  importClinicalPlan: () => Promise<boolean>;
  updateExperiment: (patch: Partial<Experiment>) => void;
  updateWearable: (patch: Partial<WearableSettings>) => void;
  updatePrivacy: (patch: Partial<PrivacySettings>) => void;
  updateSummary: (summary: string) => void;
  regenerateSummary: () => void;
  clearConversation: () => void;
  clearSafetyAlert: () => Promise<boolean>;
  clearAllData: () => Promise<boolean>;
  exportData: () => string;
};
