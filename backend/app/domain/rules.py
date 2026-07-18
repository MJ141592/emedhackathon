from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.models import (
    CaptureDraft,
    DashboardResponse,
    DemoState,
    EvidenceSource,
    Experiment,
    JournalDraft,
    JournalEntry,
    LifecycleEvaluation,
    LifecycleSignal,
    PersonalPatternSummary,
    Profile,
    ProfileProposalDraft,
    SafetyEvaluation,
    SafetyInput,
)

URGENT_MESSAGE = (
    "These answers include a red flag. Do not wait for an app message: use your agreed urgent "
    "care route now. In the UK, call 111 for urgent advice, or 999 / go to A&E if symptoms are "
    "severe or you feel unsafe."
)
SAME_DAY_MESSAGE = (
    "This needs same-day clinical advice. Contact your IBD team or GP using your care plan. "
    "If symptoms become severe, use urgent care rather than waiting for a reply in the app."
)


def _patient_today(profile: Profile, instant: datetime | None = None) -> date:
    value = instant or datetime.now(UTC)
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(ZoneInfo(profile.timeZone)).date()
ROUTINE_MESSAGE = (
    "No configured red flag was found in these answers. Keep following your personal care plan; "
    "this deterministic check does not diagnose a flare or prove that everything is safe."
)
TEST_ORDER_SIGNAL_KEYS = {
    "loose_stools",
    "blood",
    "urgency",
    "pain",
    "night_waking",
    "fatigue",
}
EXPERIMENT_REVIEW_PATTERN = re.compile(
    r"\b(restrict(?:ive|ion)|eliminat(?:e|ion)|remove|cut out|avoid all|fast(?:ing)?|keto|"
    r"very low|low[- ]fodmap|gluten[- ]free|dairy[- ]free|weight loss|lose weight|"
    r"whole food group|eat only|only (?:eat|drink)|juice cleanse|cleanse|liquid[- ]only|"
    r"carnivore|skip(?:ping)? (?:a |one )?meal|no food(?: for)?(?: \d+)? ?h(?:ours?)?)\b",
    re.IGNORECASE,
)
NUTRITIONAL_VULNERABILITY_PATTERN = re.compile(
    r"\b(short bowel|malnutrition|malnourished|underweight|unintentional weight loss|"
    r"eating disorder|feeding tube|enteral nutrition|parenteral nutrition|bowel obstruction|"
    r"active stricture|food allerg(?:y|ies))\b",
    re.IGNORECASE,
)


def experiment_requires_review(experiment: Experiment, profile: Profile | None = None) -> bool:
    text = " ".join(
        (experiment.title, experiment.variable, experiment.goal, experiment.outcome)
    )
    profile_context = ""
    if profile is not None:
        profile_context = " ".join(
            (profile.conditions, profile.surgeries, profile.dietaryNeeds, profile.allergies)
        )
    allergy_conflict = False
    if profile is not None and profile.allergies.strip():
        allergy_terms = {
            token.rstrip("s")
            for token in re.findall(r"[a-z][a-z-]{2,}", profile.allergies.casefold())
            if token not in {"allergy", "allergies", "allergic", "reaction", "unknown", "none"}
        }
        lowered_text = text.casefold()
        allergy_conflict = any(
            re.search(rf"\b{re.escape(term)}s?\b", lowered_text) for term in allergy_terms
        )
    return (
        bool(EXPERIMENT_REVIEW_PATTERN.search(text))
        or experiment.durationDays > 28
        or bool(NUTRITIONAL_VULNERABILITY_PATTERN.search(profile_context))
        or allergy_conflict
    )


def evaluate_safety(payload: SafetyInput, profile: Profile | None = None) -> SafetyEvaluation:
    emergency: list[str] = []
    same_day: list[str] = []

    if payload.bleeding in {"heavy", "continuous"}:
        emergency.append("Heavy or continuous bleeding")
    if (payload.pain is not None and payload.pain >= 8) or payload.severePain:
        emergency.append("Severe abdominal pain (8/10 or higher)")
    if payload.faint:
        emergency.append("Faintness or collapse")
    if payload.possibleObstruction:
        emergency.append("Possible bowel obstruction")
    elif payload.vomiting and payload.cannotPassStoolOrGas:
        emergency.append("Vomiting with inability to pass stool or gas (possible obstruction)")
    elif payload.vomiting and payload.abdominalDistension:
        emergency.append("Possible bowel obstruction (vomiting with abdominal distension)")
    if payload.abdominalDistension and payload.cannotPassStoolOrGas:
        emergency.append("Abdominal distension with inability to pass stool or gas")

    if payload.feverC is not None and payload.feverC >= 38:
        same_day.append(f"Fever ({payload.feverC:.1f}°C)")
    elif (
        profile is not None
        and profile.immunosuppressed
        and payload.feverC is not None
        and payload.feverC >= 37.5
    ):
        same_day.append(
            f"Possible infection while immunosuppressed ({payload.feverC:.1f}°C)"
        )
    elif payload.fever:
        same_day.append("Fever reported")
    if payload.dehydration:
        same_day.append("Signs of dehydration")
    if payload.persistentVomiting and not payload.possibleObstruction:
        same_day.append("Persistent vomiting")
    if (
        payload.bowelMovements24h is not None
        and payload.bowelMovements24h >= 10
        and "Signs of dehydration" not in same_day
    ):
        same_day.append("Very high bowel output (10 or more in 24 hours)")
    if payload.bleeding == "moderate":
        same_day.append("Moderate bleeding")
    if payload.infectionConcern:
        same_day.append("Possible infection while taking steroids")
    if payload.seriousMoodConcern:
        same_day.append("Serious mood change while taking steroids")
    if payload.newSwellingConcern:
        same_day.append("New swelling while taking steroids")
    if payload.symptomsWorse:
        same_day.append("Symptoms worsening during taper")

    if emergency:
        return SafetyEvaluation(
            urgent=True,
            level="emergency",
            triggers=emergency + same_day,
            message=URGENT_MESSAGE,
        )
    if same_day:
        return SafetyEvaluation(
            urgent=True,
            level="same-day",
            triggers=same_day,
            message=SAME_DAY_MESSAGE,
        )
    return SafetyEvaluation(urgent=False, level="routine", triggers=[], message=ROUTINE_MESSAGE)


def safety_input_from_entry(entry: JournalEntry) -> SafetyInput:
    structured = entry.structured
    bleeding = structured.get("blood")
    allowed_bleeding = {"none", "small", "moderate", "heavy", "continuous"}
    if bleeding not in allowed_bleeding:
        bleeding = None
    pain = structured.get("pain")
    fever = structured.get("feverC")
    count = structured.get("bowelMovements24h", structured.get("dailyCount"))
    return SafetyInput(
        pain=int(pain) if isinstance(pain, (int, float)) else None,
        severePain=bool(structured.get("severePain", False)),
        bleeding=bleeding,
        feverC=float(fever) if isinstance(fever, (int, float)) else None,
        fever=bool(structured.get("fever", False)),
        faint=bool(structured.get("faint", False)),
        dehydration=bool(structured.get("dehydration", False)),
        bowelMovements24h=int(count) if isinstance(count, (int, float)) else None,
        vomiting=bool(structured.get("vomiting", False)),
        persistentVomiting=bool(structured.get("persistentVomiting", False)),
        possibleObstruction=bool(structured.get("possibleObstruction", False)),
        cannotPassStoolOrGas=bool(structured.get("cannotPassStoolOrGas", False)),
        abdominalDistension=bool(structured.get("abdominalDistension", False)),
        infectionConcern=bool(structured.get("infectionConcern", False)),
        seriousMoodConcern=bool(
            structured.get("seriousMoodConcern", structured.get("moodConcern", False))
        ),
        newSwellingConcern=bool(structured.get("newSwellingConcern", False)),
        symptomsWorse=bool(
            structured.get("taperCheckIn", False)
            and (
                structured.get("symptomsWorse", False)
                or str(structured.get("wellbeing", "")).lower() == "worse"
            )
        ),
    )


