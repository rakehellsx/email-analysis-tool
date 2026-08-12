"""应用配置：所有可变路径与可选外部引擎均从环境变量读取。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    """运行时设置。默认值适用于本地开发，生产环境应显式覆写。"""

    project_root: Path = PROJECT_ROOT
    database_path: Path = Path(os.getenv("MAIL_ANALYZER_DATABASE", PROJECT_ROOT / "data" / "mail_analyzer.db"))
    job_dir: Path = Path(os.getenv("MAIL_ANALYZER_JOB_DIR", PROJECT_ROOT / "data" / "jobs"))
    rules_path: Path = Path(os.getenv("MAIL_ANALYZER_RULES", PROJECT_ROOT / "config" / "detection_rules.yaml"))
    model_path: Path = Path(os.getenv("MAIL_ANALYZER_MODEL", PROJECT_ROOT / "models" / "baseline_model.joblib"))
    max_upload_bytes: int = int(os.getenv("MAIL_ANALYZER_MAX_UPLOAD_BYTES", 15 * 1024 * 1024))
    max_training_upload_bytes: int = int(os.getenv("MAIL_ANALYZER_MAX_TRAINING_UPLOAD_BYTES", 10 * 1024 * 1024))
    min_training_samples: int = int(os.getenv("MAIL_ANALYZER_MIN_TRAINING_SAMPLES", "10"))
    max_attachment_scan_bytes: int = int(os.getenv("MAIL_ANALYZER_MAX_ATTACHMENT_SCAN_BYTES", 2 * 1024 * 1024))
    cors_origins: tuple[str, ...] = tuple(
        item.strip() for item in os.getenv("MAIL_ANALYZER_CORS_ORIGINS", "*").split(",") if item.strip()
    )
    rspamd_url: str | None = os.getenv("RSPAMD_URL")
    rspamd_timeout_seconds: float = float(os.getenv("RSPAMD_TIMEOUT_SECONDS", "10"))

    def ensure_directories(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.job_dir.mkdir(parents=True, exist_ok=True)
        self.model_path.parent.mkdir(parents=True, exist_ok=True)


settings = Settings()
