/**
 * 取证工作台设计：API 层保持证据可追溯，所有异步任务均通过 task_id 轮询取得明确状态。
 */

export type TaskStatus = "queued" | "running" | "completed" | "failed" | string;

export interface MailAddress {
  name: string;
  email: string;
}

export interface Attachment {
  filename: string;
  extension: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
}

export interface RuleMatch {
  rule_id: string;
  name: string;
  category: string;
  severity: string;
  score: number;
  description: string;
}

export interface Verdict {
  nature: string;
  risk_level: string;
  risk_score: number;
  tags: string[];
  recommended_action: string;
  requires_human_review: boolean;
  score_breakdown: Record<string, number>;
  notice?: string;
}

export interface MailAnalysisResult {
  email: {
    from: MailAddress;
    to: MailAddress[];
    cc: MailAddress[];
    reply_to: MailAddress[];
    subject: string;
    date: string | null;
    message_id: string;
    body: { text: string; html: string };
    urls: { raw: string[]; hosts: string[] };
    attachments: Attachment[];
    raw_size_bytes: number;
  };
  analysis: {
    rules: { score: number; matches: RuleMatch[]; category_scores: Record<string, number> };
    machine_learning: {
      engine: string;
      status: string;
      spam_probability: number | null;
      label: string | null;
      confidence?: number;
      reason?: string;
    };
    external_engines: Array<{ engine: string; status: string; score?: number; action?: string; reason?: string }>;
    verdict: Verdict;
  };
}

export interface MailTask {
  task_id: string;
  status: TaskStatus;
  original_filename?: string;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  result?: MailAnalysisResult | null;
}

export interface TrainingTask {
  task_id: string;
  status: TaskStatus;
  original_filename?: string;
  created_at?: string;
  completed_at?: string | null;
  error_message?: string | null;
  result?: {
    samples: number;
    class_counts: Record<string, number>;
    classes: string[];
    notice: string;
  } | null;
}

interface SubmittedTask {
  task_id: string;
  status: TaskStatus;
  status_url: string;
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : `请求失败（HTTP ${response.status}）`;
    throw new Error(detail);
  }
  return payload as T;
}

export async function healthcheck(baseUrl: string): Promise<void> {
  await parseResponse<{ status: string }>(await fetch(endpoint(baseUrl, "/healthz")));
}

export async function submitEmail(baseUrl: string, file: File): Promise<SubmittedTask> {
  const formData = new FormData();
  formData.append("file", file);
  return parseResponse<SubmittedTask>(
    await fetch(endpoint(baseUrl, "/api/v1/emails"), { method: "POST", body: formData }),
  );
}

export async function getEmailTask(baseUrl: string, taskId: string): Promise<MailTask> {
  return parseResponse<MailTask>(await fetch(endpoint(baseUrl, `/api/v1/tasks/${taskId}`)));
}

export async function submitTrainingDataset(baseUrl: string, dataset: File): Promise<SubmittedTask> {
  const formData = new FormData();
  formData.append("dataset", dataset);
  return parseResponse<SubmittedTask>(
    await fetch(endpoint(baseUrl, "/api/v1/models/train"), { method: "POST", body: formData }),
  );
}

export async function getTrainingTask(baseUrl: string, taskId: string): Promise<TrainingTask> {
  return parseResponse<TrainingTask>(await fetch(endpoint(baseUrl, `/api/v1/models/train/${taskId}`)));
}
