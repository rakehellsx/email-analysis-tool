"""邮件安全分析编排器。"""

from __future__ import annotations

from typing import Any

from .config import Settings
from .eml_parser import parse_eml
from .ml_engine import LocalMlEngine
from .rspamd_engine import RspamdEngine
from .rules_engine import RulesEngine


class EmailAnalyzer:
    def __init__(self, app_settings: Settings) -> None:
        self.settings = app_settings
        self.rules = RulesEngine(app_settings.rules_path)
        self.local_ml = LocalMlEngine(app_settings.model_path)
        self.rspamd = RspamdEngine(app_settings.rspamd_url, app_settings.rspamd_timeout_seconds)

    @staticmethod
    def _risk_level(score: float, malicious_attachment: bool) -> str:
        if malicious_attachment or score >= 15:
            return "critical"
        if score >= 8:
            return "high"
        if score >= 5:
            return "medium"
        if score >= 2:
            return "low"
        return "safe"

    def _verdict(self, rules: dict[str, Any], ml: dict[str, Any], rspamd: dict[str, Any]) -> dict[str, Any]:
        scores = rules["category_scores"]
        malicious_attachment = scores.get("malicious_attachment", 0) > 0
        phishing_score = scores.get("phishing", 0)
        abnormal_sender = scores.get("abnormal_sender", 0) > 0
        ml_probability = ml.get("spam_probability") if ml.get("status") == "completed" else None
        ml_score = round(float(ml_probability) * 5, 2) if ml_probability is not None else 0.0

        rspamd_score = 0.0
        if rspamd.get("status") == "completed":
            score = rspamd.get("score")
            required = rspamd.get("required_score")
            if isinstance(score, (int, float)) and isinstance(required, (int, float)) and required > 0:
                rspamd_score = round(max(0.0, min(5.0, score / required * 5.0)), 2)

        total = round(float(rules["score"]) + ml_score + rspamd_score, 2)
        tags: list[str] = []
        if malicious_attachment:
            tags.append("malicious_attachment")
        if phishing_score >= 5 or (phishing_score > 0 and (ml_probability or 0) >= 0.7):
            tags.append("phishing")
        if abnormal_sender:
            tags.append("abnormal_sender")
        if rules["category_scores"].get("suspicious_attachment", 0) > 0:
            tags.append("suspicious_attachment")
        if rules["category_scores"].get("suspicious_content", 0) > 0:
            tags.append("suspicious_content")
        if not tags and total >= float(self.rules.settings["suspicious_threshold"]):
            tags.append("suspicious")

        if malicious_attachment:
            nature = "MALICIOUS_ATTACHMENT"
        elif "phishing" in tags:
            nature = "PHISHING"
        elif abnormal_sender and total < float(self.rules.settings["phishing_threshold"]):
            nature = "ABNORMAL_SENDER"
        elif total < float(self.rules.settings["safe_threshold"]):
            nature = "SAFE"
        else:
            nature = "SUSPICIOUS"

        action = "allow"
        if nature in {"MALICIOUS_ATTACHMENT", "PHISHING"}:
            action = "quarantine"
        elif nature != "SAFE":
            action = "review"
        return {
            "nature": nature,
            "risk_level": self._risk_level(total, malicious_attachment),
            "risk_score": total,
            "tags": tags,
            "recommended_action": action,
            "requires_human_review": nature != "SAFE",
            "score_breakdown": {
                "yaml_rules": rules["score"],
                "local_ml": ml_score,
                "rspamd_normalized": rspamd_score,
            },
            "notice": "自动化结果用于安全辅助研判；请结合业务上下文、邮件链路和组织策略进行人工复核。",
        }

    def analyze(self, raw_eml: bytes) -> dict[str, Any]:
        parsed = parse_eml(raw_eml, self.settings.max_attachment_scan_bytes)
        rule_result = self.rules.evaluate(parsed)
        ml_result = self.local_ml.analyze(parsed)
        rspamd_result = self.rspamd.analyze(raw_eml, parsed)
        verdict = self._verdict(rule_result, ml_result, rspamd_result)
        return {
            "email": parsed["message"],
            "analysis": {
                "rules": rule_result,
                "machine_learning": ml_result,
                "external_engines": [rspamd_result],
                "verdict": verdict,
            },
        }
