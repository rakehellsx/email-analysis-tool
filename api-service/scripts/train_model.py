"""训练本地邮件文本二分类模型。

输入格式为 JSON Lines，每行形如：{"label":"ham|spam", "text":"已脱敏邮件文本"}。
默认种子语料仅用于演示流程；生产部署必须替换为经过脱敏、标注和验证的组织语料。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

SEED_SAMPLES = [
    ("ham", "subject: 项目周会纪要 text: 本周完成接口联调，附件为会议纪要，请在周五前反馈。"),
    ("ham", "subject: Invoice approved text: Your approved invoice is available in the vendor portal. No action is required."),
    ("ham", "subject: 服务器维护通知 text: 计划于周六 02:00 至 04:00 进行内部系统维护，服务可能短暂不可用。"),
    ("ham", "subject: Re: Contract comments text: Thank you for the review. The legal team has incorporated the comments in the attached draft."),
    ("ham", "subject: 培训报名确认 text: 您已成功报名安全意识培训，课程链接位于公司学习平台。"),
    ("ham", "subject: Daily build report text: Build passed. Test coverage increased to 82 percent. See the CI dashboard for details."),
    ("ham", "subject: 采购订单更新 text: 订单编号 PO-2026-104 已发货，预计三个工作日内送达。"),
    ("ham", "subject: Holiday schedule text: The office will be closed during the public holiday. Emergency contacts remain available."),
    ("ham", "subject: Password policy reminder text: 请通过公司内部门户阅读年度密码策略更新，无需回复此邮件。"),
    ("ham", "subject: Team lunch text: We will meet at the cafeteria at noon. Please reply with dietary requirements."),
    ("ham", "subject: Expense report accepted text: Your expense report has been approved and will be paid in the next cycle."),
    ("ham", "subject: 产品发布说明 text: 新版本已发布到测试环境，变更清单和回滚方案见内部知识库。"),
    ("spam", "subject: Urgent verify your account text: Your account will be suspended today. Verify your password immediately at http://bit.ly/secure-verify."),
    ("spam", "subject: Final warning text: We detected unusual activity. Sign in now and confirm your identity to avoid account closure."),
    ("spam", "subject: 您的账户已冻结 text: 请立即登录验证身份并重置密码，否则账户将在24小时内停用。"),
    ("spam", "subject: Payment overdue text: Immediate action required. Open the attached payment.exe to avoid legal action."),
    ("spam", "subject: Microsoft security alert text: Click http://198.51.100.10/login to validate your mailbox credentials."),
    ("spam", "subject: 中奖通知 text: 恭喜中奖，请点击短链接提交银行卡和验证码领取奖金。"),
    ("spam", "subject: Shared document text: A secure document is waiting. Log in with your email and password to download it."),
    ("spam", "subject: Payroll update text: Please review the attached salary_adjustment.docm and enable macros to view details."),
    ("spam", "subject: Verify mailbox quota text: Your mailbox is full. Re-enter your username and password now to keep receiving mail."),
    ("spam", "subject: 紧急税务退款 text: 请在今天内输入身份证号、密码和银行账户以领取退款。"),
    ("spam", "subject: Security code request text: Reply immediately with the verification code sent to your phone."),
    ("spam", "subject: Invoice attached text: Open invoice.pdf.exe and follow the instructions to release the payment."),
]


def load_samples(path: Path | None) -> tuple[list[str], list[str]]:
    if path is None:
        labels, texts = zip(*SEED_SAMPLES)
        return list(texts), list(labels)
    texts: list[str] = []
    labels: list[str] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("label") not in {"ham", "spam"} or not isinstance(row.get("text"), str):
                raise ValueError(f"第 {line_number} 行必须含有 label=ham|spam 和 text 字符串")
            labels.append(row["label"])
            texts.append(row["text"])
    if len(set(labels)) < 2:
        raise ValueError("训练集必须同时含有 ham 与 spam 标签")
    return texts, labels


def main() -> None:
    parser = argparse.ArgumentParser(description="训练邮件垃圾/钓鱼文本基线分类模型")
    parser.add_argument("--data", type=Path, help="标注 JSONL 数据集路径")
    parser.add_argument("--output", type=Path, default=Path("models/baseline_model.joblib"), help="输出 joblib 文件")
    args = parser.parse_args()

    texts, labels = load_samples(args.data)
    model = Pipeline(
        [
            ("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True, max_features=50_000)),
            ("classifier", LogisticRegression(max_iter=1_000, class_weight="balanced", random_state=42)),
        ]
    )
    model.fit(texts, labels)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, args.output)
    print(json.dumps({"model": str(args.output), "samples": len(texts), "classes": list(model.classes_)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
