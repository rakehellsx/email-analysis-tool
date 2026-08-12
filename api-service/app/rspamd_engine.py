"""Rspamd HTTP `/checkv2` 集成；未配置时显式禁用且不会阻断本地分析。"""

from __future__ import annotations

from typing import Any

import requests


class RspamdEngine:
    engine_name = "rspamd"

    def __init__(self, base_url: str | None, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/") if base_url else None
        self.timeout_seconds = timeout_seconds

    def analyze(self, raw_eml: bytes, parsed: dict[str, Any]) -> dict[str, Any]:
        if not self.base_url:
            return {
                "engine": self.engine_name,
                "status": "disabled",
                "reason": "未配置 RSPAMD_URL",
            }
        sender = parsed["message"]["from"]["email"]
        recipients = [entry["email"] for entry in parsed["message"]["to"] if entry.get("email")]
        headers = {
            "Content-Type": "message/rfc822",
            "Flags": "pass_all,groups,ext_urls,no_log",
            "From": sender,
            "User-Agent": "mail-analyzer/1.0",
        }
        if recipients:
            headers["Rcpt"] = recipients[0]
        try:
            response = requests.post(
                f"{self.base_url}/checkv2",
                data=raw_eml,
                headers=headers,
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except requests.Timeout:
            return {
                "engine": self.engine_name,
                "status": "timeout",
                "reason": f"Rspamd 在 {self.timeout_seconds} 秒内未返回",
            }
        except (requests.RequestException, ValueError) as exc:
            return {
                "engine": self.engine_name,
                "status": "error",
                "reason": f"Rspamd 调用失败: {type(exc).__name__}: {exc}",
            }

        symbols = payload.get("symbols", {})
        normalized_symbols = []
        for name, item in symbols.items():
            if not isinstance(item, dict):
                continue
            normalized_symbols.append(
                {
                    "name": item.get("name", name),
                    "score": item.get("score", 0),
                    "options": item.get("options", []),
                }
            )
        normalized_symbols.sort(key=lambda item: abs(float(item["score"] or 0)), reverse=True)
        return {
            "engine": self.engine_name,
            "status": "completed",
            "score": payload.get("score"),
            "required_score": payload.get("required_score"),
            "action": payload.get("action"),
            "is_skipped": payload.get("is_skipped", False),
            "symbols": normalized_symbols,
            "urls": payload.get("urls", []),
            "emails": payload.get("emails", []),
        }
