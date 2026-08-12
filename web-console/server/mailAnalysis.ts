import { createHash, randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";

export type ModelRecord = {
  classCounts: { ham: number; spam: number };
  tokenCounts: Record<string, { ham: number; spam: number }>;
};

export type TrainingRow = { label: "ham" | "spam"; text: string };

const MAX_TEXT_LENGTH = 500_000;
const EXECUTABLE_EXTENSIONS = new Set([".exe", ".scr", ".js", ".vbs", ".bat", ".cmd", ".ps1", ".jar", ".msi"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z", ".iso", ".img", ".gz"]);

const SEED_ROWS: TrainingRow[] = [
  { label: "ham", text: "内部项目周报和会议纪要，请审阅附件中的业务文档。" },
  { label: "ham", text: "供应商发票已在正式采购系统中登记，感谢配合。" },
  { label: "ham", text: "明天上午召开部门例会，请按时参会。" },
  { label: "ham", text: "请查收经过审核的合同修订版本。" },
  { label: "spam", text: "您的邮箱即将停用，请立即点击链接验证密码。" },
  { label: "spam", text: "紧急通知，账户异常，立即登录恢复访问权限。" },
  { label: "spam", text: "点击短链接确认身份并下载付款文件。" },
  { label: "spam", text: "最终警告，请打开附件执行程序以释放付款。" },
];

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_\u4e00-\u9fff]{2,}/g) ?? []).slice(0, 10_000);
}

export function trainNaiveBayes(rows: TrainingRow[]): ModelRecord {
  const model: ModelRecord = { classCounts: { ham: 0, spam: 0 }, tokenCounts: {} };
  for (const row of rows) {
    model.classCounts[row.label] += 1;
    for (const token of tokens(row.text)) {
      const current = model.tokenCounts[token] ?? { ham: 0, spam: 0 };
      current[row.label] += 1;
      model.tokenCounts[token] = current;
    }
  }
  return model;
}

export const DEFAULT_MODEL = trainNaiveBayes(SEED_ROWS);

export function classifyText(text: string, model: ModelRecord = DEFAULT_MODEL) {
  const vocabularySize = Math.max(Object.keys(model.tokenCounts).length, 1);
  const totalDocs = model.classCounts.ham + model.classCounts.spam;
  const labels: Array<"ham" | "spam"> = ["ham", "spam"];
  const logScores = Object.fromEntries(labels.map(label => [label, Math.log((model.classCounts[label] + 1) / (totalDocs + 2))])) as Record<"ham" | "spam", number>;
  const documentTokens = tokens(text);
  for (const label of labels) {
    const totalForLabel = Math.max(model.classCounts[label] + vocabularySize, 1);
    for (const token of documentTokens) {
      logScores[label] += Math.log(((model.tokenCounts[token]?.[label] ?? 0) + 1) / totalForLabel);
    }
  }
  const max = Math.max(logScores.ham, logScores.spam);
  const ham = Math.exp(logScores.ham - max);
  const spam = Math.exp(logScores.spam - max);
  const spamProbability = spam / (ham + spam);
  return {
    label: spamProbability >= 0.5 ? "spam" : "ham",
    spamProbability: Number(spamProbability.toFixed(4)),
    confidence: Number(Math.abs(spamProbability - 0.5).toFixed(4)),
  };
}

function addresses(value: unknown): Array<{ name: string; email: string }> {
  const entries = (value as { value?: Array<{ name?: string; address?: string }> } | undefined)?.value ?? [];
  return entries.filter(item => item.address).map(item => ({ name: item.name ?? "", email: item.address ?? "" }));
}

function extension(filename: string) {
  const index = filename.lastIndexOf(".");
  return index >= 0 ? filename.slice(index).toLowerCase() : "";
}