_DIRECT_SAFETY_NEGATIONS = {
    "fever": re.compile(
        r"\b(?:i\s+)?(?:do\s+not|don't)\s+have\s+(?:a\s+)?fever\b|"
        r"\b(?:i\s+)?(?:am\s+not|i'm\s+not)\s+feverish\b|"
        r"\bno\s+(?:signs?\s+of\s+)?fever\b|"
        r"\b(?:temperature|temp)\s+(?:is|was)\s+(?:normal|not\s+high)\b",
        re.IGNORECASE,
    ),
    "numeric_temperature": re.compile(
        r"\b(?:my\s+)?(?:temperature|temp)\b.{0,18}\bnot\s+"
        r"\d{2,3}(?:\.\d+)?\s*(?:(?:°\s*)?[cf](?:elsius|ahrenheit)?\b|degrees?\b)?",
        re.IGNORECASE,
    ),
    "faint": re.compile(
        r"\b(?:i\s+)?(?:do\s+not|don't|did\s+not|didn't)\s+feel\s+faint\b|"
        r"\b(?:i\s+)?(?:am\s+not|i'm\s+not|was\s+not|wasn't)\s+(?:feeling\s+)?faint\b|"
        r"\bno\s+faintness\b|"
        r"\b(?:did\s+not|didn't|have\s+not|haven't)\s+(?:faint(?:ed)?|pass(?:ed)?\s+out|"
        r"black(?:ed)?\s+out|lose|lost)\b",
        re.IGNORECASE,
    ),
    "dehydration": re.compile(
        r"\b(?:i\s+)?(?:am\s+not|i'm\s+not)\s+dehydrated\b|"
        r"\b(?:i\s+)?(?:do\s+not|don't|did\s+not|didn't)\s+feel\s+dehydrated\b|"
        r"\bno\s+(?:signs?\s+of\s+)?dehydration\b",
        re.IGNORECASE,
    ),
    "vomiting": re.compile(
        r"\b(?:i\s+)?(?:am\s+not|i'm\s+not)\s+vomiting\b|"
        r"\bno\s+(?:persistent\s+|repeated\s+)?vomiting\b|"
        r"\b(?:have\s+not|haven't|did\s+not|didn't)\s+vomit(?:ed)?\b",
        re.IGNORECASE,
    ),
    "obstruction": re.compile(
        r"\bno\s+(?:bowel\s+)?obstruction\b|"
        r"\b(?:bowel\s+)?(?:is\s+)?not\s+(?:blocked|obstructed)\b|"
        r"\b(?:i\s+)?(?:can|am\s+able\s+to)\s+pass\s+(?:stool|wind|gas)\b",
        re.IGNORECASE,
    ),
    "distension": re.compile(
        r"\bno\s+(?:abdominal\s+)?(?:distension|swelling|bloating)\b|"
        r"\b(?:abdomen|abdominal|belly|stomach|tummy)\b.{0,12}\bnot\s+"
        r"(?:swollen|bloated|distended)\b|\bnot\s+bloat(?:ed|ing)\b",
        re.IGNORECASE,
    ),
    "bleeding": re.compile(
        r"\bno\s+(?:heavy|continuous|moderate)\s+(?:blood|bleeding)\b|"
        r"\b(?:blood|bleeding)\s+(?:is|was)\s+not\s+(?:heavy|continuous|moderate)\b|"
        r"\b(?:there\s+(?:is|was)\s+)?not\s+(?:a\s+)?lot\s+of\s+(?:blood|bleeding)\b|"
        r"\bnot\s+(?:a\s+)?large\s+amount\s+of\s+(?:blood|bleeding)\b|"
        r"\bno\s+large\s+(?:blood\s+)?clots?\b|\bno\s+profuse\s+bleeding\b|"
        r"\bnot\s+passing\s+pure\s+blood\b|\bblood\s+(?:is\s+)?not\s+pouring\b|"
        r"\btoilet\s+bowl\s+(?:is\s+)?not\s+full\s+of\s+blood\b",
        re.IGNORECASE,
    ),
    "severe_pain": re.compile(
        r"\b(?:pain|cramp(?:s|ing|y)?)\s+(?:is|was)\s+not\s+"
        r"(?:severe|unbearable|excruciating)\b|"
        r"\bno\s+(?:severe|unbearable|excruciating)\s+"
        r"(?:abdominal|stomach|tummy|gut)?\s*(?:pain|cramp(?:s|ing|y)?)\b|"
        r"\b(?:i\s+)?(?:do\s+not|don't|did\s+not|didn't)\s+have\s+(?:any\s+)?"
        r"(?:severe|unbearable|excruciating)\s+(?:abdominal|stomach|tummy|gut)?\s*"
        r"(?:pain|cramp(?:s|ing|y)?)\b|\bnot\s+(?:the\s+)?worst\s+"
        r"(?:abdominal|stomach|tummy|gut)?\s*pain\b|\bnot\s+in\s+agony\b",
        re.IGNORECASE,
    ),
    "numeric_pain": re.compile(
        r"\b(?:pain|cramp(?:s|ing|y)?)\b.{0,18}\bnot\s+"
        r"(?:10|[0-9]|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*"
        r"(?:(?:/|out\s+of)\s*(?:10|ten))?|"
        r"\bnot\s+(?:10|[0-9]|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*"
        r"(?:(?:/|out\s+of)\s*(?:10|ten))\b.{0,20}"
        r"\b(?:abdominal|stomach|tummy|gut|belly)?\s*(?:pain|cramp(?:s|ing|y)?)\b",
        re.IGNORECASE,
    ),
}

_BOWEL_COUNT_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
    "dozen": 12,
}
_BOWEL_COUNT_TOKEN = rf"(?:\d{{1,3}}|(?:a\s+)?dozen|{'|'.join(_BOWEL_COUNT_WORDS)})"
_BOWEL_DAY_CONTEXT = (
    r"(?:today|since\s+(?:this\s+)?(?:morning|waking|midnight)|"
    r"(?:in|over|within|during|for|the|past|last)\s+(?:the\s+)?(?:past\s+|last\s+)?"
    r"24\s*(?:hours?|hrs?)|(?:per|a|each)\s+day)"
)


def _bowel_count_value(value: str) -> int | None:
    normalized = re.sub(r"^a\s+", "", value.casefold())
    if normalized in _BOWEL_COUNT_WORDS:
        return _BOWEL_COUNT_WORDS[normalized]
    try:
        count = int(value)
    except ValueError:
        return None
    return count if 0 <= count <= 100 else None


_PAIN_SCORE_WORDS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}
_PAIN_SCORE_TOKEN = rf"(?:10|[0-9]|{'|'.join(_PAIN_SCORE_WORDS)})"


def _pain_score_value(value: str) -> int | None:
    if value.casefold() in _PAIN_SCORE_WORDS:
        return _PAIN_SCORE_WORDS[value.casefold()]
    try:
        score = int(value)
    except ValueError:
        return None
    return score if 0 <= score <= 10 else None


def _instructional_threshold_clause(clause: str) -> bool:
    """Reject targets, leaflet wording and conditional care-plan thresholds as observations."""

    return bool(
        re.search(
            r"\b(?:care\s+plan|leaflet|instructions?|guidance)\b.{0,60}"
            r"\b(?:says?|call|seek|advice|if|when)\b|"
            r"\b(?:i\s+was\s+told|i\s+was\s+advised|told\s+me)\b.{0,60}\bif\b|"
            r"\bi\s+(?:need|want|would\s+like)\s+to\s+know\s+(?:whether|if)\b",
            clause,
            re.IGNORECASE,
        )
    )


def _extract_bowel_movements_24h(text: str) -> int | None:
    """Extract an explicitly time-bounded bowel frequency without treating targets as facts."""

    expressions = (
        rf"\b(?P<count>{_BOWEL_COUNT_TOKEN})\s+"
        rf"(?:(?:very\s+)?(?:loose|watery|bloody)\s+)*"
        rf"(?:bowel\s+movements?|stools?|poos?|motions?)\b.{{0,30}}\b{_BOWEL_DAY_CONTEXT}\b",
        rf"\b(?:diarrh(?:oea|ea)|loose\s+stools?|bowel\s+movements?|stools?|poos?|"
        rf"opened\s+my\s+bowels?)\b"
        rf".{{0,24}}\b(?P<count>{_BOWEL_COUNT_TOKEN})\s+times?\b"
        rf".{{0,24}}\b{_BOWEL_DAY_CONTEXT}\b",
        rf"\b(?:been|went|going|go)\s+(?:to\s+)?(?:the\s+)?(?:toilet|loo)\b.{{0,20}}"
        rf"\b(?P<count>{_BOWEL_COUNT_TOKEN})\s+times?\b"
        rf".{{0,24}}\b{_BOWEL_DAY_CONTEXT}\b",
        rf"\b(?P<count>{_BOWEL_COUNT_TOKEN})\s+times?\b.{{0,20}}"
        rf"\b(?:diarrh(?:oea|ea)|opened\s+my\s+bowels?|used\s+the\s+toilet)\b"
        rf".{{0,24}}\b{_BOWEL_DAY_CONTEXT}\b",
    )
    direct_negation = re.compile(
        r"\b(?:have|has|had|did)\s+not\b|\b(?:haven't|hasn't|hadn't|didn't|never)\b|"
        r"\b(?:fewer|less)\s+than\b|\bunder\b",
        re.IGNORECASE,
    )
    for clause in _safety_clauses(text):
        if _instructional_threshold_clause(clause):
            continue
        for expression in expressions:
            match = re.search(expression, clause, re.IGNORECASE)
            if match is None:
                continue
            # A nearby direct negation or upper-bound comparison must not become a reported
            # count. Positive wording such as "at least ten" remains an explicit report.
            prefix = clause[max(0, match.start() - 28) : match.start("count")]
            if direct_negation.search(prefix):
                continue
            count = _bowel_count_value(match.group("count"))
            if count is not None:
                return count
    return None


def _safety_clauses(text: str) -> list[str]:
    return [
        clause.strip()
        for clause in re.split(
            r"\b(?:but|however|although)\b|;|(?<!\d)\.(?!\d)", text, flags=re.I
        )
        if clause.strip()
    ]


def _non_negated_safety_search(
    text: str, expression: str, negation_key: str
) -> re.Match[str] | None:
    for clause in _safety_clauses(text):
        match = re.search(expression, clause, re.I)
        if match and not _DIRECT_SAFETY_NEGATIONS[negation_key].search(clause):
            return match
    return None


def _current_temperature_c(text: str) -> float | None:
    """Prefer an explicitly current value over a higher historical value in the same report."""

    if not re.search(r"\b(?:temperature|temp)\b", text, re.IGNORECASE):
        return None
    current_markers = r"\b(?:now|currently|right\s+now|at\s+the\s+moment)\b"
    for clause in reversed(_safety_clauses(text)):
        if not re.search(current_markers, clause, re.IGNORECASE) or re.search(
            r"\bnot\s+\d{2,3}(?:\.\d+)?", clause, re.IGNORECASE
        ):
            continue
        if fahrenheit := re.search(
            r"\b(9\d(?:\.\d+)?|10\d(?:\.\d+)?|11[0-3](?:\.\d+)?)\s*"
            r"(?:(?:°\s*)?f(?:ahrenheit)?\b|degrees?\s+f(?:ahrenheit)?\b)"
            r".{0,16}" + current_markers,
            clause,
            re.IGNORECASE,
        ):
            return round((float(fahrenheit.group(1)) - 32) * 5 / 9, 1)
        if celsius := re.search(
            r"\b(3\d(?:\.\d+)?|4[0-5](?:\.\d+)?)\s*"
            r"(?:(?:°\s*)?c(?:elsius)?\b|degrees?\s+c(?:elsius)?\b|degrees?\b)?"
            r".{0,16}" + current_markers,
            clause,
            re.IGNORECASE,
        ):
            return float(celsius.group(1))
    return None


def _current_pain_score(text: str) -> int | None:
    """Prefer an explicitly current pain score when an earlier score is also reported."""

    if not re.search(r"\b(?:pain|cramp(?:s|ing|y)?)\b", text, re.IGNORECASE):
        return None
    current_markers = r"\b(?:now|currently|right\s+now|at\s+the\s+moment)\b"
    for clause in reversed(_safety_clauses(text)):
        if not re.search(current_markers, clause, re.IGNORECASE):
            continue
        match = re.search(
            rf"\b(?P<score>{_PAIN_SCORE_TOKEN})\s*"
            rf"(?:(?:/|out\s+of)\s*(?:10|ten))?\b.{{0,16}}{current_markers}",
            clause,
            re.IGNORECASE,
        )
        if match is None or re.search(
            rf"\bnot\s+{re.escape(match.group('score'))}\b", clause, re.IGNORECASE
        ):
            continue
        if (score := _pain_score_value(match.group("score"))) is not None:
            return score
    return None


