from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal, NotRequired, TypedDict
from zoneinfo import ZoneInfo

from app.domain.models import DemoState, JournalEntry


class GroundedReply(TypedDict):
    text: str
    category: Literal["recorded fact", "possible pattern", "general information"]
    sources: NotRequired[list[dict[str, Any]]]


APPROVED_GUIDANCE = {
    "flare": {
        "label": "Crohn’s & Colitis UK: Flare-ups",
        "url": (
            "https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-"
            "colitis/all-information-about-crohns-and-colitis/symptoms/flare-ups"
        ),
        "detail": (
            "Approved general information about flare signs and contacting the IBD team; "
            "personal care plans still take priority."
        ),
    },
    "food": {
        "label": "Crohn’s & Colitis UK: Food and IBD",
        "url": (
            "https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-"
            "colitis/all-information-about-crohns-and-colitis/living-with-crohns-or-colitis/"
            "food"
        ),
        "detail": (
            "Approved general food guidance; major exclusions should be reviewed with an IBD "
            "team or dietitian."
        ),
    },
    "steroids": {
        "label": "Crohn’s & Colitis UK: Steroids",
        "url": (
            "https://crohnsandcolitis.org.uk/info-support/information-about-crohns-and-colitis/"
            "all-information-about-crohns-and-colitis/treatments/steroids"
        ),
        "detail": (
            "Approved general steroid-course guidance; only an authorised clinician can set "
            "or change a dose."
        ),
    },
    "calprotectin": {
        "label": "NICE: Faecal calprotectin diagnostic tests",
        "url": "https://www.nice.org.uk/guidance/htg320/chapter/1-recommendations",
        "detail": (
            "Approved general information about calprotectin testing inside a quality-assured "
            "clinical pathway."
        ),
    },
    "ibd": {
        "label": "Crohn’s & Colitis UK: Crohn’s disease",
        "url": (
            "https://www.crohnsandcolitis.org.uk/info-support/information-about-crohns-and-"
            "colitis/all-information-about-crohns-and-colitis/understanding-crohns-and-colitis/"
            "crohns-disease"
        ),
        "detail": (
            "Approved general IBD education; an individual diagnosis and treatment plan belong "
            "with the clinical team."
        ),
    },
}


def _guidance_source(key: str) -> dict[str, Any]:
    source = APPROVED_GUIDANCE[key]
    return {
        **source,
        "date": "Approved guidance · checked 18 Jul 2026",
        "type": "guidance",
    }


def _entry_source(entry: JournalEntry, source_type: str = "fact") -> dict[str, Any]:
    return {
        "entryId": entry.id,
        "label": entry.kind,
        "date": f"{entry.date}, {entry.time}",
        "detail": entry.body,
        "type": source_type,
        "excluded": entry.excluded,
    }


def _latest_included(
    state: DemoState, kinds: set[str], limit: int = 4
) -> list[JournalEntry]:
    matching = [
        entry for entry in state.entries if not entry.excluded and entry.kind in kinds
    ]
    return sorted(matching, key=lambda entry: (entry.date, entry.time), reverse=True)[:limit]


def _patient_today(state: DemoState, instant: datetime | None = None) -> date:
    value = instant or datetime.now(UTC)
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(ZoneInfo(state.profile.timeZone)).date()


