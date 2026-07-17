# Effortless Tracking, Patient Context, and the Background Health Agent

This document expands the [high-level product plan](PRODUCT_PLAN.md). It develops three linked ideas:

1. **Rich patient context** — a maintained past medical history (PMH) the assistant uses to ground every piece of advice.
2. **Effortless capture** — logging that costs the patient almost nothing: a photo, a sentence of voice, or one tap.
3. **A background health agent** — an always-on process that collates the captured signals, personalises advice, and, within clinically governed limits, prepares real-world actions.

These are organised around the **flare lifecycle** (section 4): the app emphasises different inputs and offers different actions depending on whether the patient is stable, pre-flare, in an active flare, or recovering on a steroid taper.

The guiding principle is unchanged: the product complements clinical care. It does not diagnose a flare, prescribe, or change medication on its own. Anything consequential is either confirmed by the patient, authorised by a clinician, or both.

## 1. Patient context and past medical history

The assistant is only as good as what it knows about the person. Alongside the IBD baseline (diagnosis, usual symptoms, current medications, care plan, clinical contacts), the patient maintains a structured **past medical history** that the AI can draw on as context.

- **What it holds:** IBD diagnosis and subtype, disease extent and history, prior surgeries (e.g. resections, stoma), significant comorbidities (diabetes, osteoporosis, mental health), allergies and intolerances, current and past medications with reasons for stopping, immunosuppression status, and relevant family history.
- **How it is built:** captured at onboarding, then kept current opportunistically — the assistant proposes updates when a conversation reveals something new ("you mentioned you had a resection in 2019 — add that to your history?") rather than requiring a form.
- **How the AI uses it:** the PMH is retrieved as grounding context whenever the assistant answers a question or the background agent evaluates a change. It shapes advice (e.g. steroid caution with diabetes or osteoporosis, immunosuppression and infection risk) and it feeds safety screening.
- **Boundaries:** the PMH is context, not a licence to make clinical decisions. It is highly sensitive; the patient can view, correct, export, and delete any of it, and can see which entries informed a given answer via the personal evidence ledger.

## 2. Effortless capture

The single biggest determinant of long-term value is whether people keep logging. So capture should be **fire-and-forget**: the patient records the raw signal and moves on. Structuring, classification, and analysis happen in the background and are *not* pushed back at the patient unless they ask or unless it is safety-relevant.

### Photo meals

- The patient opens the camera, takes a photo of their meal, and closes the app. That is the entire interaction.
- In the background, the meal is added to the food diary with a timestamp. Vision analysis estimates the foods present for later pattern-finding.
- **The point is not calorie counting.** The app does not return calories, macros, or judgement to the patient. Nutritional scoring is neither shown nor the goal — the meal photo exists so that, over time, food can be correlated with symptoms and so the assistant has real dietary context. Any derived food labels are visible and correctable, but never demanded.

### Photo bowel movements

- The same fire-and-forget flow for optional toilet photos: capture, close, done.
- In the background the app records the event and can infer observations (e.g. Bristol Stool type, blood, mucus) to enrich the timeline.
- Consent, discreet storage, short configurable retention, and easy deletion are mandatory (see governance). Image-derived observations are always correctable and never trigger clinical action on their own.

### Conversational and voice capture

- The patient can log anything by talking or typing naturally: "porridge and coffee for breakfast", "loose stool with a bit of blood this morning", "took my mesalazine", "pain's about a 6 today and I'm shattered".
- The assistant parses the utterance into structured entries (food, bowel movement, medication, symptom scores), fills what it can, and asks only for genuinely missing, decision-relevant detail — nothing more.
- Voice-first matters on a bad day, when typing or tapping through forms is exactly what a symptomatic patient will not do.

### Quick entry

- For patients who prefer taps, a one-screen quick-entry surface offers the common actions (bowel movement, meal, medication taken, "how are you?") without navigation.
- The minimal check-in stays a single tap — "better, same, or worse?" — and only expands when the answer or the background agent warrants it.

## 3. Broader symptom and physiological tracking

IBD is more than bowel movements, so tracking extends to the symptoms that shape how a patient actually feels, plus passive physiological signals.

### Self-reported symptoms

- **Pain** (severity, and optionally site), **fatigue**, plus the existing mood, appetite, sleep, and weight.
- Captured the same effortless way — a number by voice, a tap on a scale, or inferred from conversation — at a low-burden, adaptive cadence rather than a fixed daily questionnaire.
- Tracked against the patient's personal baseline, not generic targets, so "worse for you" is what matters.

### Wearables and passive signals