def _is_general_safety_question(text: str) -> bool:
    lowered = text.strip().lower()
    if not re.match(r"^(?:what|when|where|why|how|is|are|can|could|should|would)\b", lowered):
        return False
    return not bool(
        re.search(
            r"\b(?:i\s+(?:have|feel|am|keep|kept|cannot|can't|couldn't|passed|fainted|"
            r"developed)|i'm|i've|my\s+(?:temperature|temp|pain|stomach|tummy|bowel)|"
            r"not\s+passing)\b",
            lowered,
        )
    )


def extract_structured_safety_details(text: str) -> dict[str, str | int | float | bool]:
    """Extract explicit red-flag facts while suppressing only direct, unambiguous negations."""

    text = text.translate(str.maketrans({"’": "'", "‘": "'", "–": "-", "—": "-"}))
    if _is_general_safety_question(text):
        return {}
    details: dict[str, str | int | float | bool] = {}
    bowel_count = _extract_bowel_movements_24h(text)
    if bowel_count is not None:
        details["bowelMovements24h"] = bowel_count
    current_temperature = _current_temperature_c(text)
    temperature_c = _non_negated_safety_search(
        text,
        r"\b(3\d(?:\.\d+)?|4[0-5](?:\.\d+)?)\s*"
        r"(?:(?:°\s*)?c(?:elsius)?\b|degrees?\s+c(?:elsius)?\b)",
        "numeric_temperature",
    )
    temperature_bare = _non_negated_safety_search(
        text,
        r"\b(?:temperature|temp)\b.{0,16}\b"
        r"(3\d(?:\.\d+)?|4[0-5](?:\.\d+)?)"
        r"(?!\s*(?:degrees?\s*)?(?:°\s*)?f(?:ahrenheit)?\b)\s*(?:degrees?)?\b",
        "numeric_temperature",
    )
    temperature_f = _non_negated_safety_search(
        text,
        r"\b(9\d(?:\.\d+)?|10\d(?:\.\d+)?|11[0-3](?:\.\d+)?)\s*"
        r"(?:(?:°\s*)?f(?:ahrenheit)?\b|degrees?\s+f(?:ahrenheit)?\b)",
        "numeric_temperature",
    )
    if current_temperature is not None:
        details["feverC"] = current_temperature
    elif temperature_f:
        details["feverC"] = round((float(temperature_f.group(1)) - 32) * 5 / 9, 1)
    elif temperature_c or temperature_bare:
        details["feverC"] = float((temperature_c or temperature_bare).group(1))

    if _non_negated_safety_search(
        text, r"\b(?:fever|feverish|high temperature)\b", "fever"
    ):
        details["fever"] = True
    if _non_negated_safety_search(
        text,
        r"\b(?:faint(?:ed|ing|ness)?|feel(?:ing)?\s+faint|pass(?:ed)?\s+out|"
        r"black(?:ed|ing)?\s+out|lost\s+consciousness|collaps(?:e|ed|ing)|"
        r"dizzy\s+and\s+weak)\b",
        "faint",
    ):
        details["faint"] = True
    if _non_negated_safety_search(
        text,
        r"\b(?:dehydrat(?:ed|ion)|can(?:not|'t)\s+keep\s+"
        r"(?:anything|food|fluids|water)\s+down|"
        r"(?:have\s+not|haven't|not)\s+(?:peed|urin(?:ated|ating))|"
        r"very\s+dark\s+urine|(?:produced|passed|made)\s+no\s+urine\s+since|"
        r"no\s+urine\s+since)\b",
        "dehydration",
    ):
        details["dehydration"] = True

    vomiting_mentioned = _non_negated_safety_search(
        text,
        r"\b(?:vomit(?:ed|ing|s)?|throw(?:ing|s|n)?\s+up|(?:being|been)\s+sick)\b",
        "vomiting",
    )
    persistent_vomiting = _non_negated_safety_search(
        text,
        r"\b(?:persistent|repeated|recurrent|continuous)\s+(?:vomit(?:ing|s)?|sickness)\b|"
        r"\b(?:keep|kept)\s+(?:vomiting|throwing\s+up)\b|"
        r"\bcan(?:not|'t)\s+stop\s+(?:vomiting|throwing\s+up|being\s+sick)\b|"
        r"\bcan(?:not|'t)\s+keep\s+anything\s+down\b|"
        r"\b(?:vomit(?:ed|ing)|(?:being|been)\s+sick)\s+"
        r"(?:repeatedly|persistently|all\s+day)\b|"
        r"\b(?:have\s+)?been\s+sick\s+all\s+day\b",
        "vomiting",
    )
    repeated_vomiting = _non_negated_safety_search(
        text,
        rf"\b(?:vomit(?:ed|ing)?|(?:have\s+)?been\s+sick)\b.{{0,16}}"
        rf"\b(?P<count>{_BOWEL_COUNT_TOKEN})\s+times?\b.{{0,24}}"
        rf"\b{_BOWEL_DAY_CONTEXT}\b",
        "vomiting",
    )
    repeated_vomiting_count = (
        _bowel_count_value(repeated_vomiting.group("count")) if repeated_vomiting else None
    )
    if repeated_vomiting_count is not None and repeated_vomiting_count >= 3:
        persistent_vomiting = persistent_vomiting or repeated_vomiting
    if vomiting_mentioned:
        details["vomiting"] = True
    if persistent_vomiting:
        details["persistentVomiting"] = True

    cannot_pass = bool(
        _non_negated_safety_search(
            text,
            r"\b(?:(?:have\s+not|haven't)\s+passed|"
            r"(?:not|unable\s+to|can(?:not|'t))\s+(?:passing|pass))\s+"
            r"(?:stool|poo|wind|gas)\b|\bno\s+(?:stool|poo|bowel\s+movement)\s+"
            r"(?:or|and)\s+(?:wind|gas)\b|"
            r"\bcan(?:not|'t)\s+(?:poo|defecate)\b",
            "obstruction",
        )
    )
    explicit_obstruction = bool(
        _non_negated_safety_search(
            text,
            r"\b(?:bowel\s+)?(?:obstruction|obstructed)\b|"
            r"\b(?:blocked\s+bowel|bowel\s+(?:(?:is|feels?)\s+)?blocked)\b",
            "obstruction",
        )
    )
    if cannot_pass or explicit_obstruction:
        details["possibleObstruction"] = True
        if cannot_pass:
            details["cannotPassStoolOrGas"] = True
    if _non_negated_safety_search(
        text,
        r"\b(?:abdominal\s+)?(?:distension|distended|swelling)\b|"
        r"\b(?:abdomen|abdominal|belly|stomach|tummy)\b.{0,12}\b"
        r"(?:swollen|bloated|distended)\b|\b(?:severe\s+)?bloat(?:ing|ed)\b",
        "distension",
    ):
        details["abdominalDistension"] = True

    heavy_bleeding = _non_negated_safety_search(
            text,
            r"\b(?:heavy|continuous|won'?t\s+stop|will\s+not\s+stop|"
            r"can(?:not|'t)\s+stop|a\s+lot\s+of|lots\s+of|large\s+amount\s+of)\b"
            r".{0,28}\b(?:blood|bleed(?:ing)?)\b|"
            r"\b(?:blood|bleed(?:ing)?)\b.{0,28}\b(?:heavy|continuous|won'?t\s+stop|"
            r"will\s+not\s+stop|can(?:not|'t)\s+stop|a\s+lot|lots|large\s+amount)\b|"
            r"\blarge\s+(?:blood\s+)?clots?\b|\bprofuse\s+(?:blood|bleeding)\b|"
            r"\btoilet\s+bowl\s+(?:is\s+)?full\s+of\s+blood\b|"
            r"\b(?:passing|passed)\s+pure\s+blood\b|"
            r"\bblood\s+(?:is\s+)?pouring\s+out\b",
            "bleeding",
    )
    if heavy_bleeding:
        details["blood"] = (
            "continuous"
            if re.search(
                r"\b(?:continuous|won'?t\s+stop|will\s+not\s+stop|can(?:not|'t)\s+stop)\b",
                text,
                re.IGNORECASE,
            )
            else "heavy"
        )
    elif _non_negated_safety_search(
        text, r"\bmoderate\b.{0,22}\b(?:blood|bleeding)\b", "bleeding"
    ):
        details["blood"] = "moderate"

    current_pain_score = _current_pain_score(text)
    pain_score = _non_negated_safety_search(
        text,
        rf"\b(?:pain|cramp(?:s|ing|y)?)\b.{{0,20}}?\b"
        rf"(?P<score>{_PAIN_SCORE_TOKEN})\s*"
        rf"(?:(?:/|out\s+of)\s*(?:10|ten))?\b",
        "numeric_pain",
    ) or _non_negated_safety_search(
        text,
        rf"\b(?P<score>{_PAIN_SCORE_TOKEN})\s*"
        rf"(?:(?:/|out\s+of)\s*(?:10|ten))\b.{{0,20}}"
        rf"\b(?:abdominal|stomach|tummy|gut|belly)?\s*(?:pain|cramp(?:s|ing|y)?)\b",
        "numeric_pain",
    )
    if current_pain_score is not None:
        details["pain"] = current_pain_score
    elif pain_score and (score := _pain_score_value(pain_score.group("score"))) is not None:
        details["pain"] = score
    if _non_negated_safety_search(
        text,
        r"\b(?:severe|unbearable|excruciating)\b.{0,20}\b"
        r"(?:abdominal|stomach|tummy|gut|pain|cramp(?:s|ing|y)?)\b|"
        r"\b(?:abdominal|stomach|tummy|gut)?\s*(?:pain|cramp(?:s|ing|y)?)\b"
        r".{0,12}\b(?:unbearable|excruciating)\b|"
        r"\b(?:the\s+)?worst\s+(?:abdominal|stomach|tummy|gut)?\s*pain\b|"
        r"\b(?:in\s+agony\b.{0,24}\b(?:abdominal|stomach|tummy|gut)?\s*pain|"
        r"(?:abdominal|stomach|tummy|gut)?\s*pain\b.{0,24}\bin\s+agony)\b",
        "severe_pain",
    ):
        details["severePain"] = True
    return details


