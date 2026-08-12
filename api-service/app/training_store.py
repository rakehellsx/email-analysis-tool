"""SQLite 存储机器学习训练任务，使 Web 客户端可异步查询训练状态。"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TrainingTaskStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.initialize()

    def _connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def initialize(self) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS model_training_tasks (
                    task_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    dataset_path TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    error_message TEXT,
                    result_json TEXT
                )
                """
            )

    def create(self, task_id: str, filename: str, dataset_path: Path, size_bytes: int) -> None:
        with self._connection() as connection:
            connection.execute(
                """INSERT INTO model_training_tasks
                   (task_id, status, original_filename, dataset_path, size_bytes, created_at)
                   VALUES (?, 'queued', ?, ?, ?, ?)""",
                (task_id, filename, str(dataset_path), size_bytes, _utc_now()),
            )

    def mark_running(self, task_id: str) -> None:
        with self._connection() as connection:
            connection.execute(
                "UPDATE model_training_tasks SET status='running', started_at=? WHERE task_id=?",
                (_utc_now(), task_id),
            )

    def complete(self, task_id: str, result: dict[str, Any]) -> None:
        with self._connection() as connection:
            connection.execute(
                """UPDATE model_training_tasks
                   SET status='completed', completed_at=?, result_json=?, error_message=NULL
                   WHERE task_id=?""",
                (_utc_now(), json.dumps(result, ensure_ascii=False), task_id),
            )

    def fail(self, task_id: str, error_message: str) -> None:
        with self._connection() as connection:
            connection.execute(
                """UPDATE model_training_tasks
                   SET status='failed', completed_at=?, error_message=? WHERE task_id=?""",
                (_utc_now(), error_message[:1000], task_id),
            )

    def get(self, task_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM model_training_tasks WHERE task_id=?", (task_id,)).fetchone()
        if row is None:
            return None
        task = dict(row)
        result_json = task.pop("result_json")
        task.pop("dataset_path", None)
        task["result"] = json.loads(result_json) if result_json else None
        return task

    def get_dataset_path(self, task_id: str) -> Path | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT dataset_path FROM model_training_tasks WHERE task_id=?", (task_id,)
            ).fetchone()
        return Path(row["dataset_path"]) if row else None
