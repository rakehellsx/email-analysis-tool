"""EML 解析模块：仅解析与提取，不执行附件、脚本或邮件内 URL。"""

from __future__ import annotations

import hashlib
import re
from datetime import timezone
from email import policy
from email.header import decode_header, make_header
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime, parseaddr
from pathlib import PurePath
from typing import Any
from urllib.parse import urlsplit

_URL_RE = re.compile(r"(?i)\bhttps?://[^\s<>\"']+")
_DISPLAY_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)


def _decode_header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _decode_payload(part: Any) -> str:
    raw = part.get_payload(decode=True)
    if raw is None:
        payload = part.get_payload()
        return payload if isinstance(payload, str) else ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return raw.decode(charset, errors="replace")
    except (LookupError, UnicodeError):
        return raw.decode("utf-8", errors="replace")


def _addresses(value: str | None) -> list[dict[str, str]]:
    addresses = []
    for name, address in getaddresses([value or ""]):
        if name or address:
            addresses.append({"name": _decode_header(name), "email": address.lower()})
    return addresses


def _first_email(value: str | None) -> str:
    return parseaddr(value or "")[1].lower()


def _domain(address: str) -> str:
    return address.rsplit("@", 1)[1].lower() if "@" in address else ""


def _clean_url(url: str) -> str:
    return url.rstrip(".,;:!?)]}\"'")


def _extract_urls(*texts: str) -> dict[str, list[str]]:
    raw_urls: list[str] = []
    for text in texts:
        raw_urls.extend(_clean_url(match.group(0)) for match in _URL_RE.finditer(text or ""))
    unique_urls = list(dict.fromkeys(url for url in raw_urls if url))
    hosts: list[str] = []
    for url in unique_urls:
        try:
            host = (urlsplit(url).hostname or "").lower()
        except ValueError:
            host = ""
        if host:
            hosts.append(host)
    return {"raw": unique_urls, "hosts": list(dict.fromkeys(hosts))}


def _attachment_content_text(payload: bytes, limit: int) -> str:
    """只将小附件作为可读文本扫描，避免大二进制内容造成资源消耗。"""
    if not payload or len(payload) > limit:
        return ""
    try:
        return payload.decode("utf-8", errors="ignore")
    except UnicodeError:
        return ""


def parse_eml(raw_eml: bytes, attachment_scan_limit: int) -> dict[str, Any]:
    """返回 JSON 友好的邮件结构；格式异常会交由调用方转换为任务失败。"""
    message = BytesParser(policy=policy.default).parsebytes(raw_eml)
    from_header = _decode_header(message.get("From"))
    from_name, from_email = parseaddr(from_header)
    reply_to_header = _decode_header(message.get("Reply-To"))
    reply_to_email = _first_email(reply_to_header)

    text_parts: list[str] = []
    html_parts: list[str] = []
    attachments: list[dict[str, Any]] = []

    for part in message.walk():
        if part.is_multipart():
            continue
        content_disposition = (part.get_content_disposition() or "").lower()
        filename = _decode_header(part.get_filename())
        content_type = part.get_content_type()
        payload = part.get_payload(decode=True) or b""
        is_attachment = content_disposition == "attachment" or bool(filename)

        if is_attachment:
            safe_filename = PurePath(filename or "unnamed_attachment").name
            suffix = PurePath(safe_filename).suffix.lower()
            attachments.append(
                {
                    "filename": safe_filename,
                    "extension": suffix,
                    "content_type": content_type,
                    "content_disposition": content_disposition or "attachment",
                    "size_bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "content_text": _attachment_content_text(payload, attachment_scan_limit),
                }
            )
        elif content_type == "text/plain":
            text_parts.append(_decode_payload(part))
        elif content_type == "text/html":
            html_parts.append(_decode_payload(part))

    date_value = None
    date_parse_error = None
    if message.get("Date"):
        try:
            parsed = parsedate_to_datetime(message.get("Date"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            date_value = parsed.isoformat()
        except (TypeError, ValueError, IndexError) as exc:
            date_parse_error = str(exc)

    display_emails = [item.lower() for item in _DISPLAY_EMAIL_RE.findall(from_name or "")]
    display_mismatch = bool(display_emails and from_email.lower() not in display_emails)
    urls = _extract_urls("\n".join(text_parts), "\n".join(html_parts))

    headers = {
        _decode_header(key): _decode_header(value)
        for key, value in message.items()
        if key.lower() not in {"received", "dkim-signature"}
    }
    return {
        "message": {
            "from": {"name": _decode_header(from_name), "email": from_email.lower()},
            "to": _addresses(message.get("To")),
            "cc": _addresses(message.get("Cc")),
            "reply_to": _addresses(reply_to_header),
            "subject": _decode_header(message.get("Subject")),
            "date": date_value,
            "date_parse_error": date_parse_error,
            "message_id": _decode_header(message.get("Message-ID")),
            "headers": headers,
            "body": {"text": "\n".join(text_parts), "html": "\n".join(html_parts)},
            "urls": urls,
            "attachments": attachments,
            "raw_size_bytes": len(raw_eml),
        },
        "sender_context": {
            "from_domain": _domain(from_email),
            "reply_to_domain": _domain(reply_to_email),
            "reply_to_domain_mismatch": bool(reply_to_email and _domain(from_email) and _domain(from_email) != _domain(reply_to_email)),
            "display_name_email_mismatch": display_mismatch,
        },
    }