def _safety_details_require_capture(details: dict[str, str | int | float | bool]) -> bool:
    blood = str(details.get("blood", "")).lower()
    pain = details.get("pain")
    fever_c = details.get("feverC")
    bowel_count = details.get("bowelMovements24h")
    return (
        blood in {"moderate", "heavy", "continuous"}
        or (isinstance(pain, (int, float)) and pain >= 8)
        or (isinstance(bowel_count, (int, float)) and bowel_count >= 10)
        or details.get("severePain") is True
        or details.get("fever") is True
        or (isinstance(fever_c, (int, float)) and fever_c >= 37.5)
        or any(
            details.get(field) is True
            for field in (
                "faint",
                "dehydration",
                "persistentVomiting",
                "possibleObstruction",
            )
        )
    )


def _contains_direct_safety_negation(text: str) -> bool:
    return any(pattern.search(text) for pattern in _DIRECT_SAFETY_NEGATIONS.values())


def evaluate_lifecycle(state: DemoState) -> LifecycleEvaluation:
    patient_name = (
        state.profile.name.strip().split()[0]
        if state.profile.name.strip()
        else "the patient"
    )
    pain_baseline = _baseline_high(state.profile.usualPain, default=2, maximum=10)
    pain_signal_threshold = min(10, max(4, pain_baseline + 2))
    # A wearable signal is meaningful only against this patient's maintained
    # baseline. Missing data must not silently inherit the seeded Amara fixture.
    heart_rate_baseline = _baseline_high(
        state.profile.usualHeartRate, default=0, maximum=250
    )
    heart_rate_signal_threshold = heart_rate_baseline + 5
    included_entries = [entry for entry in state.entries if not entry.excluded]
    dated_entries: list[tuple[JournalEntry, date]] = []
    for entry in included_entries:
        try:
            dated_entries.append((entry, date.fromisoformat(entry.date)))
        except ValueError:
            continue
    latest_date = _patient_today(state.profile)
    window_start = latest_date - timedelta(days=6)
    entries = [
        entry for entry, entry_date in dated_entries if window_start <= entry_date <= latest_date
    ]
    bowel = [entry for entry in entries if entry.kind == "BOWEL MOVEMENT"]
    symptoms = [entry for entry in entries if entry.kind in {"PAIN", "FATIGUE", "WELLBEING"}]
    wearables = [entry for entry in entries if entry.kind == "FROM YOUR WATCH"]
    tests = [
        entry
        for entry in entries
        if entry.kind == "TEST RESULT"
        and entry.source == "care"
        and state.testOrder.status in {"result", "shared"}
        and state.testOrder.result is not None
        and _numeric(entry.structured.get("calprotectin")) == state.testOrder.result
    ]
    signals: list[LifecycleSignal] = []

    loose = [entry for entry in bowel if _numeric(entry.structured.get("bristol")) >= 6]
    if len(loose) >= 2:
        signals.append(
            LifecycleSignal(
                key="loose_stools",
                label="Looser stools",
                detail=f"{len(loose)} recent entries record Bristol type 6 or 7.",
                evidenceEntryIds=[entry.id for entry in loose],
                clinical=True,
            )
        )

    blood = [
        entry
        for entry in bowel
        if str(entry.structured.get("blood", "none")) not in {"none", "", "False"}
    ]
    if blood:
        signals.append(
            LifecycleSignal(
                key="blood",
                label="Blood recorded",
                detail=f"Blood is present in {len(blood)} included bowel entry.",
                evidenceEntryIds=[entry.id for entry in blood],
                clinical=True,
            )
        )

    urgency = [entry for entry in bowel if bool(entry.structured.get("urgency"))]
    if len(urgency) >= 2:
        signals.append(
            LifecycleSignal(
                key="urgency",
                label="Urgency above baseline",
                detail=f"Urgency is recorded in {len(urgency)} recent entries.",
                evidenceEntryIds=[entry.id for entry in urgency],
                clinical=True,
            )
        )

    pain = [
        entry
        for entry in bowel + symptoms
        if _numeric(entry.structured.get("pain")) >= pain_signal_threshold
    ]
    if pain:
        highest = max(_numeric(entry.structured.get("pain")) for entry in pain)
        signals.append(
            LifecycleSignal(
                key="pain",
                label="Pain above usual",
                detail=(
                    f"Pain reached {highest:g}/10 versus {patient_name}’s recorded usual "
                    f"{state.profile.usualPain or f'{pain_baseline:g}/10'}."
                ),
                evidenceEntryIds=list(dict.fromkeys(entry.id for entry in pain)),
                clinical=True,
            )
        )

    night_waking = [entry for entry in bowel if bool(entry.structured.get("nightWaking"))]
    if night_waking:
        signals.append(
            LifecycleSignal(
                key="night_waking",
                label="Night waking",
                detail="A bowel entry records waking during the night.",
                evidenceEntryIds=[entry.id for entry in night_waking],
                clinical=True,
            )
        )

    high_fatigue = [
        entry
        for entry in bowel + symptoms
        if str(entry.structured.get("fatigue", "")).lower() == "high"
    ]
    if high_fatigue:
        signals.append(
            LifecycleSignal(
                key="fatigue",
                label="High fatigue",
                detail=f"High fatigue is recorded against {patient_name}’s personal baseline.",
                evidenceEntryIds=list(dict.fromkeys(entry.id for entry in high_fatigue)),
                clinical=True,
            )
        )

    worse_wellbeing = [
        entry
        for entry in symptoms
        if entry.kind == "WELLBEING"
        and str(entry.structured.get("wellbeing", "")).lower() == "worse"
    ]
    repeated_worse = len({entry.date for entry in worse_wellbeing}) >= 2
    if worse_wellbeing:
        signals.append(
            LifecycleSignal(
                key="wellbeing_worse",
                label="Feeling worse than usual",
                detail=(
                    f"{len(worse_wellbeing)} included one-tap or detailed wellbeing "
                    f"{'entry records' if len(worse_wellbeing) == 1 else 'entries record'} "
                    "feeling worse than the personal baseline."
                ),
                evidenceEntryIds=[entry.id for entry in worse_wellbeing],
                clinical=True,
            )
        )

    raised_hr = [
        entry
        for entry in wearables
        if heart_rate_baseline > 0
        and _numeric(entry.structured.get("restingHeartRate")) >= heart_rate_signal_threshold
    ]
    if raised_hr:
        signals.append(
            LifecycleSignal(
                key="resting_heart_rate",
                label="Resting heart rate supporting signal",
                detail=(
                    "Resting heart rate is at least 5 bpm above the recorded "
                    f"{heart_rate_baseline:g} bpm baseline."
                ),
                evidenceEntryIds=[entry.id for entry in raised_hr],
                clinical=False,
            )
        )

    sleep_baseline = _baseline_high(state.profile.usualSleep, default=0, maximum=24)
    short_sleep = [
        entry
        for entry in wearables
        if sleep_baseline > 0
        and "sleepHours" in entry.structured
        and _numeric(entry.structured.get("sleepHours")) <= sleep_baseline - 1
    ]
    if short_sleep:
        signals.append(
            LifecycleSignal(
                key="sleep_context",
                label="Sleep supporting context",
                detail=(
                    "An included passive sleep duration is at least one hour below the recorded "
                    f"{sleep_baseline:g}-hour baseline. Sleep data is noisy and cannot trigger "
                    "a lifecycle change by itself."
                ),
                evidenceEntryIds=[entry.id for entry in short_sleep],
                clinical=False,
            )
        )

    hrv_context = [
        entry
        for entry in wearables
        if "heartRateVariabilityMs" in entry.structured
        and _numeric(entry.structured.get("heartRateVariabilityMs")) > 0
    ]
    if hrv_context:
        signals.append(
            LifecycleSignal(
                key="hrv_context",
                label="HRV supporting context",
                detail=(
                    "Heart-rate variability is recorded in milliseconds as noisy personal "
                    "context only; no diagnostic threshold or standalone trigger is applied."
                ),
                evidenceEntryIds=[entry.id for entry in hrv_context],
                clinical=False,
            )
        )

    activity_context = [
        entry
        for entry in wearables
        if "activitySteps" in entry.structured
        and _numeric(entry.structured.get("activitySteps")) >= 0
    ]
    if activity_context:
        signals.append(
            LifecycleSignal(
                key="activity_context",
                label="Activity supporting context",
                detail=(
                    "Activity is retained as personal context only; no population step target or "
                    "standalone lifecycle trigger is applied."
                ),
                evidenceEntryIds=[entry.id for entry in activity_context],
                clinical=False,
            )
        )

    clinical_signals = [signal for signal in signals if signal.clinical]
    sustained_change = _signals_span_recorded_days(clinical_signals, state)
    established_test = any(
        _numeric(entry.structured.get("calprotectin")) >= 250 for entry in tests
    )
    if established_test:
        signals.append(
            LifecycleSignal(
                key="calprotectin",
                label="Calprotectin result available",
                detail=(
                    "A raised result is available for the patient and clinical team to interpret."
                ),
                evidenceEntryIds=[entry.id for entry in tests],
                clinical=True,
            )
        )

    proposed: str | None = None
    explanation: str
    if state.phase == "stable" and (sustained_change or repeated_worse):
        proposed = "watch"
        explanation = (
            "Several patient-reported signals have changed together. A wearable signal may "
            "support the pattern but cannot trigger this proposal on its own."
        )
    elif state.phase == "watch" and established_test:
        proposed = "flare"
        explanation = (
            "Objective test evidence is now present. A clinician still establishes and treats a "
            "flare; the app only proposes changing its support mode."
        )
    elif (
        state.phase == "watch"
        and not state.phaseConfirmed
        and (sustained_change or repeated_worse)
    ):
        proposed = "watch"
        explanation = (
            f"The watchful state is awaiting {patient_name}’s confirmation. Review and correct "
            "the cited entries before confirming it."
        )
    elif (
        state.phase == "flare"
        and state.prescription.status == "collected"
        and symptoms_settling(state)
    ):
        proposed = "recovery"
        explanation = (
            "Clinician-authorised treatment was collected and a patient record says symptoms are "
            "settling. The patient must confirm recovery mode; MeMed does not alter the "
            "prescription."
        )
    elif state.phase == "recovery" and recovery_relapse_detected(
        state, pain_signal_threshold
    ):
        proposed = "flare"
        explanation = (
            "Several patient-reported change signals have returned during recovery. The app "
            "proposes renewed flare support and same-day team contact; it does not change medicine."
        )
    elif (
        state.phase == "recovery"
        and state.taper.days
        and taper_course_complete(state)
        and symptoms_settling(state)
    ):
        proposed = "stable"
        explanation = (
            "The verified course is complete. Confirm symptoms are back at baseline before "
            "re-learning the stable baseline."
        )
    else:
        explanation = (
            "No governed phase change is proposed. Continue the current care plan and correct any "
            "source entry that is inaccurate."
        )

    explanation += (
        f" Demo rule v1 considered included records in the seven-day window "
        f"{window_start.isoformat()} to {latest_date.isoformat()}; older records remain baseline "
        "context only."
    )

    return LifecycleEvaluation(
        currentPhase=state.phase,
        proposedPhase=proposed,  # type: ignore[arg-type]
        needsConfirmation=proposed is not None,
        signals=signals,
        explanation=explanation,
    )


