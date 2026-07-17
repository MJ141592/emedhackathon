# IBD Companion: High-Level Product Plan

## Product goal

Help adults living with inflammatory bowel disease (IBD), including Crohn's disease and ulcerative colitis, understand their day-to-day health, notice meaningful changes early, and take the next action agreed with their care team.

The product should complement clinical care. It must not diagnose a flare, change medication, or replace a patient's personalised care plan or IBD team.

## Core patient journey

1. **Set a baseline:** The patient records their diagnosis, usual symptoms, medications, dietary needs, personal care plan, clinical contacts, and what “normal” looks like for them.
2. **Track with low effort:** Quick logging captures bowel movements, symptoms, food, wellbeing, medication adherence, and optional toilet photos.
3. **Understand change:** A timeline and trend view compare recent data with the patient's baseline and highlight which observations contributed to a change.
4. **Get supported:** A context-aware assistant answers questions from the patient's data, explains uncertainty, cites the source records it used, and routes safety-sensitive questions to appropriate care.
5. **Take an agreed action:** When a clinically reviewed rule indicates possible deterioration, the app follows the patient's care plan, suggests contacting their IBD team, and may offer an eligible faecal calprotectin test order with explicit patient confirmation.
6. **Recover safely:** After a flare, a focused recovery mode helps the patient follow their prescribed steroid course or taper, monitor symptoms and side effects, and stay connected to their care team.
7. **Learn carefully:** When stable, the patient can run one-at-a-time diet experiments and review the results without treating correlation as proof.

## Feature areas

### Daily tracking

- Fast bowel movement entry: time, Bristol Stool Scale type, urgency, blood, mucus, pain, and night waking.
- Food diary with meals, ingredients, portions, hydration, and optional barcode or photo-assisted entry.
- Lightweight scheduled check-ins for pain, fatigue, mood, appetite, sleep, weight, and general wellbeing.
- Medication reminders and adherence history.
- Optional toilet photos with clear consent, discreet storage, retention controls, and manual correction of any image-derived observation.

### Trends and care sharing

- Personal baseline and simple daily/weekly trends rather than generic “healthy” targets.
- A timeline linking symptoms, food, medication, tests, and experiments.
- Explainable change alerts showing the underlying observations.
- A concise clinician-ready summary that the patient can preview, edit, and export.
- Care-plan contacts and an obvious route to urgent help.

### Context-aware assistant

- Permissioned access to the user's profile, logs, test results, care plan, and prior conversations.
- Answers grounded in those records and approved clinical content, with dates and source links.
- Clear separation between recorded facts, possible patterns, and general information.
- No independent diagnosis, medication changes, or emergency reassurance.
- Deterministic safety screening outside the LLM for red flags, with visible escalation guidance.
- User controls to exclude, correct, export, or delete data and conversations.

### Possible flare and testing workflow

- A clinically governed rules engine compares recent symptoms with the patient's baseline and personalised care plan.
- The app explains why it detected a change and asks the patient to confirm the observations.
- The first action is the patient's agreed care pathway, which may include contacting their IBD team or GP.
- Where clinically appropriate and operationally eligible, the patient can confirm delivery details and order an eMed-style home faecal calprotectin kit.
- The app tracks fulfilment, guides sample collection, records the result, and helps share it with the care team.
- LLM output or image analysis alone must never trigger an order or determine clinical urgency.

### Steroid-course adherence after a flare

- Turn the clinician's prescription into a clear day-by-day course or taper that the patient verifies before starting.
- Show today's exact prescribed dose, progress through the course, and upcoming dose changes without making the patient calculate them.
- Use adaptive, discreet reminders with one-tap confirmation, a short snooze, and progressively stronger follow-up for an unconfirmed dose.
- Ask about symptoms, sleep, mood, infection concerns, and other relevant side effects at a low-burden cadence, then route concerning answers according to a clinically approved pathway.
- Provide medicine-specific missed-dose guidance from an approved source and a direct route to the patient's pharmacist or IBD team when the correct action is uncertain.
- Reconcile adherence, symptoms, and side effects into an editable recovery summary for the patient and care team.
- Never let the assistant create, accelerate, pause, or otherwise change a steroid dose or taper; any change must come from an authorised clinician.

### Diet experiments