def _food_symptom_reply(
    state: DemoState, *, instant: datetime | None = None
) -> GroundedReply:
    if not state.privacy.assistantJournalAccess:
        return {
            "category": "general information",
            "text": (
                "Journal access is off, so I cannot align meals with later symptom records. "
                "You can review both directly in your journal or enable that permission in "
                "Privacy."
            ),
        }

    today = _patient_today(state, instant)
    oldest = today - timedelta(days=90)
    included = [
        entry
        for entry in state.entries
        if not entry.excluded and oldest <= date.fromisoformat(entry.date) <= today
    ]
    meals = [entry for entry in included if entry.kind == "MEAL"]
    symptoms = [
        entry
        for entry in included
        if entry.kind in {"BOWEL MOVEMENT", "PAIN", "FATIGUE", "WELLBEING"}
    ]

    def recorded_at(entry: JournalEntry) -> datetime:
        return datetime.fromisoformat(f"{entry.date}T{entry.time}")

    assigned: dict[int, list[JournalEntry]] = {meal.id: [] for meal in meals}
    for symptom in symptoms:
        symptom_at = recorded_at(symptom)
        candidates = [
            meal
            for meal in meals
            if timedelta(0) < symptom_at - recorded_at(meal) <= timedelta(hours=12)
        ]
        if candidates:
            nearest = max(candidates, key=recorded_at)
            assigned[nearest.id].append(symptom)

    for meal in sorted(meals, key=recorded_at, reverse=True):
        following = sorted(assigned[meal.id], key=lambda entry: (recorded_at(entry), entry.id))
        if not following:
            continue
        elapsed_seconds = (recorded_at(following[-1]) - recorded_at(meal)).total_seconds()
        elapsed_hours = max(1, round(elapsed_seconds / 3_600))
        count = len(following)
        summary = (
            f"Within about {elapsed_hours} hour{'s' if elapsed_hours != 1 else ''} after the "
            f"{meal.date} {meal.time} meal “{meal.body}”, {count} included symptom "
            f"{'entries were' if count != 1 else 'entry was'} recorded."
        )
        caveat = (
            "Correlation is not proof that this meal caused the symptoms; other changes and "
            "unrecorded factors may explain the timing. I have cited the exact source entries "
            "so you can correct or exclude any of them."
        )
        return {
            "category": "possible pattern",
            "text": f"{summary} {caveat}",
            "sources": [
                _entry_source(entry, "pattern") for entry in [meal, *following]
            ],
        }

    return {
        "category": "recorded fact",
        "text": (
            "I could not find an included meal followed by an included symptom record inside "
            "the bounded 12-hour diary window. That is missing diary evidence, not proof that "
            "food is unrelated."
        ),
        "sources": [],
    }


