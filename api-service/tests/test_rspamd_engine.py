from pathlib import Path

from app.eml_parser import parse_eml
from app.rspamd_engine import RspamdEngine


ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "samples" / "phishing_with_attachment.eml"


class FakeRspamdResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {
            "is_skipped": False,
            "score": 10.4,
            "required_score": 15.0,
            "action": "add header",
            "symbols": {
                "LOW": {"name": "LOW", "score": 1.0},
                "HIGH": {"name": "HIGH", "score": 4.0, "options": ["example"]},
            },
            "urls": ["https://example.test/login"],
            "emails": ["security@example.test"],
        }


def test_rspamd_checkv2_request_and_normalization(monkeypatch) -> None:
    raw_eml = SAMPLE.read_bytes()
    parsed = parse_eml(raw_eml, attachment_scan_limit=1024 * 1024)
    captured: dict = {}

    def fake_post(url: str, data: bytes, headers: dict, timeout: float) -> FakeRspamdResponse:
        captured.update({"url": url, "data": data, "headers": headers, "timeout": timeout})
        return FakeRspamdResponse()

    monkeypatch.setattr("app.rspamd_engine.requests.post", fake_post)
    result = RspamdEngine(
        "http://rspamd.test:11333/",
        timeout_seconds=7.5,
        request_flags="pass_all,groups,no_log",
    ).analyze(raw_eml, parsed)

    assert captured["url"] == "http://rspamd.test:11333/checkv2"
    assert captured["data"] == raw_eml
    assert captured["headers"]["Content-Type"] == "message/rfc822"
    assert captured["headers"]["Flags"] == "pass_all,groups,no_log"
    assert captured["headers"]["From"] == "attacker@evil.example"
    assert captured["headers"]["Rcpt"] == "employee@example.org"
    assert captured["timeout"] == 7.5
    assert result["status"] == "completed"
    assert result["score"] == 10.4
    assert result["required_score"] == 15.0
    assert result["action"] == "add header"
    assert [item["name"] for item in result["symbols"]] == ["HIGH", "LOW"]
    assert result["symbols"][0]["options"] == ["example"]
