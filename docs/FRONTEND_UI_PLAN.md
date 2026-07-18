# Gutsy frontend UI plan

Direction agreed 17 July 2026, superseding the first phone-frame mock. The starting point is the
static prototype dropped in by Rob (saved at `docs/prototype-sol/` for reference) — we keep its
calm editorial design language and rebuild it as a single-screen web app.

## Product shell

- **Web app, not a phone app.** One main screen, no tab bar, desktop-first with a responsive
  fallback.
- **Branding: Gutsy** (both Ms capitalised).
- **The assistant is called Penny** — one conversational presence the patient talks to, not a
  buried chatbot tab.

## Layout

A two-column split under a slim top bar (brand, demo state switcher, urgent help).

### Left column (~two-thirds): today + Penny

Top block, always visible:

1. Good morning greeting
2. Today's date
3. Current flare risk — the remission → watchful → flare gauge from the prototype
4. Summary metrics: bowel movements/day vs baseline, average pain, resting heart rate,
   fatigue/sleep

Below that, the chat with Penny fills the rest of the column: message thread, quick chips, and a
composer. Penny's suggestions (order a calprotectin test, share the week with the IBD team,
steroid-taper support) appear inside the conversation as actionable cards — suggest-and-confirm,
never auto-send.

### Right column (~one-third): journal

The tracking stream and quick entry, always at hand:

- Quick-add: bowel movement (one-tap Bristol), meal photo (fire-and-forget, no calories shown),
  pain, life event
- Today's entries as a timeline, including wearable syncs and "Penny noticed" notes
- Entries logged through chat land here automatically

## Behaviour kept from the docs

- Four demo states (steady / watchful / flare / recovery) switchable from the top bar; the
  gauge, metrics, chart and Penny's suggested actions change per state
  (see EFFORTLESS_TRACKING_AND_BACKGROUND_AGENT.md §4).
- Natural-language logging: free text or chips → structured journal entries the patient can
  correct.
- Safety framing throughout: contact-first, patient confirms every consequential action,
  prescriptions always via a clinician, urgent-help routes always visible.

## Out of scope for the hackathon mock

Real backend, auth, wearable APIs, image analysis, and the full Care page (test tracking,
team messaging) — the prototype's `care.html` shows the intended shape for these.
