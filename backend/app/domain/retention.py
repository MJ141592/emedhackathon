from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.store import SQLiteDemoStore


def cleanup_expired_media(
    store: SQLiteDemoStore,
    *,
    as_of: date | None = None,
    actor: str = "retention-job",
) -> dict[str, Any]:
    """Remove expired image payloads while preserving their health-record entries.

    The preflight avoids creating a new aggregate revision when there is no work. The
    mutator checks the retention date again so both the API endpoint and the periodic
    application job share exactly the same policy.
    """

    current = store.get()
    effective_date = as_of or datetime.now(UTC).astimezone(
        ZoneInfo(current.profile.timeZone)
    ).date()

    def expired(entry: Any) -> bool:
        photo = entry.photo if hasattr(entry, "photo") else entry.get("photo")
        if photo is None:
            return False
        preview_url = photo.previewUrl if hasattr(photo, "previewUrl") else photo.get("previewUrl")
        if not preview_url:
            return False
        entry_date = entry.date if hasattr(entry, "date") else entry.get("date")
        retention_days = (
            photo.retentionDays if hasattr(photo, "retentionDays") else photo.get("retentionDays")
        )
        try:
            return date.fromisoformat(str(entry_date)) + timedelta(
                days=int(retention_days)
            ) <= effective_date
        except (OverflowError, TypeError, ValueError):
            return False

    candidate_ids = [entry.id for entry in current.entries if expired(entry)]
    if not candidate_ids:
        return {
            "asOf": effective_date.isoformat(),
            "removedEntryIds": [],
            "removedCount": 0,
        }

    removed_ids: list[int] = []

    def apply(state: dict[str, Any]) -> None:
        for entry in state["entries"]:
            if not expired(entry):
                continue
            photo = entry["photo"]
            photo["previewUrl"] = ""
            photo["derivedObservation"] = None
            entry.setdefault("structured", {})["mediaRetentionExpired"] = True
            removed_ids.append(int(entry["id"]))

    store.mutate(
        apply,
        f"Media retention cleanup removed {len(candidate_ids)} expired payload(s)",
        actor=actor,
        metadata={"resource": "media-retention", "asOf": effective_date.isoformat()},
    )
    # Blanking the current aggregate is not sufficient for sensitive images: the prior JSON
    # can remain in SQLite/WAL pages. Compact only when a payload was actually removed.
    store.purge_deleted_payload_bytes()
    return {
        "asOf": effective_date.isoformat(),
        "removedEntryIds": removed_ids,
        "removedCount": len(removed_ids),
    }
