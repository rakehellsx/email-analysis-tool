"""SQLite 任务存储。每次操作均创建短连接，适合 FastAPI 后台线程调用。"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TaskStore:
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
                CREATE TABLE IF NOT EXISTS analysis_tasks (
                    task_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    eml_path TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    error_message TEXT,
                    result_json TEXT
                )
                """
            )

    def create(self, task_id: str, filename: str, eml_path: Path, size_bytes: int) -> None:
        with self._connection() as connection:
            connection.execute(
                """INSERT INTO analysis_tasks
                   (task_id, status, original_filename, eml_path, size_bytes, created_at)
                   VALUES (?, 'queued', ?, ?, ?, ?)""",
                (task_id, filename, str(eml_path), size_bytes, _utc_now()),
            )

    def mark_running(self, task_id: str) -> None:
        with self._connection() as connection:
            connection.execute(
                "UPDATE analysis_tasks SET status='running', started_at=? WHERE task_id=?",
                (_utc_now(), task_id),
            )

    def complete(self, task_id: str, result: dict[str, Any]) -> None:
        with self._connection() as connection:
            connection.execute(
                """UPDATE analysis_tasks
                   SET status='completed', completed_at=?, result_json=?, error_message=NULL
                   WHERE task_id=?""",
                (_utc_now(), json.dumps(result, ensure_ascii=False), task_id),
            )

    def fail(self, task_id: str, error_message: str) -> None:
        with self._connection() as connection:
            connection.execute(
                """UPDATE analysis_tasks
                   SET status='failed', completed_at=?, error_message=? WHERE task_id=?""",
                (_utc_now(), error_message[:1000], task_id),
            )

    def get(self, task_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM analysis_tasks WHERE task_id=?", (task_id,)).fetchone()
        if row is None:
            return None
        task = dict(row)
        result_json = task.pop("result_json")
        task.pop("eml_path", None)  # 原始邮件在本地留存，但永不由状态接口公开路径。
        task["result"] = json.loads(result_json) if result_json else None
        return task

    def get_eml_path(self, task_id: str) -> Path | None:
        with self._connection() as connection:
            row = connection.execute("SELECT eml_path FROM analysis_tasks WHERE task_id=?", (task_id,)).fetchone()
        return Path(row["eml_path"]) if row else None