- Suggest candidate experiments from patient goals, diary patterns, burden, nutritional risk, and clinical suitability.
- Prioritise experiments by expected usefulness, safety, ease, and the ability to measure a result.
- Change one main variable at a time, define a baseline and outcome up front, and limit the duration.
- Pause experiments during suspected flares or other major confounding changes.
- Require dietitian or IBD-team review for restrictive diets, weight-loss risk, or significant nutritional concerns.
- Present results as personal observations, not medical conclusions.

## Delivery phases

### Phase 1: Safe tracking MVP

- Adult onboarding, consent, baseline, care plan, and clinical contacts.
- Bowel, symptom, food, wellbeing, and medication tracking.
- Prescribed steroid-course and taper adherence with safety check-ins.
- Timeline, trends, and editable clinician summary.
- Grounded assistant for record retrieval and general education.
- Red-flag escalation, audit trail, data export, and deletion.

### Phase 2: Early-change support

- Clinically reviewed personalised change detection.
- Explainable notifications and user confirmation.
- Test-kit eligibility, ordering, fulfilment, results, and care-team sharing.
- Notification tuning to minimise alert fatigue.

### Phase 3: Guided learning

- Opt-in toilet photo capture and validated image assistance.
- Structured diet experiments and prioritisation.
- Deeper personal pattern summaries and optional clinician collaboration tools.

## Safety, privacy, and governance

- Appoint a clinical safety lead and define clinical ownership before piloting alerts, image analysis, or test ordering.
- Validate escalation and flare-support logic prospectively across relevant patient groups; monitor misses, false alerts, and unequal performance.
- Treat symptom logs, photos, chat content, and inferred health patterns as highly sensitive health data.
- Complete regulatory classification, clinical safety, information governance, and data protection impact assessments before launch.
- Use data minimisation, encryption, least-privilege access, strong audit logs, explicit secondary-use consent, and short configurable photo retention.
- Keep human confirmation in consequential flows and make every automated recommendation explainable and reversible.
- Design for dignity: neutral language, discreet notifications, accessible interactions, and tracking that can be completed on a bad day.

## Initial success measures

- Patients can complete a routine entry in under 30 seconds.
- Strong week-four tracking retention without excessive reminders.
- High completion of prescribed steroid courses and dose confirmations, without encouraging unsafe self-adjustment.
- Patients and clinicians judge exported summaries useful and accurate.
- High completion rate from eligible test suggestion to usable result.
- Safety performance is measured explicitly: missed escalations, false alerts, inappropriate reassurance, and alert fatigue.
- Users can identify and correct the data behind an assistant answer or alert.

## Key open decisions

- Is the first release a self-management product, a provider-prescribed service, or both?
- Which countries, age groups, IBD subtypes, and care pathways are in scope?
- Who clinically owns alerts and results, and what response time can patients expect?
- What exact evidence and regulatory route are required for image analysis and flare-risk scoring?
- How will eMed test eligibility, payment, fulfilment, result interpretation, and clinician notification work?
- Which health-record integrations are needed, and which data remains patient-entered?

## Planning references

- [Crohn's & Colitis UK: Flare-ups](https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/symptoms/flare-ups) - flare signs vary between people; patients should follow their personalised plan or contact their IBD team or GP.
- [Crohn's & Colitis UK: Food and Crohn's or Colitis](https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/living-with-crohns-or-colitis/food) - food diaries may reveal possible symptom triggers, but major exclusions should be discussed with an IBD team or dietitian.
- [Crohn's & Colitis UK: Steroids](https://crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/all-information-about-crohns-and-colitis/treatments/steroids) - oral steroid doses should not be missed or stopped suddenly, and prescribed courses or tapers should be completed as directed.
- [NICE QS81: Monitoring drug treatment](https://www.nice.org.uk/guidance/qs81/chapter/quality-statement-4-monitoring-drug-treatment) - IBD drug treatment should be monitored for adverse effects using documented safety procedures.
- [NICE HTG320: Faecal calprotectin diagnostic tests](https://www.nice.org.uk/guidance/htg320/chapter/1-recommendations) - testing should sit within appropriate quality assurance and locally agreed care pathways.
- [ICO: What is special category data?](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/special-category-data/what-is-special-category-data/) - health data and health inferences receive additional protection under UK data protection law.