- Optional integration with wearables and phone health platforms (Apple Health, Google Health Connect, and device APIs) to pull **heart rate** and, where available, resting heart rate, heart-rate variability, sleep, and activity.
- Rationale: a sustained rise in resting heart rate, poor sleep, and falling activity can accompany systemic inflammation and deterioration, and they require zero effort to collect once connected.
- These signals are **supporting context for pattern-finding**, never standalone diagnostic triggers. They are explicitly framed as soft signals with known noise, and the patient controls the connection and can disconnect at any time.

## 4. The flare lifecycle: phase-specific inputs and actions

IBD is not one steady state, so the app should not present one static interface. It adapts across four phases of the flare lifecycle, each with different **inputs it emphasises**, a different **job for the background agent**, and a different set of **available actions**. This is the concrete form of the adaptive home screen: the app leads with the phase the patient is actually in and asks for the inputs that matter now.

The patient is never locked into a phase the app decides unilaterally. Phase changes are proposed, explained from the underlying observations, and confirmed with the patient; the care plan and clinical contacts stay one tap away throughout.

### Stable (baseline)

- **Emphasis:** effortless, low-frequency capture — photo meals, the occasional one-tap "better/same/worse", passive wearable signals. The goal is a good baseline with minimal burden, plus optional diet experiments when the patient is well enough.
- **Agent:** quietly maintains the personal baseline and watches for early drift. Stays out of the way; respects the notification budget.
- **Actions:** none consequential. Appointment preparation and education on demand.

### Pre-flare (early change / deteriorating)

- **Emphasis:** the app gently increases check-in frequency and prioritises the inputs that discriminate a genuine flare — bowel frequency and urgency, blood, pain, fatigue, night waking, and resting heart rate trend. Capture stays effortless but a little more attentive.
- **Agent:** compares the recent picture with baseline, explains *why* it thinks things may be changing, and asks the patient to confirm the observations. Separates "a bad day" from a sustained trend.
- **Actions:** the primary action is **contact-first** — surface the patient's agreed care pathway and, where appropriate, prepare a message to the **IBD advice line / nurse** or GP. Where clinically eligible, prepare a **home faecal calprotectin test** for confirmation. No self-started medication.

### Flare (active)

- **Emphasis:** minimal-friction symptom tracking to chart severity and trajectory, plus explicit safety screening for red flags (severe pain, heavy bleeding, high output with dehydration, fever, signs of obstruction). Voice and one-tap capture matter most here — a symptomatic patient will not fill in forms.
- **Agent:** tracks response over the clinically expected window (e.g. reviewing after treatment starts), keeps the care team informed if the patient consents, and continuously runs deterministic red-flag screening with visible escalation guidance.
- **Actions:** route to care per the plan; prepare a **clinician notification** summarising the change; and only behind a genuinely pre-agreed, prescriber-authorised standby arrangement, prepare the **pharmacy/steroid request** for confirmation. The default remains contacting the IBD team, not self-initiation. The route to **urgent help** is always visible.

### Recovery (post-flare, steroid taper)

- **Emphasis:** the day-by-day steroid course or taper takes centre stage — today's exact prescribed dose, one-tap confirmation, and upcoming dose changes the patient never has to calculate. Alongside it, low-burden check-ins for symptoms, sleep, mood, infection concerns, and steroid side effects.
- **Agent:** reconciles adherence, symptoms, and side effects; watches for relapse during the taper or side effects that need review; and drafts an editable recovery summary for the patient and care team.
- **Actions:** adaptive dose reminders with progressively stronger follow-up for an unconfirmed dose; approved missed-dose guidance and a direct route to pharmacist or IBD team. The assistant must **never** create, accelerate, pause, or change a dose or taper — any change comes from an authorised clinician.

Transitions close the loop: Stable → Pre-flare when early drift is confirmed; Pre-flare → Flare when a flare is established (typically alongside clinical contact); Flare → Recovery when treatment begins and symptoms settle; and Recovery → Stable when the taper completes and the patient returns to baseline. Each transition is explainable, patient-confirmed, and folded back into the collated picture.

## 5. The background health agent

Behind the effortless capture sits an always-on agent that turns scattered signals into personalised, grounded support.

### What it does

- **Collates** bowel movements, food, symptom scores, medication adherence, wearable signals, test results, and the PMH into a coherent, time-aligned picture.
- **Compares** the recent picture against the patient's personal baseline and care plan to notice meaningful change early.
- **Personalises advice:** when the patient asks a question, the agent answers from *their* collated data, citing the source entries; when it detects a relevant change, it can proactively surface a bounded, explainable prompt.
- **Prepares actions** (see below) rather than taking irreversible ones unilaterally.