def answer_from_permitted_records(
    state: DemoState, question: str, *, instant: datetime | None = None
) -> GroundedReply | None:
    """Answer fixed education and retrieval intents without diagnosing or prescribing."""

    lower = question.lower()

    if re.search(
        r"\b(what did i (?:tell|say|mention)|what have i (?:told|said|mentioned)|"
        r"did i (?:tell|say|mention)|earlier (?:message|conversation)|"
        r"our (?:earlier |previous )?conversation)\b",
        lower,
    ):
        if not state.privacy.assistantConversationAccess:
            return {
                "category": "general information",
                "text": (
                    "Earlier-conversation access is off, so I cannot retrieve what you "
                    "previously told Penny. You can review the conversation yourself or enable "
                    "that separate permission in Privacy."
                ),
            }
        prior_messages = [message for message in state.messages if message.from_ == "me"][-5:]
        prior_messages.reverse()
        if not prior_messages:
            return {
                "category": "recorded fact",
                "text": "There are no earlier patient messages in this conversation to retrieve.",
                "sources": [],
            }
        noun = "message was" if len(prior_messages) == 1 else "messages were"
        description = "; ".join(f"“{message.text}”" for message in prior_messages)
        return {
            "category": "recorded fact",
            "text": (
                f"Your {len(prior_messages)} most recent earlier {noun}: {description}. These "
                "are conversation records, not independently verified facts."
            ),
            "sources": [
                {
                    "messageId": message.id,
                    "label": "Earlier patient message",
                    "date": message.createdAt,
                    "detail": message.text,
                    "type": "fact",
                }
                for message in prior_messages
            ],
        }

    if re.search(
        r"\b(food|meal|eat|ate).{0,32}(pattern|trigger|cause|symptom|pain|bowel|urgency)|"
        r"\b(pattern|trigger|cause).{0,32}(food|meal|eat|ate)\b",
        lower,
    ):
        return _food_symptom_reply(state, instant=instant)

    if re.search(
        r"\b(what did i (?:eat|have)|what have i eaten|which meals? did i|"
        r"food (?:did i )?(?:log|record)|bad weekend|before that)\b",
        lower,
    ):
        if not state.privacy.assistantJournalAccess:
            return {
                "category": "general information",
                "text": (
                    "Journal access is off, so I cannot retrieve meals or events. You can "
                    "review them manually in your journal or enable that permission in Privacy."
                ),
            }
        records = _latest_included(state, {"MEAL", "LIFE EVENT"}, 5)
        if not records:
            return {
                "category": "recorded fact",
                "text": "I could not find an included meal or life-event record for that question.",
                "sources": [],
            }
        suffix = "" if len(records) == 1 else "s"
        detail = "; ".join(entry.body for entry in records)
        return {
            "category": "recorded fact",
            "text": (
                f"I found {len(records)} recent included meal or event record{suffix}. These are "
                f"records, not proof that anything caused symptoms: {detail}."
            ),
            "sources": [_entry_source(entry) for entry in records],
        }

    medicine_question = re.search(
        r"\b(current|my|taking|take).{0,18}(medicine|medication|drug)|"
        r"\b(medicine|medication|drug)s?.{0,18}(?:am i )?(taking|take)|azathioprine",
        lower,
    )
    if medicine_question and not re.search(r"\b(drink|alcohol|beer|wine)\b", lower):
        if not state.privacy.assistantProfileAccess:
            return {
                "category": "general information",
                "text": (
                    "Profile and PMH access is off, so I cannot retrieve your medicine list. "
                    "Check the medicine label or ask your pharmacist or IBD team for personal "
                    "advice."
                ),
            }
        medicines = state.profile.currentMedicines
        if not medicines:
            return {
                "category": "recorded fact",
                "text": "Your profile does not currently contain a medicine list.",
                "sources": [],
            }
        return {
            "category": "recorded fact",
            "text": (
                f"Your patient-maintained profile records: {medicines}. Please correct the "
                "profile if that is no longer current."
            ),
            "sources": [
                {
                    "target": "profile",
                    "label": "Current medicines in profile",
                    "date": "Current patient-maintained record",
                    "detail": medicines,
                    "type": "fact",
                }
            ],
        }

    if re.search(
        r"\b(drink|alcohol|beer|wine).{0,24}(azathioprine|medicine|medication)|"
        r"\bazathioprine.{0,24}(drink|alcohol)",
        lower,
    ):
        sources: list[dict[str, Any]] = []
        if state.privacy.assistantProfileAccess and state.profile.currentMedicines:
            sources.append(
                {
                    "target": "profile",
                    "label": "Current medicines in profile",
                    "date": "Current patient-maintained record",
                    "detail": state.profile.currentMedicines,
                    "type": "fact",
                }
            )
        context = (
            "Your profile records azathioprine, but "
            if sources
            else "Because profile access is off, I have not checked your medicines; "
        )
        sources.append(
            {
                "label": "NHS azathioprine common questions",
                "date": "Official NHS medicines guidance · checked July 2026",
                "detail": (
                    "General azathioprine information; personal medicine decisions remain with "
                    "the pharmacist or clinical team."
                ),
                "type": "guidance",
                "url": (
                    "https://www.nhs.uk/medicines/azathioprine/"
                    "common-questions-about-azathioprine/"
                ),
            }
        )
        return {
            "category": "general information",
            "text": (
                f"I cannot decide what is safe for you to drink. {context}use the medicine "
                "leaflet and ask your pharmacist or IBD team about alcohol, liver monitoring "
                "and your own circumstances."
            ),
            "sources": sources,
        }

    if re.search(
        r"\b(allerg(?:y|ies|ic)|medical history|past medical|pmh|conditions?|"
        r"immunosuppress(?:ed|ion))\b",
        lower,
    ):
        if not state.privacy.assistantProfileAccess:
            return {
                "category": "general information",
                "text": (
                    "Profile and PMH access is off, so I cannot retrieve conditions, allergies "
                    "or immunosuppression status."
                ),
            }
        facts = [
            f"Conditions: {state.profile.conditions}" if state.profile.conditions else "",
            f"Allergies: {state.profile.allergies}" if state.profile.allergies else "",
            (
                "Immunosuppression status: recorded as immunosuppressed"
                if state.profile.immunosuppressed
                else "Immunosuppression status: not recorded as immunosuppressed"
            ),
            f"Prior surgery: {state.profile.surgeries}" if state.profile.surgeries else "",
        ]
        facts = [fact for fact in facts if fact]
        return {
            "category": "recorded fact",
            "text": (
                f"Your patient-maintained history records: {'; '.join(facts)}. Please correct "
                "Profile if any of this is outdated."
            ),
            "sources": [
                {
                    "target": "profile",
                    "label": "Patient-maintained PMH",
                    "date": "Current profile record",
                    "detail": detail,
                    "type": "fact",
                }
                for detail in facts
            ],
        }

    if re.search(
        r"\b(prednisolone|steroid).{0,35}(risk|safe|side effect|infection|bone|osteop|"
        r"diabet|mood)|\b(osteop|diabet|infection).{0,35}(prednisolone|steroid)\b",
        lower,
    ):
        if not state.privacy.assistantProfileAccess:
            return {
                "category": "general information",
                "text": (
                    "Profile and PMH access is off, so I cannot check personal risk context. "
                    "Ask your pharmacist, prescriber or IBD team before making any medicine "
                    "decision."
                ),
            }
        relevant = [
            f"Recorded conditions: {state.profile.conditions}"
            if state.profile.conditions
            else "",
            f"Recorded allergies: {state.profile.allergies}"
            if state.profile.allergies
            else "",
            (
                "Profile records immunosuppression, which makes possible infection important "
                "to raise promptly."
                if state.profile.immunosuppressed
                else ""
            ),
        ]
        relevant = [detail for detail in relevant if detail]
        sources = [
            {
                "target": "profile",
                "label": "Relevant PMH context",
                "date": "Current patient-maintained profile",
                "detail": detail,
                "type": "fact",
            }
            for detail in relevant
        ]
        sources.append(
            {
                "label": "NHS prednisolone safety information",
                "date": "Official NHS medicines guidance · checked July 2026",
                "detail": (
                    "General prednisolone information; steroid risk assessment and changes "
                    "belong with the authorised clinical team."
                ),
                "type": "guidance",
                "url": (
                    "https://www.nhs.uk/medicines/prednisolone/"
                    "who-can-and-cannot-take-prednisolone-tablets-and-liquid/"
                ),
            }
        )
        return {
            "category": "general information",
            "text": (
                "I cannot decide whether a steroid is safe or change its dose. "
                f"{' '.join(relevant)} These records are context—not a clinical conclusion—so "
                "use the prescribed plan and ask your prescriber or pharmacist about infection, "
                "bone, mood, glucose or other personal risks."
            ),
            "sources": sources,
        }

    if re.search(r"\b(baseline|usual|normal for me)\b", lower):
        if not state.privacy.assistantProfileAccess:
            return {
                "category": "general information",
                "text": "Profile access is off, so I cannot retrieve your personal baseline.",
            }
        detail = "; ".join(
            value
            for value in (
                state.profile.usualBowel,
                state.profile.usualPain,
                state.profile.usualHeartRate,
                state.profile.usualSleep,
            )
            if value
        )
        return {
            "category": "recorded fact",
            "text": (
                f"Your maintained baseline says: {detail}."
                if detail
                else "Your personal baseline has not been completed yet."
            ),
            "sources": (
                [
                    {
                        "target": "profile",
                        "label": "Personal baseline",
                        "date": "Current patient-maintained profile",
                        "detail": detail,
                        "type": "fact",
                    }
                ]
                if detail
                else []
            ),
        }

    if re.search(
        r"\b(what (?:is|does)|how does|why (?:do|is)).{0,25}(faecal |fecal )?"
        r"calprotectin|\bcalprotectin.{0,20}(mean|measure|work)\b",
        lower,
    ) and not re.search(r"\b(my|status|result|order|ordered|kit|delivery|posted|lab)\b", lower):
        return {
            "category": "general information",
            "text": (
                "Faecal calprotectin is a stool marker that can provide objective evidence of "
                "intestinal inflammation. It does not diagnose a flare by itself: the IBD team "
                "interprets a result alongside symptoms, history and the local care pathway."
            ),
            "sources": [_guidance_source("calprotectin")],
        }

    if re.search(
        r"\b(why|how|can|should|must|what).{0,32}(steroid|prednisolone|taper)|"
        r"\b(steroid|prednisolone).{0,32}(course|taper|stop|suddenly)\b",
        lower,
    ) and not re.search(
        r"\b(today'?s|my|current|prescribed|what dose|how (?:much|many)|missed)\b",
        lower,
    ):
        return {
            "category": "general information",
            "text": (
                "Steroids can be used for a limited clinician-prescribed course to control "
                "inflammation. A prescribed course or taper should be followed exactly and not "
                "stopped suddenly. Penny can display a verified schedule, but only the "
                "authorised prescriber can start, stop or change it."
            ),
            "sources": [_guidance_source("steroids")],
        }

    if re.search(
        r"\b(what|which|how).{0,28}(eat|food|diet|fibre|fiber|dairy)|"
        r"\b(food|diet).{0,24}(trigger|avoid|exclude|safe)|"
        r"\b(elimination|low[- ]?residue) diet\b",
        lower,
    ):
        return {
            "category": "general information",
            "text": (
                "There is no single diet that works for everyone with Crohn’s or Colitis. A "
                "food diary may help you notice personal observations, but it cannot prove a "
                "food caused symptoms. Discuss major exclusions, weight loss or nutritional "
                "risk with your IBD team or dietitian."
            ),
            "sources": [_guidance_source("food")],
        }

    if re.search(
        r"\b(what|which) (?:are |signs? |symptoms? )?.{0,24}"
        r"(?:an? |in an? |during an? )?(?:ibd )?flare(?:-up)?\b|"
        r"\b(signs?|symptoms?) (?:can happen |of ).{0,20}(?:an? |ibd )?flare(?:-up)?\b|"
        r"\b(how (?:do|can) i recognise|could this be).{0,24}(?:an? )?flare(?:-up)?\b|"
        r"\bflare(?:-up)?.{0,20}(signs?|symptoms?|mean)\b",
        lower,
    ):
        return {
            "category": "general information",
            "text": (
                "A flare means symptoms or inflammation may be more active, but signs vary "
                "between people. Changes can include more frequent or looser stools, blood, "
                "urgency, pain, fatigue or night waking. Follow your personal care plan or "
                "contact your IBD team; heavy bleeding, severe pain, fever, faintness, "
                "dehydration or obstruction symptoms need urgent assessment."
            ),
            "sources": [_guidance_source("flare")],
        }

    if re.search(
        r"\b(stress|meal|food|sleep|alcohol).{0,24}(cause|caused|trigger).{0,20}"
        r"(flare|symptoms?)|\bcorrelation|\bprove(?:d)? (?:a )?trigger\b",
        lower,
    ):
        return {
            "category": "general information",
            "text": (
                "A repeated diary pattern can be useful to discuss, but timing alone does not "
                "prove cause. MeMed keeps recorded facts separate from possible patterns and "
                "lets you correct or exclude every source before sharing an observation."
            ),
            "sources": [_guidance_source("food"), _guidance_source("flare")],
        }

    if re.search(
        r"\b(what is|explain|difference between).{0,24}"
        r"(crohn'?s|colitis|inflammatory bowel disease|ibd)\b",
        lower,
    ):
        return {
            "category": "general information",
            "text": (
                "Inflammatory bowel disease is the umbrella term for conditions including "
                "Crohn’s disease and ulcerative colitis. They can affect people differently, so "
                "diagnosis, monitoring and treatment are individual clinical decisions rather "
                "than something Penny infers from a chat."
            ),
            "sources": [_guidance_source("ibd")],
        }

    if re.search(
        r"\b(my|our|status|result|order|ordered|kit|delivery|posted|lab).{0,30}"
        r"(calprotectin|home test|test)|"
        r"\b(calprotectin|home test|kit).{0,30}"
        r"(status|result|order|delivery|arrive|posted|lab)\b",
        lower,
    ):
        if not state.privacy.assistantCareAccess:
            return {
                "category": "general information",
                "text": (
                    "Care-record access is off, so I cannot retrieve your test order or result. "
                    "You can still inspect it directly under Care."
                ),
            }
        order = state.testOrder
        detail = (
            f"Home-test status: {order.status}; no result is recorded."
            if order.result is None
            else (
                f"Home-test status: {order.status}; result {order.result} µg/g. The IBD team "
                "must interpret it with symptoms."
            )
        )
        return {
            "category": "recorded fact",
            "text": detail,
            "sources": [
                {
                    "target": "care",
                    "label": "Calprotectin workflow",
                    "date": "Current care record",
                    "detail": detail,
                    "type": "fact",
                }
            ],
        }

    if re.search(
        r"\b(today'?s|my|current|prescribed|what).{0,20}"
        r"(dose|taper|prednisolone|steroid)|"
        r"\b(steroid|prednisolone).{0,12}(dose|schedule)\b",
        lower,
    ):
        if not state.privacy.assistantCareAccess:
            return {
                "category": "general information",
                "text": (
                    "Care-record access is off, so I cannot retrieve the prescribed taper. "
                    "Check the medicine label and Care screen or contact your pharmacist."
                ),
            }
        active = state.prescription.status == "collected" or (
            state.phase == "recovery"
            and state.phaseConfirmed
            and state.pendingPhase is None
        )
        if not active:
            return {
                "category": "general information",
                "text": (
                    "Dose support is not active, so I cannot present a current dose or dose "
                    "action. The imported clinician schedule remains available for review and "
                    "verification in Care; use the medicine label or contact your pharmacist or "
                    "IBD team if a dose is due."
                ),
            }
        if not state.taper.verified:
            return {
                "category": "general information",
                "text": (
                    "No verified clinician-authored dose is available in the care record. Do "
                    "not calculate or change a dose in MeMed."
                ),
            }
        today = _patient_today(state, instant).isoformat()
        day = next((item for item in state.taper.days if item.date == today), None)
        if day is None:
            detail = "No schedule row is recorded for this patient-local calendar date."
            return {
                "category": "recorded fact",
                "text": (
                    "The verified clinician-authored schedule has no dose dated "
                    f"{today} in your recorded home time zone. Check the dispensing label or "
                    "contact your pharmacist or IBD team if that is unexpected."
                ),
                "sources": [
                    {
                        "target": "care",
                        "label": "Verified prescribed taper",
                        "date": today,
                        "detail": detail,
                        "type": "fact",
                    }
                ],
            }
        detail = (
            f"Verified {state.taper.medicine} taper day {day.day}: {day.doseMg} mg, prescribed "
            f"by {state.taper.prescribedBy}; "
            f"{'recorded taken' if day.taken else 'not yet confirmed taken'}."
        )
        return {
            "category": "recorded fact",
            "text": detail,
            "sources": [
                {
                    "target": "care",
                    "label": "Verified prescribed taper",
                    "date": day.date,
                    "detail": detail,
                    "type": "fact",
                }
            ],
        }

    if re.search(r"\b(care plan|contact|nurse|gastro|pharmacist|pharmacy)\b", lower):
        if not state.privacy.assistantCareAccess:
            return {
                "category": "general information",
                "text": (
                    "Care-record access is off, so I cannot retrieve named contacts. Urgent "
                    "help remains available at all times."
                ),
            }
        detail = "; ".join(
            f"{contact.name} — {contact.role}, {contact.phone}" for contact in state.contacts
        )
        return {
            "category": "recorded fact",
            "text": (
                f"Your maintained care contacts are: {detail}. A team message is not an "
                "emergency route."
                if detail
                else "No named care contacts are recorded."
            ),
            "sources": (
                [
                    {
                        "target": "care",
                        "label": "Care contacts",
                        "date": "Current patient-maintained record",
                        "detail": detail,
                        "type": "fact",
                    }
                ]
                if detail
                else []
            ),
        }

    if re.search(r"\b(what changed|why.{0,12}(watch|worse)|recent symptoms|this week)\b", lower):
        if not state.privacy.assistantJournalAccess:
            return {
                "category": "general information",
                "text": (
                    "Journal access is off, so I cannot explain a pattern from your source "
                    "entries."
                ),
            }
        records = _latest_included(
            state,
            {"BOWEL MOVEMENT", "PAIN", "FATIGUE", "WELLBEING", "FROM YOUR WATCH"},
            5,
        )
        if not records:
            return {
                "category": "recorded fact",
                "text": "There are no included recent symptom records to compare.",
                "sources": [],
            }
        return {
            "category": "possible pattern",
            "text": (
                "Several recent included records may have moved together. That is a possible "
                "pattern, not a diagnosis; review or correct every cited source in Trends & "
                "evidence."
            ),
            "sources": [_entry_source(entry, "pattern") for entry in records],
        }

    return None