def eligible_test_order_signals(state: DemoState) -> list[LifecycleSignal]:
    """Return current patient-reported signals eligible for the demo test rule.

    Wearable context and an already-returned test result are intentionally excluded. The rule
    requires at least two distinct included patient-reported change signals in the recent window.
    """

    return [
        signal
        for signal in evaluate_lifecycle(state).signals
        if signal.clinical and signal.key in TEST_ORDER_SIGNAL_KEYS
    ]


def has_eligible_test_order_evidence(state: DemoState) -> bool:
    return _signals_span_recorded_days(eligible_test_order_signals(state), state)


def _signals_span_recorded_days(
    signals: list[LifecycleSignal], state: DemoState
) -> bool:
    evidence_ids = {
        entry_id for signal in signals for entry_id in signal.evidenceEntryIds
    }
    records = [
        entry for entry in state.entries if not entry.excluded and entry.id in evidence_ids
    ]
    return (
        len(signals) >= 2
        and len(records) >= 2
        and len({entry.date for entry in records}) >= 2
    )


def has_included_raised_test(state: DemoState) -> bool:
    if state.testOrder.status not in {"result", "shared"} or state.testOrder.result is None:
        return False
    return any(
        not entry.excluded
        and entry.kind == "TEST RESULT"
        and entry.source == "care"
        and _numeric(entry.structured.get("calprotectin")) == state.testOrder.result
        and state.testOrder.result >= 250
        for entry in state.entries
    )


def symptoms_settling(state: DemoState) -> bool:
    """Require a minimum post-treatment window and repeated records on distinct days."""

    if state.prescription.status != "collected" or not state.prescription.treatmentStartedAt:
        return False
    try:
        treatment_start = datetime.fromisoformat(
            state.prescription.treatmentStartedAt.replace("Z", "+00:00")
        )
        if treatment_start.tzinfo is None:
            treatment_start = treatment_start.replace(tzinfo=UTC)
    except ValueError:
        return False
    now = datetime.now(UTC)
    if now < treatment_start + timedelta(hours=state.prescription.reviewAfterHours):
        return False
    patient_zone = ZoneInfo(state.profile.timeZone)
    local_now = now.astimezone(patient_zone)
    local_start = treatment_start.astimezone(patient_zone)
    included = sorted(
        (
            entry
            for entry in state.entries
            if not entry.excluded
            and f"{entry.date}T{entry.time}" >= local_start.strftime("%Y-%m-%dT%H:%M")
            and f"{entry.date}T{entry.time}" <= local_now.strftime("%Y-%m-%dT%H:%M")
        ),
        key=lambda entry: (entry.date, entry.time, entry.id),
        reverse=True,
    )
    pain_baseline = _baseline_high(state.profile.usualPain, default=2, maximum=10)
    settling: list[JournalEntry] = []
    for entry in included:
        if entry.kind == "WELLBEING" and str(entry.structured.get("wellbeing", "")).lower() in {
            "better",
            "settling",
            "baseline",
        }:
            settling.append(entry)
            continue
        if (
            entry.kind == "PAIN"
            and 0 <= _numeric(entry.structured.get("pain")) <= pain_baseline + 1
        ):
            settling.append(entry)
            continue
        if entry.kind == "BOWEL MOVEMENT":
            bristol = _numeric(entry.structured.get("bristol"))
            blood = str(entry.structured.get("blood", "none")).lower()
            if bristol and bristol <= 5 and blood in {"none", "", "false"} and not bool(
                entry.structured.get("urgency")
            ):
                settling.append(entry)
    return len(settling) >= 2 and len({entry.date for entry in settling}) >= 2


def taper_course_complete(state: DemoState, today_value: date | None = None) -> bool:
    """A course is reconciled only after its final date; missed doses remain explicit."""

    if not state.taper.days:
        return False
    today_value = today_value or _patient_today(state.profile)
    try:
        final_date = date.fromisoformat(state.taper.days[-1].date)
    except ValueError:
        return False
    missed = set(state.taper.missedDays)
    return final_date <= today_value and all(
        day.taken or day.day in missed for day in state.taper.days
    )


def recovery_relapse_detected(state: DemoState, pain_threshold: float | None = None) -> bool:
    """Look only after the latest settling record so pre-treatment evidence is not reused."""

    treatment_start = ""
    if state.prescription.treatmentStartedAt:
        try:
            start_value = datetime.fromisoformat(
                state.prescription.treatmentStartedAt.replace("Z", "+00:00")
            )
            if start_value.tzinfo is None:
                start_value = start_value.replace(tzinfo=UTC)
            treatment_start = start_value.astimezone(
                ZoneInfo(state.profile.timeZone)
            ).strftime("%Y-%m-%dT%H:%M")
        except ValueError:
            treatment_start = ""
    entries = sorted(
        (
            entry
            for entry in state.entries
            if not entry.excluded
            and (not treatment_start or f"{entry.date}T{entry.time}" >= treatment_start)
        ),
        key=lambda entry: (entry.date, entry.time, entry.id),
    )
    marker = -1
    baseline = _baseline_high(state.profile.usualPain, default=2, maximum=10)
    threshold = pain_threshold if pain_threshold is not None else min(10, max(4, baseline + 2))
    for index, entry in enumerate(entries):
        settling_wellbeing = (
            entry.kind == "WELLBEING"
            and str(entry.structured.get("wellbeing", "")).lower()
            in {"better", "settling", "baseline"}
        )
        settling_pain = entry.kind == "PAIN" and 0 <= _numeric(
            entry.structured.get("pain")
        ) <= baseline + 1
        if settling_wellbeing or settling_pain:
            marker = index
    if marker < 0:
        return False

    change_records: list[JournalEntry] = []
    for entry in entries[marker + 1 :]:
        structured = entry.structured
        if entry.kind == "WELLBEING" and str(structured.get("wellbeing", "")).lower() == "worse":
            change_records.append(entry)
        elif entry.kind == "PAIN" and _numeric(structured.get("pain")) >= threshold:
            change_records.append(entry)
        elif entry.kind == "BOWEL MOVEMENT" and (
            _numeric(structured.get("bristol")) >= 6
            or str(structured.get("blood", "none")).lower() not in {"none", "", "false"}
            or bool(structured.get("urgency"))
        ):
            change_records.append(entry)
    return len(change_records) >= 2 and len({entry.date for entry in change_records}) >= 2


