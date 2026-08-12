"""受限的本地训练流程；只处理已脱敏的 ham/spam JSONL 样本。"""

from __future__ import annotations

import json
import os
import uuid
from collections import Counter
from pathlib import Path
from threading import Lock

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline


class TrainingDataError(ValueError):
    """训练文件格式、样本数量或类别分布不满足最低要求。"""


_training_lock = Lock()


def _load_jsonl(dataset_path: Path, min_samples: int) -> tuple[list[str], list[str], dict[str, int]]:
    labels: list[str] = []
    texts: list[str] = []
    with dataset_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            if len(line) > 100_000:
                raise TrainingDataError(f"第 {line_number} 行超过 100000 字符限制")
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise TrainingDataError(f"第 {line_number} 行不是有效 JSON: {exc.msg}") from exc
            label = row.get("label")
            text = row.get("text")
            if label not in {"ham", "spam"} or not isinstance(text, str) or not text.strip():
                raise TrainingDataError(f"第 {line_number} 行必须包含非空 text 和 label=ham|spam")
            if len(text) > 50_000:
                raise TrainingDataError(f"第 {line_number} 行的 text 超过 50000 字符限制")
            labels.append(label)
            texts.append(text)

    class_counts = dict(Counter(labels))
    if len(texts) < min_samples:
        raise TrainingDataError(f"训练集至少需要 {min_samples} 条有效样本，当前为 {len(texts)} 条")
    if set(class_counts) != {"ham", "spam"}:
        raise TrainingDataError("训练集必须同时包含 ham 与 spam 两类")
    if min(class_counts.values()) < 2:
        raise TrainingDataError("每个类别至少需要 2 条样本")
    return texts, labels, class_counts


def train_jsonl_model(dataset_path: Path, output_path: Path, min_samples: int) -> dict[str, object]:
    """训练并原子替换本地模型工件；同一进程内的训练任务串行执行。"""
    with _training_lock:
        texts, labels, class_counts = _load_jsonl(dataset_path, min_samples)
        model = Pipeline(
            [
                ("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True, max_features=50_000)),
                ("classifier", LogisticRegression(max_iter=1_000, class_weight="balanced", random_state=42)),
            ]
        )
        model.fit(texts, labels)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = output_path.with_name(f".{output_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            joblib.dump(model, temporary_path)
            os.replace(temporary_path, output_path)
        finally:
            if temporary_path.exists():
                temporary_path.unlink(missing_ok=True)
    return {
        "samples": len(texts),
        "class_counts": class_counts,
        "classes": list(model.classes_),
        "model_path": str(output_path),
        "notice": "模型已在本地训练并原子替换。请以独立评估集验证后再用于生产处置。",
    }
