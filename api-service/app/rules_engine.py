"""从独立 YAML 规则文件加载规则并对解析后的邮件执行匹配。"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml


class RuleConfigurationError(ValueError):
    """规则文件不符合预期时抛出，避免静默弱化检测能力。"""


class RulesEngine:
    def __init__(self, rules_path: Path) -> None:
        self.rules_path = rules_path
        self._config = self._load_rules()
        self.rules: list[dict[str, Any]] = self._config["rules"]
        self.settings: dict[str, Any] = self._config["settings"]

    def _load_rules(self) -> dict[str, Any]:
        if not self.rules_path.exists():
            raise RuleConfigurationError(f"规则文件不存在: {self.rules_path}")
        with self.rules_path.open("r", encoding="utf-8") as handle:
            config = yaml.safe_load(handle)
        if not isinstance(config, dict) or not isinstance(config.get("rules"), list):
            raise RuleConfigurationError("规则文件必须含有 rules 列表")
        if not isinstance(config.get("settings"), dict):
            raise RuleConfigurationError("规则文件必须含有 settings 对象")
        required = {"id", "category", "severity", "score", "target", "operator", "description"}
        for rule in config["rules"]:
            missing = required - set(rule or {})
            if missing:
                raise RuleConfigurationError(f"规则缺少字段: {', '.join(sorted(missing))}")
            if rule["operator"] == "regex":
                try:
                    re.compile(rule["pattern"])
                except (KeyError, re.error) as exc:
                    raise RuleConfigurationError(f"规则 {rule['id']} 的正则无效: {exc}") from exc
        return config

    @staticmethod
    def _target_values(target: str, parsed: dict[str, Any]) -> list[tuple[str, Any]]:
        message = parsed["message"]
        if target == "body.combined":
            body = message["body"]
            return [("body", f"{body['text']}\n{body['html']}")]
        if target == "body.html":
            return [("html_body", message["body"]["html"])]
        if target in {"urls.hosts", "urls.raw"}:
            key = target.rsplit(".", 1)[1]
            return [(f"url:{value}", value) for value in message["urls"][key]]
        if target.startswith("attachment."):
            key = target.rsplit(".", 1)[1]
            return [
                (f"attachment:{item['filename']}", item.get(key, ""))
                for item in message["attachments"]
            ]
        if target.startswith("sender."):
            key = target.rsplit(".", 1)[1]
            return [(target, parsed["sender_context"].get(key))]
        raise RuleConfigurationError(f"不支持的 rule target: {target}")

    @staticmethod
    def _matches(rule: dict[str, Any], value: Any) -> bool:
        operator = rule["operator"]
        if operator == "equals":
            return value == rule.get("value")
        if operator == "contains":
            return str(rule.get("value", "")).lower() in str(value).lower()
        if operator == "in":
            return str(value).lower() in {str(item).lower() for item in rule.get("values", [])}
        if operator == "regex":
            return bool(re.search(rule["pattern"], str(value)))
        raise RuleConfigurationError(f"不支持的 rule operator: {operator}")

    @staticmethod
    def _evidence(reference: str, value: Any) -> dict[str, str]:
        """只存储截断后的匹配证据，避免在结果中复制超长邮件正文。"""
        normalized = str(value).replace("\n", " ").strip()
        return {"location": reference, "matched_value": normalized[:300]}

    def evaluate(self, parsed: dict[str, Any]) -> dict[str, Any]:
        matches: list[dict[str, Any]] = []
        category_scores: dict[str, float] = defaultdict(float)
        for rule in self.rules:
            matching_values = [
                (reference, value)
                for reference, value in self._target_values(rule["target"], parsed)
                if self._matches(rule, value)
            ]
            if not matching_values:
                continue
            evidence = [self._evidence(reference, value) for reference, value in matching_values[:5]]
            rule_score = float(rule["score"])
            matches.append(
                {
                    "rule_id": rule["id"],
                    "name": rule.get("name", rule["id"]),
                    "category": rule["category"],
                    "severity": rule["severity"],
                    "score": rule_score,
                    "description": rule["description"],
                    "evidence": evidence,
                }
            )
            category_scores[rule["category"]] += rule_score
        return {
            "engine": "yaml_rules",
            "rules_file": str(self.rules_path),
            "rule_version": self._config.get("version"),
            "score": round(sum(item["score"] for item in matches), 2),
            "category_scores": dict(category_scores),
            "matches": matches,
        }
