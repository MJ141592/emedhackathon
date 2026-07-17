# The MeMed flare journey: one continuous loop

This document walks the full end-to-end flow the product is built around — from quiet
background monitoring, through recognising and confirming a flare, coordinating tests,
prescriptions and the IBD team, to tapering off steroids and returning to normal. It ties
together the phase model in
[EFFORTLESS_TRACKING_AND_BACKGROUND_AGENT.md](EFFORTLESS_TRACKING_AND_BACKGROUND_AGENT.md)
and the UI in [FRONTEND_UI_PLAN.md](FRONTEND_UI_PLAN.md) into a single patient story.

Throughout every stage, two things never change:

- **Penny is always available** for advice, reassurance, and questions — grounded in the
  patient's own records and approved IBD guidance, with urgent-care routes always visible.
- **Every consequential step has a human in it.** Penny suggests and prepares; the patient
  confirms; clinicians authorise anything clinical. Nothing is ordered, sent, or dispensed
  automatically.

## Stage 1 — Normal monitoring (steady)

Life first, tracking second. The patient snaps meal photos, logs the occasional bowel movement
by voice or one tap, and their wearable streams resting heart rate and sleep in the background.
Most days the only ask is a single "better, same, worse?" tap — many days, nothing at all.

Behind the scenes, Penny quietly maintains the personal baseline: usual bowel frequency, usual
pain, usual heart rate, usual sleep. She stays out of the way — no streaks, no nagging — but
answers anything: "can I drink on azathioprine?", "what did I eat before that bad weekend?".
When stable, this is also where one-at-a-time diet experiments run.

## Stage 2 — Recognising a flare may be starting (watchful)

A few signals drift together: looser stools for several days, a little blood, resting heart
rate creeping up, fatigue rising. No single entry would justify an alert — the *pattern
against this patient's own baseline* does.

Penny surfaces it early and explainably: here's what changed, here are the exact entries
behind it, do these look right? The patient can correct anything. Check-ins get gently more
attentive — the inputs that discriminate a real flare (frequency, urgency, blood, night
waking) — while capture stays one-tap and voice-first, because a symptomatic patient will not
fill in forms.

## Stage 3 — Confirming what's happening: the calprotectin test

Once the patient confirms the observations and a clinically governed rule agrees, Penny
prepares a faecal calprotectin home test order — eligible under the patient's care plan, never
triggered by AI inference alone. The patient confirms delivery details; the kit arrives at
home in a day or two.

MeMed then carries the whole loop: reminds the patient when the kit arrives, guides the sample
collection, tracks the post-back and the lab, and delivers the result with a plain-language
explanation of what it means alongside the symptom picture. The result goes to the patient and
their IBD team together — objective evidence of inflammation, not just "I feel worse".

## Stage 4 — Bringing in the IBD team

In parallel, Penny drafts a concise update for the IBD nurse or gastroenterologist: the
changed signals versus baseline, the flagged entries, the test order and (when back) its
result. The patient reviews and edits every word before it sends, and can see when it's been
read and what response time to expect. Contact-first is the default pathway — the team knows
early, while there's the most room to act.

## Stage 5 — Treatment ready: the steroid prescription

If the calprotectin result and the clinical picture warrant treatment, the prescribing
decision belongs to the clinician — Penny's job is to remove all the friction around it. The
request goes to the named prescriber with the evidence attached; when Dr Ferreira approves,
the prescription is issued to the patient's nominated pharmacy.

The patient gets one clear message: *"Your prednisolone course has been approved and is ready
to collect at Wellfield Pharmacy."* No chasing, no phone queue, no wondering whether the
referral went through. Penny never creates, accelerates, or alters a dose — she orchestrates
and documents an authorised pathway.

## Stage 6 — Active support through the flare

The app shifts into flare mode. The home view leads with what matters now: severity tracking
in as few taps as possible, red-flag screening (heavy bleeding, severe pain, fever, faintness)
running deterministically with an always-visible route to urgent care, and the day's treatment
front and centre.

Penny's monitoring becomes active rather than ambient: she charts response against the review
window the team expects, asks the few questions that matter each day, and reassures honestly —
saying what's normal for a flare, and what isn't, without ever promising it's fine when the
data says otherwise.

## Stage 7 — Keeping the IBD team in the loop

Each evening during a flare, Penny drafts a short update from the day's entries; the patient
approves before it sends. The team sees trajectory, not noise — is treatment working, is
anything getting worse — and their replies land back in the same thread ("call us if the
bleeding increases"). If response is slower than expected or red flags appear, escalation
follows the patient's agreed care pathway, not an algorithm's guess.

## Stage 8 — Tapering off and landing softly

As symptoms settle, the prescribed taper takes over the home view: today's exact dose, one tap
to confirm, the next step-down date — the patient never does the arithmetic. Missed-dose
guidance comes from approved sources with a direct line to the pharmacist, and steroid
side-effect check-ins (sleep, mood, infection signs) stay low-burden. Penny watches for the
thing that matters most in this phase: relapse during the taper, caught against the baseline
just like the original flare.

At the end of the course, Penny reconciles everything — adherence, symptoms, side effects,
test results — into an editable recovery summary for the follow-up appointment.

## Stage 9 — Back to normal

The gauge eases back toward remission, check-ins thin out, and the app returns to
fire-and-forget capture. Two things are better than before the flare: the baseline is
re-learned from the recovered patient, and the whole episode — trigger candidates, time
to treatment, what helped — is in the record, making the *next* early-change call sharper.
The loop closes where it began: quiet monitoring, with Penny one message away.

## The loop at a glance

```
steady monitoring
      │  signals drift from baseline
      ▼
watchful: explain change → patient confirms
      │
      ├─▶ calprotectin home test (patient confirms order → result to patient + team)
      ├─▶ IBD team notified early (patient-approved draft)
      ▼
clinician approves treatment → "your prescription is ready"
      │
      ▼
flare: active monitoring · red-flag screening · daily team updates
      │  symptoms settle
      ▼
taper: dose-by-dose guidance · relapse watch · recovery summary
      │  course complete
      ▼
back to steady monitoring (smarter baseline)
```

Advice and support are not a stage — they are the constant. The stages only change what Penny
pays attention to and what she offers to do next.
