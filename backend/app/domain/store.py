from __future__ import annotations

import json
import os
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, TypeVar

from cryptography.fernet import Fernet, InvalidToken
from dotenv import load_dotenv

from app.domain.models import DemoState
from app.domain.seed import build_demo_state, build_empty_state

T = TypeVar("T")

class VersionConflictError(RuntimeError):
    """Raised when optimistic concurrency detects a stale snapshot."""


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


class SQLiteDemoStore:
    """Atomically persists the single-patient demo aggregate in SQLite.

    The aggregate matches the browser's bootstrap contract. A separate append-only revision
    table records mutations without duplicating sensitive media payloads in every history row.
    """

    def __init__(self, path: str | Path, encryption_key: str | bytes | None = None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fernet = Fernet(self._resolve_encryption_key(encryption_key))
        self.initialize()

    def _resolve_encryption_key(self, configured: str | bytes | None) -> bytes:
        """Resolve a stable Fernet key without checking secrets into source control.

        Deployments should set ``EMED_DATA_ENCRYPTION_KEY``. Local development and isolated
        tests get a mode-0600 sidecar next to their database so a restart can still decrypt the
        aggregate. Losing that key intentionally makes the health record unreadable.
        """

        value = configured or os.getenv("EMED_DATA_ENCRYPTION_KEY")
        if value:
            return value.encode() if isinstance(value, str) else value

        key_path = self.path.with_name(f"{self.path.name}.key")
        try:
            key = key_path.read_bytes().strip()
            key_path.chmod(0o600)
            return key
        except FileNotFoundError:
            generated = Fernet.generate_key()
            try:
                descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                # Another worker won the first-start race.
                key = key_path.read_bytes().strip()
                key_path.chmod(0o600)
                return key
            with os.fdopen(descriptor, "wb") as key_file:
                key_file.write(generated)
            return generated

    def _tighten_file_permissions(self) -> None:
        for artifact in (
            self.path,
            Path(f"{self.path}-wal"),
            Path(f"{self.path}-shm"),
        ):
            if artifact.exists():
                artifact.chmod(0o600)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        # Tighten the main database before SQLite derives WAL/SHM modes from it, and repair
        # permissions on artifacts left by an older build before reading health data.
        self._tighten_file_permissions()
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("PRAGMA foreign_keys = ON")
        # Deleted health-record payloads must be overwritten in SQLite b-tree pages rather
        # than left recoverable in freelist space. This is connection-local, so enable it on
        # every handle before any mutation.
        connection.execute("PRAGMA secure_delete = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        self._tighten_file_permissions()
        return connection

    @staticmethod
    def _checkpoint_truncate(connection: sqlite3.Connection) -> None:
        result = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if result is not None and int(result[0]) != 0:
            raise RuntimeError("SQLite could not securely truncate the demo WAL.")

    def _secure_compact(self) -> None:
        """Remove deleted payload bytes from the database and WAL artifacts.

        ``secure_delete`` overwrites deleted cells, the first checkpoint applies and truncates
        those WAL frames, ``VACUUM`` rebuilds the main file without free pages, and the final
        checkpoint removes WAL frames produced by the rebuild itself.
        """

        with self._connect() as connection:
            self._checkpoint_truncate(connection)
            connection.execute("VACUUM")
            self._checkpoint_truncate(connection)

    def purge_deleted_payload_bytes(self) -> None:
        """Physically remove sensitive payload remnants after selective retention cleanup."""

        self._secure_compact()

    def initialize(self) -> None:
        migrated_plaintext = False
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS demo_snapshots (
                    patient_id TEXT PRIMARY KEY,
                    version INTEGER NOT NULL CHECK (version >= 1),
                    state_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS domain_revisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id TEXT NOT NULL,
                    state_version INTEGER NOT NULL,
                    action TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE INDEX IF NOT EXISTS idx_domain_revisions_patient
                    ON domain_revisions(patient_id, id DESC);
                """
            )
            existing = connection.execute(
                "SELECT 1 FROM demo_snapshots WHERE patient_id = 'amara'"
            ).fetchone()
            if existing is None:
                self._insert_state(connection, build_demo_state(), "Seeded Amara demo record")
            else:
                # Transparently upgrade pre-encryption development databases. The same row and
                # revision are retained; only its storage representation changes.
                row = connection.execute(
                    "SELECT state_json FROM demo_snapshots WHERE patient_id = 'amara'"
                ).fetchone()
                if row is not None and not str(row["state_json"]).startswith("enc:v1:"):
                    state = self._deserialize(str(row["state_json"]))
                    connection.execute(
                        "UPDATE demo_snapshots SET state_json = ? WHERE patient_id = 'amara'",
                        (self._serialize(state),),
                    )
                    migrated_plaintext = True
            revision_rows = connection.execute(
                "SELECT id, action, actor, metadata_json FROM domain_revisions"
            ).fetchall()
            for revision_row in revision_rows:
                values = tuple(
                    str(revision_row[field]) for field in ("action", "actor", "metadata_json")
                )
                if all(value.startswith("enc:v1:") for value in values):
                    continue
                connection.execute(
                    """
                    UPDATE domain_revisions
                    SET action = ?, actor = ?, metadata_json = ?
                    WHERE id = ?
                    """,
                    (*[self._encrypt_text(value) for value in values], revision_row["id"]),
                )
                migrated_plaintext = True
        if migrated_plaintext:
            # Legacy cleartext aggregate or audit fields may have occupied different SQLite
            # pages. Compact and truncate the WAL so migration leaves no recoverable remnants.
            self._secure_compact()

    def _encrypt_text(self, value: str) -> str:
        if value.startswith("enc:v1:"):
            return value
        return f"enc:v1:{self._fernet.encrypt(value.encode()).decode()}"

    def _decrypt_text(self, payload: str, description: str) -> str:
        if not payload.startswith("enc:v1:"):
            return payload
        try:
            return self._fernet.decrypt(payload.removeprefix("enc:v1:").encode()).decode()
        except InvalidToken as error:
            raise RuntimeError(
                f"The encrypted {description} could not be decrypted with the configured key."
            ) from error

    def _serialize(self, state: DemoState) -> str:
        plaintext = json.dumps(
            state.model_dump(mode="json", by_alias=True),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return self._encrypt_text(plaintext)

    def _deserialize(self, payload: str) -> DemoState:
        return DemoState.model_validate_json(self._decrypt_text(payload, "demo health record"))

    def _insert_state(
        self,
        connection: sqlite3.Connection,
        state: DemoState,
        action: str,
        *,
        actor: str = "system",
    ) -> None:
        now = utc_now()
        revision = 1
        connection.execute(
            """
            INSERT INTO demo_snapshots(patient_id, version, state_json, created_at, updated_at)
            VALUES ('amara', ?, ?, ?, ?)
            """,
            (revision, self._serialize(state), now, now),
        )
        connection.execute(
            """
            INSERT INTO domain_revisions(
                patient_id, state_version, action, actor, occurred_at, metadata_json
            ) VALUES ('amara', ?, ?, ?, ?, ?)
            """,
            (
                revision,
                self._encrypt_text(action),
                self._encrypt_text(actor),
                now,
                self._encrypt_text("{}"),
            ),
        )

    def get(self) -> DemoState:
        return self.get_with_revision()[0]

    def get_with_revision(self) -> tuple[DemoState, int]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT version, state_json FROM demo_snapshots WHERE patient_id = 'amara'"
            ).fetchone()
        if row is None:
            # A deleted/corrupt fixture is restored only through explicit reset, never silently.
            raise RuntimeError("The Amara demo snapshot is unavailable. Call /api/demo/reset.")
        return self._deserialize(row["state_json"]), int(row["version"])

    def revision(self) -> int:
        return self.get_with_revision()[1]

    def mutate(
        self,
        mutator: Callable[[dict[str, Any]], T],
        action: str,
        *,
        actor: str = "patient",
        expected_version: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> tuple[DemoState, T]:
        state, result, _ = self._mutate(
            mutator,
            action,
            actor=actor,
            expected_version=expected_version,
            metadata=metadata,
        )
        return state, result

    def mutate_with_revision(
        self,
        mutator: Callable[[dict[str, Any]], T],
        action: str,
        *,
        actor: str = "patient",
        expected_version: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> tuple[DemoState, T, int]:
        return self._mutate(
            mutator,
            action,
            actor=actor,
            expected_version=expected_version,
            metadata=metadata,
        )

    def _mutate(
        self,
        mutator: Callable[[dict[str, Any]], T],
        action: str,
        *,
        actor: str,
        expected_version: int | None,
        metadata: dict[str, Any] | None,
    ) -> tuple[DemoState, T, int]:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT version, state_json FROM demo_snapshots WHERE patient_id = 'amara'"
            ).fetchone()
            if row is None:
                raise RuntimeError("The Amara demo snapshot is unavailable. Call /api/demo/reset.")
            current_version = int(row["version"])
            if expected_version is not None and expected_version != current_version:
                raise VersionConflictError(
                    f"Expected revision {expected_version}, but the current revision is "
                    f"{current_version}."
                )

            state = self._deserialize(row["state_json"]).model_dump(mode="json", by_alias=True)
            result = mutator(state)
            next_version = current_version + 1
            audits = state.setdefault("audit", [])
            audit_id = max((int(item["id"]) for item in audits), default=0) + 1
            now = utc_now()
            audits.insert(0, {"id": audit_id, "at": now, "action": action})
            validated = DemoState.model_validate(state)

            cursor = connection.execute(
                """
                UPDATE demo_snapshots
                SET version = ?, state_json = ?, updated_at = ?
                WHERE patient_id = 'amara' AND version = ?
                """,
                (next_version, self._serialize(validated), now, current_version),
            )
            if cursor.rowcount != 1:
                raise VersionConflictError("The demo state changed during this request.")
            connection.execute(
                """
                INSERT INTO domain_revisions(
                    patient_id, state_version, action, actor, occurred_at, metadata_json
                ) VALUES ('amara', ?, ?, ?, ?, ?)
                """,
                (
                    next_version,
                    self._encrypt_text(action),
                    self._encrypt_text(actor),
                    now,
                    self._encrypt_text(
                        json.dumps(metadata or {}, ensure_ascii=False, separators=(",", ":"))
                    ),
                ),
            )
            connection.commit()
        return validated, result, next_version

    def replace(
        self,
        state: DemoState,
        action: str,
        *,
        actor: str = "system",
        clear_history: bool = False,
    ) -> DemoState:
        state, _ = self._replace(
            state,
            action,
            actor=actor,
            clear_history=clear_history,
        )
        return state

    def _replace(
        self,
        state: DemoState,
        action: str,
        *,
        actor: str,
        clear_history: bool,
    ) -> tuple[DemoState, int]:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = utc_now()
            current = connection.execute(
                "SELECT version FROM demo_snapshots WHERE patient_id = 'amara'"
            ).fetchone()
            revision = int(current["version"]) + 1 if current is not None else 1
            if clear_history:
                connection.execute("DELETE FROM domain_revisions WHERE patient_id = 'amara'")
                connection.execute("DELETE FROM sqlite_sequence WHERE name = 'domain_revisions'")
            connection.execute("DELETE FROM demo_snapshots WHERE patient_id = 'amara'")
            connection.execute(
                """
                INSERT INTO demo_snapshots(patient_id, version, state_json, created_at, updated_at)
                VALUES ('amara', ?, ?, ?, ?)
                """,
                (revision, self._serialize(state), now, now),
            )
            connection.execute(
                """
            INSERT INTO domain_revisions(
                patient_id, state_version, action, actor, occurred_at, metadata_json
            ) VALUES ('amara', ?, ?, ?, ?, ?)
            """,
                (
                    revision,
                    self._encrypt_text(action),
                    self._encrypt_text(actor),
                    now,
                    self._encrypt_text("{}"),
                ),
            )
            connection.commit()
        if clear_history:
            self._secure_compact()
        return state, revision

    def reset(self) -> DemoState:
        return self.replace(
            build_demo_state(),
            "Reset Amara demo record",
            clear_history=True,
        )

    def reset_with_revision(self) -> tuple[DemoState, int]:
        return self._replace(
            build_demo_state(),
            "Reset Amara demo record",
            actor="system",
            clear_history=True,
        )

    def clear_patient_data(self) -> DemoState:
        return self.replace(
            build_empty_state(),
            "Deleted all patient data",
            actor="patient",
            clear_history=True,
        )

    def revisions(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, state_version, action, actor, occurred_at, metadata_json
                FROM domain_revisions
                WHERE patient_id = 'amara'
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "stateVersion": row["state_version"],
                "action": self._decrypt_text(str(row["action"]), "revision action"),
                "actor": self._decrypt_text(str(row["actor"]), "revision actor"),
                "occurredAt": row["occurred_at"],
                "metadata": json.loads(
                    self._decrypt_text(str(row["metadata_json"]), "revision metadata")
                ),
            }
            for row in rows
        ]


def _default_db_path() -> Path:
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    configured = os.getenv("EMED_DB_PATH")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[2] / "data" / "emed-demo.sqlite3"


@lru_cache(maxsize=1)
def get_demo_store() -> SQLiteDemoStore:
    return SQLiteDemoStore(_default_db_path())