function urlsFrom(text: string) {
  const raw = Array.from(new Set(text.match(/https?:\/\/[^\s<>"']+/gi) ?? [])).slice(0, 100);
  const hosts = Array.from(new Set(raw.map(value => {
    try { return new URL(value).hostname; } catch { return ""; }
  }).filter(Boolean)));
  return { raw, hosts };
}

function riskLevel(score: number) {
  if (score >= 12) return "critical";
  if (score >= 7) return "high";
  if (score >= 3) return "medium";
  return "low";
}

async function runRspamd(raw: Buffer, sender: string, recipient: string) {
  const base = process.env.RSPAMD_URL?.replace(/\/+$/, "");
  if (!base) return { engine: "rspamd", status: "disabled", reason: "未配置托管 RSPAMD_URL" };
  try {
    const response = await fetch(`${base}/checkv2`, {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        Flags: "pass_all,groups,ext_urls,no_log",
        From: sender,
        ...(recipient ? { Rcpt: recipient } : {}),
      },
      body: new Uint8Array(raw),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { score?: number; required_score?: number; action?: string };
    return { engine: "rspamd", status: "completed", score: data.score ?? 0, required_score: data.required_score, action: data.action ?? "no action" };
  } catch (error) {
    return { engine: "rspamd", status: "error", reason: error instanceof Error ? error.message : "调用失败" };
  }
}

export async function analyzeEmail(input: { filename: string; raw: Buffer; model?: ModelRecord }) {
  const parsed = await simpleParser(input.raw, { skipTextToHtml: true });
  const from = addresses(parsed.from)[0] ?? { name: "", email: "" };
  const to = addresses(parsed.to);
  const cc = addresses(parsed.cc);
  const replyTo = addresses(parsed.replyTo);
  const bodyText = (parsed.text ?? "").slice(0, MAX_TEXT_LENGTH);
  const bodyHtml = (parsed.html ? String(parsed.html) : "").slice(0, MAX_TEXT_LENGTH);
  const urls = urlsFrom(`${bodyText}\n${bodyHtml}`);
  const attachments: Array<{ filename: string; extension: string; content_type: string; size_bytes: number; sha256: string }> = parsed.attachments.map((item: { filename?: string; contentType: string; content: Buffer }) => {
    const filename = item.filename ?? "unnamed-attachment";
    return {
      filename,
      extension: extension(filename),
      content_type: item.contentType,
      size_bytes: item.content.length,
      sha256: createHash("sha256").update(item.content).digest("hex"),
    };
  });
  const matches: Array<{ rule_id: string; name: string; category: string; severity: string; score: number; description: string }> = [];
  const add = (rule_id: string, name: string, category: string, severity: string, score: number, description: string) => matches.push({ rule_id, name, category, severity, score, description });
  if (attachments.some(item => ARCHIVE_EXTENSIONS.has(item.extension))) add("ATTACHMENT_ARCHIVE", "压缩文件附件", "suspicious_attachment", "medium", 2, "压缩包可能用于隐藏真实附件类型，需要结合其他信号复核。");
  if (attachments.some(item => EXECUTABLE_EXTENSIONS.has(item.extension))) add("ATTACHMENT_EXECUTABLE", "可执行附件", "malicious_attachment", "critical", 8, "邮件包含可执行类型附件，应隔离后再进行分析。");
  if (attachments.some(item => /\.(pdf|docx?|xlsx?|jpg|png)\.(exe|scr|js|vbs|bat|cmd)$/i.test(item.filename))) add("ATTACHMENT_DOUBLE_EXTENSION", "双扩展名附件", "malicious_attachment", "critical", 7, "附件名伪装为文档或图片，但实际扩展名具有执行风险。");
  if (urls.raw.some(url => /https?:\/\/[^/\s]+@/i.test(url))) add("PHISHING_AT_SIGN_URL", "URL 用户名混淆", "phishing", "high", 4, "URL 在主机名前使用 @ 符号混淆真实站点。");
  if (urls.hosts.some(host => /^(\d{1,3}\.){3}\d{1,3}$/.test(host))) add("PHISHING_IP_URL", "IP 地址链接", "phishing", "high", 3, "邮件链接使用 IP 地址而非可验证域名。");
  if (replyTo[0]?.email && from.email && replyTo[0].email.split("@")[1] !== from.email.split("@")[1]) add("SENDER_REPLYTO_MISMATCH", "发件人与回复地址不一致", "abnormal_sender", "medium", 3, "Reply-To 域名与发件人域名不一致。");
  const rulesScore = matches.reduce((sum, item) => sum + item.score, 0);
  const categoryScores = matches.reduce<Record<string, number>>((result, item) => ({ ...result, [item.category]: (result[item.category] ?? 0) + item.score }), {});
  const ml = classifyText(`${parsed.subject ?? ""}\n${bodyText}`, input.model ?? DEFAULT_MODEL);
  const rspamd = await runRspamd(input.raw, from.email, to[0]?.email ?? "");
  const rspamdContribution = rspamd.status === "completed" && typeof rspamd.score === "number" ? Math.min(Math.max(rspamd.score, 0), 10) * 0.4 : 0;
  const score = Number((rulesScore + ml.spamProbability * 5 + rspamdContribution).toFixed(2));
  const level = riskLevel(score);
  const nature = matches.some(item => item.category === "malicious_attachment") ? "MALICIOUS_ATTACHMENT" : score >= 7 ? "SUSPICIOUS" : "SAFE";
  return {
    task_id: randomUUID(), status: "completed", original_filename: input.filename, created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    result: {
      email: { from, to, cc, reply_to: replyTo, subject: parsed.subject ?? "(无主题)", date: parsed.date?.toISOString() ?? null, message_id: parsed.messageId ?? "", body: { text: bodyText, html: bodyHtml }, urls, attachments, raw_size_bytes: input.raw.length },
      analysis: {
        rules: { score: rulesScore, matches, category_scores: categoryScores },
        machine_learning: { engine: "multinomial_naive_bayes", status: "completed", spam_probability: ml.spamProbability, label: ml.label, confidence: ml.confidence, reason: "使用当前托管模型进行词元概率判别。" },
        external_engines: [rspamd],
        verdict: { nature, risk_level: level, risk_score: score, tags: matches.map(item => item.category), recommended_action: score >= 7 ? "review" : "allow", requires_human_review: score >= 3, score_breakdown: { rules: rulesScore, machine_learning: Number((ml.spamProbability * 5).toFixed(2)), rspamd: Number(rspamdContribution.toFixed(2)) }, notice: score >= 7 ? "自动化检测发现高风险信号，请在隔离环境中完成复核。" : "未发现高风险组合信号，仍请遵循组织安全策略。" },
      },
    },
  };
}

export function parseTrainingDataset(text: string): TrainingRow[] {
  const rows = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    let item: unknown;
    try { item = JSON.parse(line); } catch { throw new Error(`第 ${index + 1} 行不是有效 JSON`); }
    const value = item as { label?: unknown; text?: unknown };
    if ((value.label !== "ham" && value.label !== "spam") || typeof value.text !== "string" || !value.text.trim()) throw new Error(`第 ${index + 1} 行必须包含 label: ham|spam 和非空 text`);
    return { label: value.label, text: value.text.trim() } as TrainingRow;
  });
  if (rows.length < 10) throw new Error("训练数据至少需要 10 条有效样本");
  if (!rows.some(row => row.label === "ham") || !rows.some(row => row.label === "spam")) throw new Error("训练数据必须同时包含 ham 和 spam 标签");
  return rows;
}