def apply_explicit_record_corrections(
    entry: JournalEntry, body: str
) -> dict[str, str | int | float | bool]:
    """Refresh structured evidence only where the corrected wording is explicit."""

    structured = dict(entry.structured)
    lowered = body.lower()
    if entry.kind == "BOWEL MOVEMENT":
        bristol = re.search(r"(?:bristol(?:\s+type)?|stool\s+type|type)\s*([1-7])", lowered)
        if bristol:
            structured["bristol"] = int(bristol.group(1))
        if re.search(r"\b(?:no|without)\s+(?:visible\s+)?blood\b", lowered):
            structured["blood"] = "none"
        elif re.search(
            r"\b(?:heavy|continuous)\b.{0,18}\b(?:blood|bleeding)\b|"
            r"\b(?:blood|bleeding)\b.{0,18}\b(?:heavy|continuous)\b",
            lowered,
        ):
            structured["blood"] = "heavy"
        elif re.search(r"\bmoderate\b.{0,18}\b(?:blood|bleeding)\b", lowered):
            structured["blood"] = "moderate"
        elif match := re.search(r"\b(trace|small|tiny|little)\b.{0,22}\bblood\b", lowered):
            structured["blood"] = match.group(1)
        if re.search(r"\b(?:no|without)\s+urgency\b", lowered):
            structured["urgency"] = False
        elif re.search(r"\burgency|\burgent\b", lowered):
            structured["urgency"] = True
        if re.search(r"\b(?:no|without)\s+mucus\b", lowered):
            structured["mucus"] = False
        elif re.search(r"\bmucus\b", lowered):
            structured["mucus"] = True
        if re.search(
            r"\b(?:no|without)\s+(?:night\s+waking|waking\s+at\s+night)\b", lowered
        ):
            structured["nightWaking"] = False
        elif re.search(r"\bnight\s+waking|\bwoke\b.{0,12}\bnight\b", lowered):
            structured["nightWaking"] = True
        if pain := re.search(r"\b(?:pain|cramp(?:s|ing|y)?)\D{0,12}(10|[0-9])", lowered):
            structured["pain"] = int(pain.group(1))
    elif entry.kind == "PAIN":
        if re.search(r"\bno\s+(?:pain|cramp(?:s|ing|y)?)\b", lowered):
            structured["pain"] = 0
        elif pain := re.search(
            r"(?:\b(?:pain|cramp(?:s|ing|y)?)\D{0,12})?\b(10|[0-9])\s*/\s*10\b",
            lowered,
        ):
            structured["pain"] = int(pain.group(1))
    elif entry.kind in {"WELLBEING", "FATIGUE"}:
        if comparison := re.search(r"\b(better|same|worse|settling|baseline)\b", lowered):
            if entry.kind == "WELLBEING":
                structured["wellbeing"] = comparison.group(1)
        if re.search(r"\b(?:no|without)\s+fatigue\b", lowered):
            structured["fatigue"] = "none"
        elif fatigue := re.search(
            r"\bfatigue(?:\s+(?:is|was))?\s*[:=-]?\s*(low|mild|moderate|high|severe)\b|"
            r"\b(low|mild|moderate|high|severe)\s+fatigue\b",
            lowered,
        ):
            structured["fatigue"] = fatigue.group(1) or fatigue.group(2)
        if re.search(r"\bsleep\s+(?:is\s+)?not\s+recorded\b", lowered):
            structured.pop("sleepHours", None)
        elif sleep := re.search(
            r"(?:slept|sleep(?:ing)?(?:\s+for)?|got)\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b",
            lowered,
        ):
            structured["sleepHours"] = float(sleep.group(1))
        if re.search(r"\bweight\s+(?:is\s+)?not\s+recorded\b", lowered):
            structured.pop("weightKg", None)
        elif weight := re.search(r"\b(?:weight|weigh)\D{0,8}(\d+(?:\.\d+)?)\s*kg\b", lowered):
            structured["weightKg"] = float(weight.group(1))
        if mood := re.search(
            r"\bmood(?:\s+(?:is|was))?\s*[:=-]?\s*(anxious|low|irritable|good)\b",
            lowered,
        ):
            structured["mood"] = mood.group(1)
        if appetite := re.search(
            r"\bappetite(?:\s+(?:is|was))?\s*[:=-]?\s*(reduced|low|poor|usual|increased)\b",
            lowered,
        ):
            structured["appetite"] = appetite.group(1)
    elif entry.kind == "FROM YOUR WATCH":
        if re.search(r"\b(?:resting\s+)?(?:heart\s+rate|hr)\s+(?:is\s+)?not\s+recorded\b", lowered):
            structured.pop("restingHeartRate", None)
        elif heart_rate := re.search(
            r"\b(?:resting\s+)?(?:heart\s+rate|hr)\D{0,8}(\d{2,3})\s*(?:bpm)?\b",
            lowered,
        ):
            structured["restingHeartRate"] = int(heart_rate.group(1))
        if re.search(r"\b(?:hrv|heart[- ]rate variability)\s+(?:is\s+)?not\s+recorded\b", lowered):
            structured.pop("heartRateVariabilityMs", None)
        elif hrv := re.search(
            r"\b(?:hrv|heart[- ]rate variability)\D{0,8}(\d+(?:\.\d+)?)\s*"
            r"(?:ms|milliseconds?)\b",
            lowered,
        ):
            structured["heartRateVariabilityMs"] = float(hrv.group(1))
        if re.search(r"\bsleep\s+(?:is\s+)?not\s+recorded\b", lowered):
            structured.pop("sleepHours", None)
        elif sleep := re.search(
            r"\bsleep\D{0,8}(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b", lowered
        ):
            structured["sleepHours"] = float(sleep.group(1))
        if activity := re.search(r"\b(?:activity|steps?)\D{0,8}(\d{2,6})\b", lowered):
            structured["activitySteps"] = int(activity.group(1))
    elif entry.kind == "MEDICATION":
        if re.search(r"\b(?:not\s+taken|did(?:\s+not|n't)\s+take|missed)\b", lowered):
            structured["taken"] = False
        elif re.search(r"\b(?:taken|took)\b", lowered):
            structured["taken"] = True
        if dose := re.search(r"\b(\d+(?:\.\d+)?)\s*mg\b", lowered):
            structured["doseMg"] = float(dose.group(1))
    return structured


def derive_entry_flagged(entry: JournalEntry, profile: Profile | None = None) -> bool:
    structured = entry.structured
    if entry.kind == "BOWEL MOVEMENT":
        blood = str(structured.get("blood", "none")).lower()
        return blood not in {"", "none", "false"} or _numeric(structured.get("pain")) >= 7
    if entry.kind == "PAIN":
        return _numeric(structured.get("pain")) >= 7
    if entry.kind == "WELLBEING":
        return str(structured.get("wellbeing", "")).lower() == "worse" or str(
            structured.get("fatigue", "")
        ).lower() in {"high", "severe"}
    if entry.kind == "FATIGUE":
        return str(structured.get("fatigue", "")).lower() in {"high", "severe"}
    if entry.kind == "MEDICATION":
        return structured.get("taken") is False
    if entry.kind == "FROM YOUR WATCH" and profile is not None:
        heart_rate = _numeric(structured.get("restingHeartRate"))
        sleep_hours = _numeric(structured.get("sleepHours"))
        heart_rate_baseline = _baseline_high(profile.usualHeartRate, default=0, maximum=250)
        sleep_baseline = _baseline_high(profile.usualSleep, default=0, maximum=24)
        return (heart_rate_baseline > 0 and heart_rate >= heart_rate_baseline + 5) or (
            sleep_baseline > 0 and sleep_hours > 0 and sleep_hours <= sleep_baseline - 1
        )
    return bool(entry.flagged)


def build_clinician_summary(state: DemoState) -> str:
    all_included = sorted(
        (
            entry
            for entry in state.entries
            if not entry.excluded and entry.kind != "Penny noticed"
        ),
        key=lambda entry: (entry.date, entry.time, entry.id),
        reverse=True,
    )
    included = all_included[:10]
    patient = state.profile.name.strip() or "The patient"
    baseline = "; ".join(
        value
        for value in (
            state.profile.usualBowel,
            state.profile.usualPain,
            state.profile.usualHeartRate,
            state.profile.usualSleep,
        )
        if value.strip()
    )
    lines = "\n".join(
        f"- {entry.date} {entry.time} — {entry.kind}: {entry.body}" for entry in included
    )
    included_test = next(
        (
            entry
            for entry in all_included
            if entry.kind == "TEST RESULT"
            and entry.source == "care"
            and state.testOrder.status in {"result", "shared"}
            and state.testOrder.result is not None
            and isinstance(entry.structured.get("calprotectin"), (int, float))
            and entry.structured["calprotectin"] == state.testOrder.result
        ),
        None,
    )
    if included_test is not None:
        test = (
            f"Faecal calprotectin: {included_test.structured['calprotectin']} µg/g; "
            "clinical interpretation is required."
        )
    elif state.testOrder.result is not None:
        test = (
            "A test result exists in the care workflow, but its journal evidence is excluded "
            "or deleted and is not used in this summary."
        )
    else:
        test = "No test result is recorded."
    taper_taken = sum(day.taken for day in state.taper.days)
    taper_verification = (
        f"verified from {state.taper.prescribedBy or 'the recorded prescriber'}"
        if state.taper.verified
        else "not yet verified"
    )
    taper_check_in = (
        "The latest recovery side-effect check-in is marked complete."
        if state.taper.checkInComplete
        else "The latest recovery side-effect check-in is not marked complete."
    )
    taper_missed = (
        f"; {len(state.taper.missedDays)} past doses explicitly reconciled as not taken "
        f"(days {', '.join(str(day) for day in state.taper.missedDays)})"
        if state.taper.missedDays
        else "; no past doses explicitly reconciled as not taken"
    )
    taper_active = state.prescription.status == "collected" or (
        state.phase == "recovery"
        and state.phaseConfirmed
        and state.pendingPhase is None
    )
    taper_position = (
        f"day {state.taper.currentDay} of {len(state.taper.days) or 'an incomplete schedule'}"
        if taper_active
        else "schedule prepared; dose support is not active"
    )
    taper_summary = (
        f"Patient-recorded prescribed course: {state.taper.medicine or 'medicine not recorded'}; "
        f"{taper_verification}; "
        f"{taper_position}; "
        f"{taper_taken} dose{'s' if taper_taken != 1 else ''} marked taken{taper_missed}. "
        f"{taper_check_in} "
        + (
            f"Patient-recorded recovery observations: {', '.join(state.taper.sideEffects)}."
            if state.taper.sideEffects
            else "No recovery side effects are currently recorded."
        )
        if state.taper.medicine or state.taper.days
        else "No prescribed recovery course is recorded."
    )
    experiment_observations = state.experiment.observations[-6:]
    experiment_summary = (
        f"Diet experiment: {state.experiment.title}; status {state.experiment.status}; "
        f"{state.experiment.day} of {state.experiment.durationDays} planned days recorded.\n"
        f"One variable: {state.experiment.variable or 'not defined'}. Goal: "
        f"{state.experiment.goal or 'not defined'}. Pre-start baseline: "
        f"{state.experiment.baseline or 'not recorded'}. Outcome defined before starting: "
        f"{state.experiment.outcome or 'not defined'}.\n"
        + (
            (
                "Clinical-team approval was recorded for this unchanged candidate by "
                f"{state.experiment.reviewApprovedBy}."
            )
            if state.experiment.reviewApprovedAt
            else "Dietitian or IBD-team review is required before this candidate can start."
            if state.experiment.reviewRequired
            else "No pre-start clinical review is recorded as required for this candidate."
        )
        + (
            "\nPersonal observations (not causal conclusions):\n- "
            + "\n- ".join(experiment_observations)
            if experiment_observations
            else "\nNo personal experiment observations are recorded."
        )
        if state.experiment.title
        else "No diet experiment is recorded."
    )
    return "\n\n".join(
        (
            f"{patient}’s editable MeMed summary, rebuilt from currently included records.",
            f"Personal baseline: {baseline}."
            if baseline
            else "Personal baseline has not been completed.",
            (
                f"Patient-recorded current medicines: {state.profile.currentMedicines}."
                if state.profile.currentMedicines
                else "No current medicine list is recorded."
            ),
            test,
            taper_summary,
            experiment_summary,
            f"Recent included records:\n{lines}"
            if lines
            else "No included journal records are available.",
            (
                "This is a patient-reviewed record, not a diagnosis or medication instruction. "
                "No medication change has been made by MeMed."
            ),
        )
    )


