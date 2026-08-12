from pathlib import Path

from fastapi.testclient import TestClient

from app.analyzer import EmailAnalyzer
from app.config import Settings
from app.main import app

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "samples" / "phishing_with_attachment.eml"


def test_analyzer_detects_malicious_attachment() -> None:
    settings = Settings(
        database_path=ROOT / "data" / "test_mail_analyzer.db",
        job_dir=ROOT / "data" / "test_jobs",
        rules_path=ROOT / "config" / "detection_rules.yaml",
        model_path=ROOT / "models" / "baseline_model.joblib",
    )
    result = EmailAnalyzer(settings).analyze(SAMPLE.read_bytes())
    email = result["email"]
    verdict = result["analysis"]["verdict"]
    rule_ids = {match["rule_id"] for match in result["analysis"]["rules"]["matches"]}

    assert email["from"]["email"] == "attacker@evil.example"
    assert email["cc"][0]["email"] == "security@example.org"
    assert email["attachments"][0]["filename"] == "invoice.pdf.exe"
    assert verdict["nature"] == "MALICIOUS_ATTACHMENT"
    assert verdict["recommended_action"] == "quarantine"
    assert {"ATTACHMENT_EXECUTABLE", "ATTACHMENT_DOUBLE_EXTENSION", "PHISHING_SHORTENER_URL"} <= rule_ids


def test_upload_and_query_task() -> None:
    client = TestClient(app)
    with SAMPLE.open("rb") as handle:
        response = client.post(
            "/api/v1/emails",
            files={"file": ("sample.eml", handle, "message/rfc822")},
        )
    assert response.status_code == 202
    task_id = response.json()["task_id"]

    result = client.get(f"/api/v1/tasks/{task_id}")
    assert result.status_code == 200
    payload = result.json()
    assert payload["status"] == "completed"
    assert payload["result"]["analysis"]["verdict"]["nature"] == "MALICIOUS_ATTACHMENT"


def test_rejects_non_eml_upload() -> None:
    client = TestClient(app)
    response = client.post("/api/v1/emails", files={"file": ("note.txt", b"hello", "text/plain")})
    assert response.status_code == 415


def test_submit_and_query_training_task() -> None:
    dataset = "\n".join(
        [
            '{"label":"ham","text":"internal project status meeting minutes"}',
            '{"label":"ham","text":"approved invoice available in vendor portal"}',
            '{"label":"ham","text":"weekly engineering deployment report"}',
            '{"label":"ham","text":"company holiday schedule update"}',
            '{"label":"ham","text":"please review the internal draft contract"}',
            '{"label":"spam","text":"urgent verify your password immediately"}',
            '{"label":"spam","text":"account suspended click login now"}',
            '{"label":"spam","text":"final warning confirm identity at short link"}',
            '{"label":"spam","text":"open attached invoice exe to release payment"}',
            '{"label":"spam","text":"enter credentials to restore mailbox quota"}',
        ]
    ).encode("utf-8")
    client = TestClient(app)
    response = client.post(
        "/api/v1/models/train",
        files={"dataset": ("training.jsonl", dataset, "application/x-ndjson")},
    )
    assert response.status_code == 202
    task_id = response.json()["task_id"]

    result = client.get(f"/api/v1/models/train/{task_id}")
    assert result.status_code == 200
    payload = result.json()
    assert payload["status"] == "completed"
    assert payload["result"]["samples"] == 10
    assert payload["result"]["class_counts"] == {"ham": 5, "spam": 5}