### Design constraints

- **Explainable:** every observation, pattern, or suggestion shows the underlying entries via the personal evidence ledger, and the patient can correct them.
- **Facts vs. patterns vs. general information** stay clearly separated; correlation is never presented as proof.
- **Deterministic safety screening** for red flags sits *outside* the LLM, with visible escalation guidance. LLM output or image analysis alone must never determine clinical urgency or trigger an order.
- **Bounded proactivity:** the agent respects an adaptive notification budget, stays quiet during fatigue or active symptoms unless something is safety-relevant, and never nags.

## 6. Closed-loop clinical actions

The ambition is to close the loop from *signal* to *real-world action* — while keeping a human in every consequential step. When the collated picture and a clinically governed rule suggest deterioration, the agent can **prepare** one or more of the following for confirmation:

### Order a home faecal calprotectin test

- Where clinically appropriate and operationally eligible, the agent prepares an eMed-style home faecal calprotectin kit order to be sent to the patient's address.
- The patient confirms delivery details and consents; the app then tracks fulfilment, guides sample collection, records the result, and helps share it with the care team.
- This extends the existing testing workflow in the product plan; the trigger is a governed rule plus explicit patient confirmation, never an image or LLM inference alone.

### Message the pharmacy for an acute (rescue) steroid course

- For patients with a **pre-agreed rescue plan** authorised by their IBD team, the agent can prepare a message to the patient's pharmacy or prescriber to issue the agreed acute steroid course when governed criteria are met.
- This is deliberately the highest-risk action and requires the strongest guardrails: a documented, clinician-owned rescue pathway (e.g. a personalised action plan, PGD, or prescriber review), explicit eligibility checks, and — where clinically required — a human prescriber authorising before any medicine is issued.
- The assistant must **never** create, accelerate, or change a steroid dose or taper itself. It can only surface the option, gather confirmation, and route the request into an authorised pathway. Once a course is issued, it flows into the existing steroid-adherence workflow.

### Notify the gastroenterologist or IBD nurse

- When symptoms are worsening against baseline, the agent can prepare a concise, editable clinician-ready message to the patient's gastroenterologist or IBD nurse summarising the change and the supporting observations.
- The patient reviews and confirms before it is sent; the care team's expected response time and the route to urgent help are always visible, so a message is never mistaken for emergency care.

### The loop, end to end

Detect a change → explain it and confirm the observations with the patient → follow the patient's agreed care pathway → prepare an eligible action (test, pharmacy message, or clinician notification) for confirmation → track the outcome → fold the result back into the collated picture. Every consequential node has a human — patient, clinician, or both.

## 7. Safety, privacy, and governance additions

These build on the governance section of the product plan and are prerequisites for the features above.

- **Clinical ownership of every automated action:** test ordering, rescue-steroid messaging, and clinician notification each need a named clinical owner, a validated rule, and a defined patient-facing response-time expectation before pilot.
- **Rescue-steroid pathway governance:** treat medication-issuing as a regulated clinical decision. Require an authorised prescriber or an approved PGD/personalised action plan, prospective validation, and audit — the app orchestrates and documents, it does not decide.
- **Passive data is still sensitive:** meal photos, toilet photos, wearable streams, and inferred patterns are highly sensitive health data. Apply data minimisation, encryption, least-privilege access, strong audit logs, explicit secondary-use consent, and short configurable retention (especially for images).
- **No silent inference back to the patient:** background analysis that could alarm (e.g. a suspected pattern) is surfaced deliberately and explainably, not as a raw score.
- **Everything reversible and correctable:** the patient can exclude, correct, export, or delete any entry, image, wearable connection, or inferred observation, and can see its downstream effect.

## 8. How this maps onto the delivery phases

- **Phase 1 (Safe tracking MVP):** effortless capture (photo meal, voice/quick entry, one-tap check-in), pain and fatigue tracking, and the maintained PMH used as assistant grounding. No autonomous actions.
- **Phase 2 (Early-change support):** the background collation agent, wearable integration, explainable change detection, and the confirmed test-order loop; scoped clinician-notification messaging.
- **Phase 3 (Guided learning):** validated image-derived observations from meal and toilet photos, deeper personal pattern summaries, and — only behind a fully governed rescue pathway — the acute-steroid pharmacy loop.

## Related references

See the [product plan's planning references](PRODUCT_PLAN.md#planning-references) for the underlying clinical and data-protection sources, in particular the Crohn's & Colitis UK guidance on flare-ups, food diaries, and steroids; NICE guidance on drug-treatment monitoring and faecal calprotectin testing; and the ICO guidance on special-category health data.
