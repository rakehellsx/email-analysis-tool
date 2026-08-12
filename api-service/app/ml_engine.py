"""本地机器学习检测引擎；模型由受信任的离线训练流程生成。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import joblib


class LocalMlEngine:
    """加载 sklearn Pipeline 并输出垃圾邮件概率，而不将数据发送到第三方。"""

    engine_name = "tfidf_logistic_regression"

    def __init__(self, model_path: Path) -> None:
        self.model_path = model_path
        self._model: Any | None = None
        self._load_error: str | None = None
        self._load()

    def _load(self) -> None:
        if not self.model_path.exists():
            self._load_error = f"模型文件不存在: {self.model_path}"
            return
        try:
            # joblib/pickle 仅能加载本服务离线训练且受信任的模型工件。
            self._model = joblib.load(self.model_path)
        except Exception as exc:  # pragma: no cover - 仅错误路径
            self._load_error = f"模型加载失败: {type(exc).__name__}: {exc}"

    @staticmethod
    def _document(parsed: dict[str, Any]) -> str:
        message = parsed["message"]
        parts = [
            f"subject: {message['subject']}",
            f"from_domain: {parsed['sender_context']['from_domain']}",
            f"reply_to_domain: {parsed['sender_context']['reply_to_domain']}",
            f"text: {message['body']['text']}",
            f"html: {message['body']['html']}",
            f"urls: {' '.join(message['urls']['hosts'])}",
            f"attachments: {' '.join(item['filename'] for item in message['attachments'])}",
        ]
        return "\n".join(parts)[:300_000]

    def analyze(self, parsed: dict[str, Any]) -> dict[str, Any]:
        if self._model is None:
            return {
                "engine": self.engine_name,
                "status": "unavailable",
                "reason": self._load_error,
                "spam_probability": None,
                "label": None,
            }
        try:
            document = self._document(parsed)
            probabilities = self._model.predict_proba([document])[0]
            classes = list(self._model.classes_)
            spam_index = classes.index("spam") if "spam" in classes else 1
            probability = float(probabilities[spam_index])
            return {
                "engine": self.engine_name,
                "status": "completed",
                "model_path": str(self.model_path),
                "spam_probability": round(probability, 4),
                "label": "spam" if probability >= 0.5 else "ham",
                "confidence": round(max(float(item) for item in probabilities), 4),
            }
        except Exception as exc:  # pragma: no cover - 依赖模型工件
            return {
                "engine": self.engine_name,
                "status": "error",
                "reason": f"推理失败: {type(exc).__name__}: {exc}",
                "spam_probability": None,
                "label": None,
            }