def extract_profile_proposals(text: str) -> list[ProfileProposalDraft]:
    trimmed = text.strip()
    if not trimmed or re.search(r"\?\s*$", trimmed):
        return []
    patterns = (
        (
            "surgeries",
            re.compile(
                r"\b(?:i\s+(?:have\s+)?(?:had|undergone)|i\s+underwent)\s+"
                r"(?:an?\s+)?(.+?\b(?:surgery|operation|resection|colectomy|"
                r"proctocolectomy|ileostomy|colostomy|stoma)\b.*?)"
                r"(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            1,
        ),
        (
            "surgeries",
            re.compile(
                r"\bi\s+have\s+(an?\s+)?((?:ileostomy|colostomy|stoma)\b.*?)"
                r"(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            2,
        ),
        (
            "allergies",
            re.compile(
                r"\bi(?:'m|\s+am)\s+allergic\s+to\s+(.+?)"
                r"(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            1,
        ),
        (
            "allergies",
            re.compile(
                r"\bi\s+have\s+(?:an?\s+)?allerg(?:y|ies)\s+to\s+(.+?)"
                r"(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            1,
        ),
        (
            "conditions",
            re.compile(
                r"\bi\s+(?:was|have\s+been)\s+diagnosed\s+with\s+(.+?)"
                r"(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            1,
        ),
        (
            "conditions",
            re.compile(
                r"\b(?:my\s+medical\s+history\s+includes|i\s+have\s+(?:a\s+)?"
                r"history\s+of)\s+(.+?)(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            1,
        ),
        (
            "conditions",
            re.compile(
                r"\bi\s+have\s+((?:type\s+[12]\s+)?(?:diabetes|osteopenia|osteoporosis|"
                r"coeliac\s+disease|celiac\s+disease|arthritis|anxiety|depression|asthma|"
                r"hypertension|anaemia|anemia|primary\s+sclerosing\s+cholangitis|psc)\b.*?)"
                r"(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            1,
        ),
        (
            "pastMedicines",
            re.compile(
                r"\bi\s+(?:used\s+to|previously)\s+(?:take|took)\s+(.+?)"
                r"(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            1,
        ),
        (
            "pastMedicines",
            re.compile(
                r"\bi\s+stopped\s+(?:taking\s+)?(.+?)"
                r"(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            1,
        ),
        (
            "pastMedicines",
            re.compile(
                r"\bi\s+took\s+(.+?)\s+(?:in\s+the\s+past|previously|before)"
                r"(?=\s+and\s+i\b|[.!?]|$)",
                re.I,
            ),
            1,
        ),
    )
    proposals: list[ProfileProposalDraft] = []
    for field, expression, group in patterns:
        match = expression.search(trimmed)
        if not match:
            continue
        value = re.sub(r"[.!?]+$", "", match.group(group).strip()).strip()
        if not value or any(
            proposal.field == field and proposal.value.casefold() == value.casefold()
            for proposal in proposals
        ):
            continue
        proposals.append(ProfileProposalDraft(field=field, value=value))
    return proposals


def parse_blood_amount_clarification(text: str) -> str | None:
    """Parse a short, amount-only answer to a pending blood clarification.

    The narrow vocabulary prevents a longer symptom report from being consumed as a follow-up;
    those reports must continue through the ordinary capture and deterministic safety pipeline.
    """

    lowered = text.strip().lower().replace("’", "'")
    words = re.findall(r"[a-z]+(?:'[a-z]+)?", lowered)
    if not words or len(words) > 12:
        return None
    if re.search(
        r"\b(pain|cramp|fever|faint|dizzy|vomit|dehydrat|stool|diarrh|urgency|mucus)\b",
        lowered,
    ):
        return None
    if re.search(r"\b(?:not sure|unsure|don't know|do not know|cannot tell|can't tell)\b", lowered):
        return "unspecified"
    if re.search(r"\b(?:none|no blood|didn't see any|did not see any)\b", lowered):
        return "none"
    if re.search(r"\b(?:continuous|won't stop|would not stop)\b", lowered):
        return "continuous"
    if re.search(r"\b(?:heavy|a lot|lots|large(?: amount)?)\b", lowered):
        return "heavy"
    if re.search(r"\bmoderate\b", lowered):
        return "moderate"
    if re.search(r"\b(?:trace|tiny|little)\b", lowered):
        return "trace"
    if re.search(r"\bsmall\b", lowered):
        return "small"
    return None


def parse_capture(text: str) -> CaptureDraft:
    lowered = text.lower()
    profile_proposals = extract_profile_proposals(text)
    safety_details = extract_structured_safety_details(text)
    question_starters = (
        "what ",
        "when ",
        "where ",
        "why ",
        "how ",
        "is ",
        "are ",
        "can ",
        "should ",
    )
    if text.strip().endswith("?") or lowered.lstrip().startswith(question_starters):
        return CaptureDraft(
            entries=[],
            profileProposals=[],
            missing=[],
            note="This looks like a question, so no health record draft was created.",
        )
    entries: list[JournalDraft] = []
    missing: list[str] = []

    bowel_cues = (
        "stool",
        "bowel",
        "poo",
        "toilet",
        "diarrhoea",
        "diarrhea",
        "loose",
        "blood",
        "urgency",
        "urgent",
    )
    if any(word in lowered for word in bowel_cues) or re.search(r"\bloo\b", lowered):
        structured: dict[str, str | int | float | bool] = {}
        bristol_match = re.search(r"(?:bristol|type)\s*([1-7])", lowered)
        if bristol_match:
            structured["bristol"] = int(bristol_match.group(1))
        elif "loose" in lowered or "diarrhoea" in lowered or "diarrhea" in lowered:
            structured["consistency"] = "loose"
            missing.append("Bristol type, if known")
        else:
            missing.append("Bristol type, if known")
        urgency_negated = bool(
            re.search(
                r"\b(?:no|without)\s+urgency\b|"
                r"\b(?:did(?:\s+not|n't)|do(?:\s+not|n't))\s+feel\s+urgent\b",
                lowered,
            )
        )
        urgency_mentioned = "urgent" in lowered or "urgency" in lowered
        if urgency_mentioned:
            structured["urgency"] = not urgency_negated
        blood_negated = bool(
            re.search(
                r"\b(?:no|without)\s+(?:visible\s+)?(?:blood|bleeding)\b|"
                r"\b(?:did(?:\s+not|n't)\s+(?:see|notice)|saw\s+no)\s+"
                r"(?:any\s+)?blood\b",
                lowered,
            )
        )
        if "continuous bleeding" in lowered or "continuous blood" in lowered:
            structured["blood"] = "none" if blood_negated else "continuous"
        elif "heavy blood" in lowered or "heavy bleeding" in lowered:
            structured["blood"] = "none" if blood_negated else "heavy"
        elif re.search(
            r"\bmoderate(?:\s+amount\s+of)?\s+(?:visible\s+)?(?:blood|bleeding)\b",
            lowered,
        ):
            structured["blood"] = "none" if blood_negated else "moderate"
        elif "small amount of blood" in lowered or "little blood" in lowered:
            structured["blood"] = "none" if blood_negated else "small"
        elif "blood" in lowered:
            if blood_negated:
                structured["blood"] = "none"
            else:
                structured["blood"] = "reported"
                structured["needsClarification"] = "bloodAmount"
                missing.append("Amount of blood")
        mucus_negated = bool(re.search(r"\b(?:no|without)\s+mucus\b", lowered))
        if "mucus" in lowered:
            structured["mucus"] = not mucus_negated
        night_waking_negated = bool(
            re.search(
                r"\b(?:no|without)\s+(?:night\s+waking|waking\s+at\s+night)\b|"
                r"\bdid(?:\s+not|n't)\s+wake\b.{0,12}\bnight\b",
                lowered,
            )
        )
        night_waking_mentioned = bool(
            re.search(r"\bnight\s+waking\b|\bwok(?:e|en)\b.{0,12}\bnight\b", lowered)
        )
        if night_waking_mentioned or night_waking_negated:
            structured["nightWaking"] = night_waking_mentioned and not night_waking_negated
        structured.update(safety_details)
        entries.append(
            JournalDraft(
                kind="BOWEL MOVEMENT",
                body=text.strip(),
                source="chat",
                flagged=str(structured.get("blood", "none")).lower()
                not in {"", "none", "false"},
                structured=structured,
            )
        )

    pain_match = re.search(
        r"(?:pain(?:['’]s)?|cramp(?:s|ing|y)?)\D{0,18}?(10|[0-9])(?:\s*/\s*10)?",
        lowered,
    )
    if (
        pain_match
        or safety_details.get("severePain") is True
        or isinstance(safety_details.get("pain"), (int, float))
        or any(word in lowered for word in ("cramp", "shattered", "fatigue"))
    ):
        pain = (
            int(pain_match.group(1))
            if pain_match
            else int(safety_details["pain"])
            if isinstance(safety_details.get("pain"), (int, float))
            else None
        )
        structured = {}
        if pain is not None:
            structured["pain"] = pain
        if "shattered" in lowered or "fatigue" in lowered:
            structured["fatigue"] = "high"
        structured.update(safety_details)
        entries.append(
            JournalDraft(
                kind=(
                    "PAIN"
                    if pain is not None
                    or "cramp" in lowered
                    or safety_details.get("severePain") is True
                    else "FATIGUE"
                ),
                body=text.strip(),
                source="chat",
                flagged=bool(pain is not None and pain >= 8),
                structured=structured,
            )
        )

    meal_words = ("porridge", "breakfast", "lunch", "dinner", "ate ", "coffee", "meal")
    if any(word in lowered for word in meal_words):
        entries.append(
            JournalDraft(
                kind="MEAL",
                body=text.strip(),
                source="chat",
                structured={"descriptionConfirmed": False},
            )
        )

    if any(word in lowered for word in ("took my", "taken my", "medication taken")):
        entries.append(
            JournalDraft(
                kind="MEDICATION",
                body=text.strip(),
                source="chat",
                structured={"taken": True},
            )
        )

    wellbeing: dict[str, str | int | float | bool] = {}
    if comparison := re.search(
        r"(?:feel(?:ing)?|been|i(?:'m| am))\s+(better|same|worse)\b|"
        r"\b(better|same|worse)\s+than\s+(?:usual|normal)",
        lowered,
    ):
        wellbeing["wellbeing"] = comparison.group(1) or comparison.group(2)
    if sleep := re.search(
        r"(?:slept|sleep(?:ing)?(?:\s+for)?|got)\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b",
        lowered,
    ):
        wellbeing["sleepHours"] = float(sleep.group(1))
    if weight := re.search(
        r"(?:weigh|weight(?:\s+is)?|i(?:'m| am))\s*(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b",
        lowered,
    ):
        wellbeing["weightKg"] = float(weight.group(1))
    if mood := re.search(
        r"(?:mood\s+(?:is\s+)?|feel(?:ing)?\s+)(anxious|low|irritable|good)\b",
        lowered,
    ):
        wellbeing["mood"] = mood.group(1)
    if appetite := re.search(
        r"(?:appetite\s+(?:is\s+)?|feel(?:ing)?\s+)(reduced|low|poor|usual|increased)|"
        r"\b(no appetite)\b",
        lowered,
    ):
        wellbeing["appetite"] = "none" if appetite.group(2) else appetite.group(1)
    if wellbeing:
        wellbeing.update(safety_details)
        entries.append(
            JournalDraft(
                kind="WELLBEING",
                body=text.strip(),
                source="chat",
                flagged=wellbeing.get("wellbeing") == "worse",
                structured=wellbeing,
            )
        )

    if _safety_details_require_capture(safety_details) and not any(
        entry.kind in {"BOWEL MOVEMENT", "PAIN", "FATIGUE", "WELLBEING"}
        for entry in entries
    ):
        entries.append(
            JournalDraft(
                kind="WELLBEING",
                body=text.strip(),
                source="chat",
                flagged=True,
                structured={
                    "redFlagScreen": True,
                    "reportedText": text.strip(),
                    **safety_details,
                },
            )
        )

    if not entries and not profile_proposals and _contains_direct_safety_negation(text):
        return CaptureDraft(
            entries=[],
            profileProposals=[],
            missing=[],
            note=(
                "A directly negated red-flag statement was not converted into a symptom record."
            ),
        )

    if not entries and not profile_proposals:
        entries.append(
            JournalDraft(
                kind="WELLBEING",
                body=text.strip(),
                source="chat",
                structured={"needsReview": True},
            )
        )

    return CaptureDraft(
        entries=entries,
        profileProposals=profile_proposals,
        missing=list(dict.fromkeys(missing)),
        note=(
            "These are editable drafts from deterministic demo parsing. No clinical action is "
            "taken until the patient reviews the entries."
        ),
    )


def derive_food_symptom_patterns(
    state: DemoState,
    *,
    window_hours: int = 12,
    limit: int = 3,
) -> list[PersonalPatternSummary]:
    """Build transparent diary episodes without inferring that food caused symptoms.

    Each symptom record is assigned to the nearest earlier included meal inside the bounded
    window. The exact meal and symptom entry IDs travel with the summary, so corrections or
    exclusions rebuild it rather than leaving a hidden inference behind.
    """

    def recorded_at(entry: JournalEntry) -> datetime | None:
        try:
            return datetime.fromisoformat(f"{entry.date}T{entry.time or '00:00'}:00")
        except ValueError:
            return None

    today = _patient_today(state.profile)
    oldest = today - timedelta(days=90)
    included: list[tuple[JournalEntry, datetime]] = []
    for entry in state.entries:
        if entry.excluded:
            continue
        at = recorded_at(entry)
        if at is None or not oldest <= at.date() <= today:
            continue
        included.append((entry, at))

    meals = [(entry, at) for entry, at in included if entry.kind == "MEAL"]
    symptoms = [
        (entry, at)
        for entry, at in included
        if entry.kind in {"BOWEL MOVEMENT", "PAIN", "FATIGUE", "WELLBEING"}
    ]
    assigned: dict[int, list[tuple[JournalEntry, datetime]]] = {
        entry.id: [] for entry, _ in meals
    }
    window = timedelta(hours=window_hours)
    for symptom, symptom_at in symptoms:
        eligible = [
            (meal, meal_at)
            for meal, meal_at in meals
            if timedelta(0) < symptom_at - meal_at <= window
        ]
        if not eligible:
            continue
        nearest, _ = max(eligible, key=lambda item: item[1])
        assigned[nearest.id].append((symptom, symptom_at))

    patterns: list[PersonalPatternSummary] = []
    for meal, meal_at in sorted(meals, key=lambda item: item[1], reverse=True):
        following = sorted(assigned[meal.id], key=lambda item: (item[1], item[0].id))
        if not following:
            continue
        last_at = following[-1][1]
        elapsed_hours = max(1, round((last_at - meal_at).total_seconds() / 3600))
        count = len(following)
        disclaimer = (
            "Correlation is not proof that this meal caused the symptoms; other changes and "
            "unrecorded factors may explain the timing."
        )
        patterns.append(
            PersonalPatternSummary(
                id=f"food-episode-{meal.id}",
                title=(
                    f"{count} symptom {'record followed' if count == 1 else 'records followed'} "
                    "a recorded meal"
                ),
                summary=(
                    f"Within about {elapsed_hours} hour{'s' if elapsed_hours != 1 else ''} after "
                    f"the {meal.date} {meal.time} meal “{meal.body}”, {count} included symptom "
                    f"{'entry was' if count == 1 else 'entries were'} recorded."
                ),
                sourceEntryIds=[meal.id, *[entry.id for entry, _ in following]],
                disclaimer=disclaimer,
            )
        )
        if len(patterns) >= limit:
            break
    return patterns


def build_dashboard(state: DemoState) -> DashboardResponse:
    phase_content = {
        "stable": ("Steady", 14, "at baseline"),
        "watch": ("Watchful", 62, "change under review"),
        "flare": ("Flare support", 90, "extra support active"),
        "recovery": ("Recovering", 36, "verified taper support"),
    }
    label, gauge, subtitle = phase_content[state.phase]
    latest_bowel = _latest(state.entries, "BOWEL MOVEMENT")
    latest_pain = _latest(state.entries, "PAIN")
    latest_watch = _latest(state.entries, "FROM YOUR WATCH")
    metrics = [
        {
            "key": "bowel",
            "label": "Latest bowel entry",
            "value": latest_bowel.body if latest_bowel else "No entry",
            "comparison": (
                f"Personal baseline: {state.profile.usualBowel}"
                if state.profile.usualBowel
                else "Personal bowel baseline not recorded"
            ),
        },
        {
            "key": "pain",
            "label": "Latest pain",
            "value": latest_pain.body if latest_pain else "No entry",
            "comparison": (
                f"Personal baseline: {state.profile.usualPain}"
                if state.profile.usualPain
                else "Personal pain baseline not recorded"
            ),
        },
        {
            "key": "wearable",
            "label": "Latest passive signal",
            "value": latest_watch.body if latest_watch else "Not connected",
            "comparison": "Supporting context only",
        },
    ]
    today = _patient_today(state.profile)
    trend_start = today - timedelta(days=13)
    recent_clinical: list[JournalEntry] = []
    for entry in state.entries:
        if entry.excluded or entry.kind not in {
            "BOWEL MOVEMENT",
            "PAIN",
            "FATIGUE",
            "WELLBEING",
            "FROM YOUR WATCH",
            "TEST RESULT",
        }:
            continue
        try:
            entry_date = date.fromisoformat(entry.date)
        except ValueError:
            continue
        if trend_start <= entry_date <= today:
            recent_clinical.append(entry)
    by_day: dict[str, dict[str, Any]] = {
        (trend_start + timedelta(days=offset)).isoformat(): {
            "symptom": 0,
            "heartRate": 0,
            "bowel": 0,
        }
        for offset in range(14)
    } if recent_clinical else {}
    bowel_records_by_day: dict[str, list[JournalEntry]] = {}
    for entry in recent_clinical:
        values = by_day[entry.date]
        values["symptom"] = max(
            values["symptom"],
            _numeric(entry.structured.get("pain")),
        )
        values["heartRate"] = max(
            values["heartRate"],
            _numeric(entry.structured.get("restingHeartRate")),
        )
        if entry.kind == "BOWEL MOVEMENT":
            bowel_records_by_day.setdefault(entry.date, []).append(entry)
    for day, records in bowel_records_by_day.items():
        explicit = [
            int(value)
            for entry in records
            if (
                value := entry.structured.get(
                    "dailyCount", entry.structured.get("bowelMovements24h")
                )
            )
            is not None
        ]
        by_day[day]["bowel"] = max(explicit) if explicit else len(records)
    trend = [{"day": day, **values} for day, values in sorted(by_day.items())]
    lifecycle = evaluate_lifecycle(state)
    evidence = []
    for signal in lifecycle.signals:
        for entry_id in signal.evidenceEntryIds:
            entry = next((item for item in state.entries if item.id == entry_id), None)
            if entry is not None:
                evidence.append(
                    EvidenceSource(
                        entryId=entry.id,
                        label=signal.label,
                        date=f"{entry.date}, {entry.time}",
                        detail=entry.body,
                        type="pattern" if len(signal.evidenceEntryIds) > 1 else "fact",
                        excluded=entry.excluded,
                    )
                )
    suggestions = _suggestions(state.phase)
    return DashboardResponse(
        phase=state.phase,
        phaseLabel=f"{label} — {subtitle}",
        gaugePercent=gauge,
        metrics=metrics,
        trend=trend,
        suggestions=suggestions,
        evidence=evidence,
        personalPatterns=derive_food_symptom_patterns(state),
    )


def _suggestions(phase: str) -> list[dict[str, str]]:
    if phase == "stable":
        return [
            {"kind": "experiment", "title": "Continue one-variable experiment", "cta": "View"},
            {"kind": "summary", "title": "Prepare clinic summary", "cta": "Preview"},
        ]
    if phase == "watch":
        return [
            {"kind": "team", "title": "Contact your IBD team first", "cta": "Review message"},
            {"kind": "test", "title": "Review prepared calprotectin test", "cta": "Review order"},
        ]
    if phase == "flare":
        return [
            {"kind": "urgent", "title": "Run the deterministic safety check", "cta": "Check"},
            {"kind": "team", "title": "Review today’s team update", "cta": "Review"},
        ]
    return [
        {"kind": "taper", "title": "Confirm today’s prescribed dose", "cta": "Open taper"},
        {"kind": "summary", "title": "Preview recovery summary", "cta": "Preview"},
    ]


def _numeric(value: object) -> float:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return float(value)
    return 0


def _baseline_high(text: str, *, default: float, maximum: float) -> float:
    cleaned = re.sub(r"/\s*10\b", "", text)
    values = [
        float(match)
        for match in re.findall(r"\d+(?:\.\d+)?", cleaned)
        if float(match) <= maximum
    ]
    return max(values, default=default)


def _latest(entries: list[JournalEntry], kind: str) -> JournalEntry | None:
    matches = [entry for entry in entries if entry.kind == kind and not entry.excluded]
    return max(matches, key=lambda entry: (entry.date, entry.time), default=None)
