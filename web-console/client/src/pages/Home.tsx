/**
 * 功能型邮件安全控制台：上传邮件、查看风险结论与训练本地模型。
 */

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  ExternalLink,
  FileSearch,
  FileText,
  Layers,
  Link2,
  Mail,
  Paperclip,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import type { MailAddress, MailTask, TrainingTask } from "@/lib/mail-api";

function readableBytes(bytes?: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function addressLine(addresses: MailAddress[]) {
  if (!addresses.length) return "—";
  return addresses
    .map((address) => (address.name ? `${address.name} <${address.email}>` : address.email))
    .join(" · ");
}

function statusStyle(status?: string) {
  if (status === "completed") return "bg-[#E5F1EB] text-[#285E46] border-[#B8D9C4]";
  if (status === "failed") return "bg-[#FCE9E5] text-[#9C382A] border-[#F2C6BE]";
  if (status === "running") return "bg-[#FBF0DE] text-[#9E5C22] border-[#EED2A7]";
  return "bg-[#F0EEE7] text-[#676861] border-[#D9D6CB]";
}

function riskStyle(level?: string) {
  if (level === "critical" || level === "high") return "bg-[#B94C3B] text-white";
  if (level === "medium") return "bg-[#C7732C] text-white";
  if (level === "low") return "bg-[#EEE3CC] text-[#82551D]";
  return "bg-[#E4F0EA] text-[#2C684D]";
}

function fileTypeIsEmail(file: File) {
  return file.name.toLowerCase().endsWith(".eml");
}

function fileTypeIsDataset(file: File) {
  return /\.(jsonl|ndjson)$/i.test(file.name);
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(new Error("无法读取上传文件"));
    reader.readAsDataURL(file);
  });
}

function friendlyRequestError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (/fetch|network|failed to fetch/i.test(message)) return "托管分析服务暂时不可用，请点击“检查服务”后重试。";
  return message || fallback;
}

export default function Home() {
  const healthQuery = trpc.mail.health.useQuery(undefined, { retry: false });
  const analyzeMutation = trpc.mail.analyze.useMutation();
  const trainingMutation = trpc.mail.train.useMutation();
  const apiOnline = healthQuery.isSuccess;
  const [emailFile, setEmailFile] = useState<File | null>(null);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [mailTask, setMailTask] = useState<MailTask | null>(null);
  const [trainingTask, setTrainingTask] = useState<TrainingTask | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [trainingBusy, setTrainingBusy] = useState(false);
  const [isDraggingMail, setIsDraggingMail] = useState(false);
  const [isDraggingDataset, setIsDraggingDataset] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const datasetInputRef = useRef<HTMLInputElement>(null);

  const result = mailTask?.result;
  const verdict = result?.analysis.verdict;
  const latestRuleMatches = result?.analysis.rules.matches ?? [];
  const latestAttachments = result?.email.attachments ?? [];

  const apiLabel = "同源托管服务";

  const chooseMail = (file?: File | null) => {
    if (!file) return;
    if (!fileTypeIsEmail(file)) {
      toast.error("请选择 .eml 邮件文件");
      return;
    }
    setEmailFile(file);
    setMailTask(null);
  };

  const chooseDataset = (file?: File | null) => {
    if (!file) return;
    if (!fileTypeIsDataset(file)) {
      toast.error("训练数据必须是 .jsonl 或 .ndjson 文件");
      return;
    }
    setDatasetFile(file);
    setTrainingTask(null);
  };

  const startAnalysis = async () => {
    if (!emailFile) {
      toast.error("请先选择一封 EML 邮件");
      return;
    }
    setEmailBusy(true);
    try {
      const completed = await analyzeMutation.mutateAsync({ filename: emailFile.name, contentBase64: await fileToBase64(emailFile) });
      setMailTask(completed);
      toast.success("分析已完成", {
        description: `结论：${completed.result?.analysis.verdict.nature || "已生成"}`,
      });
    } catch (error) {
      const message = friendlyRequestError(error, "提交分析请求失败");
      toast.error("无法完成邮件分析", { description: message });
      setMailTask((current) => (current ? { ...current, status: "failed", error_message: message } : null));
    } finally {
      setEmailBusy(false);
    }
  };

  const startTraining = async () => {
    if (!datasetFile) {
      toast.error("请先选择训练数据集");
      return;
    }
    setTrainingBusy(true);
    try {
      const completed = await trainingMutation.mutateAsync({ filename: datasetFile.name, datasetText: await datasetFile.text() });
      setTrainingTask(completed);
      toast.success("本地模型已更新", {
        description: `已使用 ${completed.result?.samples || 0} 条有效样本完成训练。`,
      });
    } catch (error) {
      const message = friendlyRequestError(error, "提交训练请求失败");
      toast.error("无法完成模型训练", { description: message });
      setTrainingTask((current) => (current ? { ...current, status: "failed", error_message: message } : null));
    } finally {
      setTrainingBusy(false);
    }
  };

  const handleMailDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingMail(false);
    chooseMail(event.dataTransfer.files?.[0]);
  };

  const handleDatasetDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingDataset(false);
    chooseDataset(event.dataTransfer.files?.[0]);
  };

  return (
    <div className="min-h-screen bg-[#F6F4ED] text-[#1A2922] selection:bg-[#E6C090] selection:text-[#1A2922]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-[#DAD7CB] bg-[#18231E] px-5 py-6 text-[#F9F6EB] lg:flex">
        <div className="flex items-center gap-3 px-2">
          <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-[13px] bg-[#F6F4ED] shadow-[0_8px_20px_rgba(0,0,0,0.22)]">
            <img src="/manus-storage/mail-forensics-logo_1ad44f1d.png" alt="邮件取证工作台" className="h-9 w-9 object-contain" />
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#BFCDBF]">Email security</p>
            <p className="mt-0.5 font-serif text-[19px] leading-none tracking-tight">邮鉴 · 工作台</p>
          </div>
        </div>

        <nav className="mt-12 space-y-1" aria-label="主导航">
          <a href="#analysis" className="group flex items-center gap-3 rounded-xl bg-[#284137] px-3 py-3 text-sm font-medium transition hover:bg-[#315245]">
            <Mail className="h-4 w-4 text-[#E7AF68]" />
            邮件研判
            <ChevronRight className="ml-auto h-4 w-4 text-[#9BB0A0] transition group-hover:translate-x-0.5" />
          </a>
          <a href="#training" className="group flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-[#C4D1C4] transition hover:bg-[#23382F] hover:text-white">
            <BrainCircuit className="h-4 w-4 text-[#93B6A2]" />
            模型训练
            <ChevronRight className="ml-auto h-4 w-4 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
          </a>
          <a href="#evidence" className="group flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-[#C4D1C4] transition hover:bg-[#23382F] hover:text-white">
            <FileSearch className="h-4 w-4 text-[#93B6A2]" />
            分析结果
            <ChevronRight className="ml-auto h-4 w-4 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
          </a>
        </nav>

        <div className="mt-auto rounded-2xl border border-[#385549] bg-[#20342B] p-4">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#9DB0A1]">分析服务</p>
            <span className={`h-2 w-2 rounded-full ${apiOnline ? "bg-[#82C3A0] shadow-[0_0_0_4px_rgba(130,195,160,0.12)]" : "bg-[#D98272]"}`} />
          </div>
          <p className="mt-2 truncate font-mono text-xs text-[#F7F3E8]">{apiLabel}</p>
          <p className="mt-2 text-xs leading-5 text-[#B4C4B6]">规则、模型与引擎结果在此统一展示。</p>
        </div>
      </aside>

      <main className="min-h-screen lg:pl-[248px]">
        <header className="sticky top-0 z-20 border-b border-[#DEDBCF] bg-[#F6F4ED]/95 px-5 py-3 backdrop-blur md:px-8 lg:px-10">
          <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3 lg:hidden">
              <img src="/manus-storage/mail-forensics-logo_1ad44f1d.png" alt="" className="h-8 w-8 rounded-lg bg-white p-0.5" />
              <span className="font-serif text-lg">邮鉴</span>
            </div>
            <div className="hidden min-w-0 items-center gap-3 md:flex">
              <div className="grid h-7 w-7 place-items-center overflow-hidden rounded-lg border border-[#DDD8CB] bg-white">
                <img src="/manus-storage/mail-forensics-logo_1ad44f1d.png" alt="" className="h-6 w-6 object-contain" />
              </div>
              <div>
                <p className="font-serif text-[17px] leading-none tracking-[-0.02em] text-[#23342B]">邮鉴</p>
                <p className="mt-0.5 truncate font-mono text-[9px] uppercase tracking-[0.16em] text-[#71756E]">邮件安全分析控制台</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-2 rounded-full border border-[#DCD9CE] bg-white px-3 py-1.5 sm:flex">
                <span className={`h-1.5 w-1.5 rounded-full ${apiOnline ? "bg-[#4B9A70]" : "bg-[#C7732C]"}`} />
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#646960]">{apiOnline ? "API 已连接" : "等待连接"}</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => void healthQuery.refetch()} className="border-[#D5D1C6] bg-white text-[#2D3E35] hover:bg-[#F0EEE7]">
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> 检查服务
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-[1440px] px-5 py-7 md:px-8 lg:px-10 lg:py-10">
          <section className="relative overflow-hidden rounded-[28px] border border-[#D6D2C5] bg-[#EEE9DB] px-6 py-6 shadow-[0_16px_40px_rgba(36,50,42,0.08)] md:px-9 md:py-7">
            <img src="/manus-storage/forensics-paper-field_ddf81fe7.png" alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-60 mix-blend-multiply" />
            <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-end">
              <div>
                <div className="mb-4 flex items-center gap-3">
                <span className="rounded-full border border-[#D9B47E] bg-[#FFF4E4] px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#98591E]">实时分析</span>
                <span className="h-px w-12 bg-[#C7732C]/60" />
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#6E746B]">EML · 规则 · 机器学习</span>
              </div>
                <h1 className="max-w-2xl font-serif text-3xl leading-[0.97] tracking-[-0.035em] text-[#1A2922] md:text-4xl">上传邮件，<br />快速查看安全分析结果。</h1>
                <p className="mt-4 max-w-xl text-sm leading-6 text-[#4D5B52]">系统会解析 MIME 结构、附件、链接，并综合 YAML 规则、本地机器学习模型和可选 Rspamd 引擎输出检测结论。</p>
              </div>
              <div className="rounded-2xl border border-[#CDBFA9]/80 bg-[#FFF9ED]/75 p-4 shadow-sm backdrop-blur-sm">
                <div className="flex items-center justify-between"><span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#82694B]">服务状态</span><span className={`h-2 w-2 rounded-full ${apiOnline ? "bg-[#4B9A70]" : "bg-[#C7732C]"}`} /></div>
                <div className="mt-4 grid grid-cols-3 gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-[#72776D]"><span className="rounded-lg bg-[#F2E6D2] px-2 py-2 text-[#A86724]">上传</span><span className="rounded-lg border border-[#DED7C8] bg-white/70 px-2 py-2">分析</span><span className="rounded-lg border border-[#DED7C8] bg-white/70 px-2 py-2">结果</span></div>
                <p className="mt-3 font-mono text-[10px] text-[#7D7F75]">API / {apiOnline ? "ONLINE" : "CHECKING"}</p>
              </div>
            </div>
            <div className="relative mt-6 flex flex-wrap gap-x-6 gap-y-3 border-t border-[#CABFAE]/70 pt-4 font-mono text-[10px] uppercase tracking-[0.13em] text-[#677068]">
              <span className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-[#31704E]" /> 原始 EML</span>
              <span className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-[#31704E]" /> 可追溯规则</span>
              <span className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-[#31704E]" /> 本地模型推理</span>
            </div>
          </section>

          <section className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1.08fr)_minmax(380px,0.92fr)]" id="analysis">
            <div className="space-y-7">
              <article className="dossier-card p-1">
                <div className="rounded-[19px] border border-dashed border-[#CFC8B8] bg-[#FBFAF5] p-5 md:p-6">
                  <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                    <div>
                      <p className="eyebrow">邮件分析</p>
                      <h2 className="mt-2 font-serif text-2xl tracking-[-0.02em] text-[#1C2C24]">上传待分析 EML</h2>
                      <p className="mt-2 max-w-lg text-sm leading-6 text-[#667068]">支持 RFC 822 `.eml` 文件。系统只做解析和安全检测，不执行附件或访问邮件内链接。</p>
                    </div>
                    <span className="stamp-label">最大 15 MB</span>
                  </div>

                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => emailInputRef.current?.click()}
                    onKeyDown={(event) => event.key === "Enter" && emailInputRef.current?.click()}
                    onDragOver={(event) => { event.preventDefault(); setIsDraggingMail(true); }}
                    onDragLeave={() => setIsDraggingMail(false)}
                    onDrop={handleMailDrop}
                    className={`mt-6 flex min-h-[178px] cursor-pointer flex-col items-center justify-center rounded-2xl border px-6 text-center transition ${isDraggingMail ? "border-[#C7732C] bg-[#FFF4E4]" : "border-[#DDD7C9] bg-[#F5F2E9] hover:border-[#B79460] hover:bg-[#F8F3E8]"}`}
                  >
                    <input ref={emailInputRef} type="file" accept=".eml,message/rfc822" className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => chooseMail(event.target.files?.[0])} />
                    {emailFile ? (
                      <>
                        <div className="grid h-11 w-11 place-items-center rounded-xl bg-[#EAD4B4] text-[#9A5D22]"><FileText className="h-5 w-5" /></div>
                        <p className="mt-3 font-medium text-[#263A2F]">{emailFile.name}</p>
                        <p className="mt-1 font-mono text-[11px] text-[#73776F]">{readableBytes(emailFile.size)} · 已等待归档</p>
                      </>
                    ) : (
                      <>
                        <div className="grid h-11 w-11 place-items-center rounded-xl bg-white text-[#B86C27] shadow-sm"><Upload className="h-5 w-5" /></div>
                        <p className="mt-3 text-sm font-medium text-[#35463B]">拖放 EML 到这里，或点击选择</p>
                        <p className="mt-1 text-xs text-[#777B74]">保留原始邮件结构与 MIME 附件信息</p>
                      </>
                    )}
                  </div>

                  <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#77796F]">{emailFile ? "已准备提交 · 将开始异步分析" : "尚未选择邮件"}</p>
                    <div className="flex gap-2">
                      {emailFile && <Button variant="ghost" size="sm" onClick={() => { setEmailFile(null); setMailTask(null); }} className="text-[#73786F] hover:bg-[#ECE8DD]"><X className="mr-1 h-3.5 w-3.5" />移除</Button>}
                      <Button onClick={startAnalysis} disabled={emailBusy || !emailFile || !apiOnline} className="bg-[#C7732C] text-white shadow-[0_7px_14px_rgba(199,115,44,0.22)] hover:bg-[#A95F20]">
                       {emailBusy ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpRight className="mr-2 h-4 w-4" />}
                        {emailBusy ? "正在分析" : apiOnline ? "提交研判" : "服务连接中"}
                      </Button>
                    </div>
                  </div>
                </div>
              </article>

              <article className="dossier-card overflow-hidden" id="evidence">
                <div className="flex items-center justify-between border-b border-[#E3DED2] px-5 py-4 md:px-6">
                  <div>
                    <p className="eyebrow">分析结果</p>
                    <h2 className="mt-1 font-serif text-2xl tracking-[-0.02em]">风险结论与证据</h2>
                  </div>
                  {mailTask && <Badge className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${statusStyle(mailTask.status)}`}>{mailTask.status}</Badge>}
                </div>

                {!mailTask && (
                  <div className="relative flex min-h-[290px] flex-col justify-end overflow-hidden px-6 pb-7 pt-16 md:px-7">
                    <img src="/manus-storage/evidence-thread_d055f14f.png" alt="" className="pointer-events-none absolute inset-x-0 top-0 h-[150px] w-full object-cover opacity-65" />
                    <div className="relative max-w-lg">
                      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#A26A2B]">等待分析</p>
                      <p className="mt-2 font-serif text-2xl leading-tight text-[#35443A]">提交邮件后，这里会显示最终风险等级、规则命中与机器学习判别。</p>
                    </div>
                  </div>
                )}

                {mailTask && !result && (
                  <div className="p-6 md:p-7">
                    <div className="flex items-start gap-4">
                      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#FFF2DF] text-[#B26826]"><Clock3 className="h-5 w-5" /></div>
                      <div>
                        <p className="font-medium text-[#2E4135]">系统正在分析邮件</p>
                        <p className="mt-1 text-sm leading-6 text-[#6B736C]">正在解析 MIME 结构、附件、链接、YAML 规则和本地模型结果。此处会随任务状态自动更新。</p>
                      </div>
                    </div>
                    <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-[#E8E4D9]"><div className="h-full w-2/3 animate-pulse rounded-full bg-[#C7732C]" /></div>
                    <p className="mt-3 break-all font-mono text-[10px] text-[#85877F]">TASK / {mailTask.task_id}</p>
                  </div>
                )}

                {result && verdict && (
                  <div>
                    <div className="grid gap-5 border-b border-[#E3DED2] p-5 md:grid-cols-[0.92fr_1.08fr] md:p-6">
                      <div className="rounded-2xl bg-[#1D352A] p-5 text-[#FBF8EF]">
                        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#B5C4B5]">总体性质</p>
                        <div className="mt-4 flex items-end justify-between gap-3">
                          <p className="font-serif text-3xl leading-none tracking-[-0.03em]">{verdict.nature.replace(/_/g, " ")}</p>
                          <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${riskStyle(verdict.risk_level)}`}>{verdict.risk_level}</span>
                        </div>
                        <div className="mt-6 flex items-center gap-3 border-t border-white/15 pt-4">
                          <span className="font-mono text-2xl text-[#E7AF68]">{verdict.risk_score.toFixed(1)}</span>
                          <span className="text-xs leading-4 text-[#C7D4C9]">综合风险评分<br />建议：{verdict.recommended_action}</span>
                        </div>
                      </div>
                      <div className="space-y-4">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#FBEAD7] text-[#AA6426]"><AlertTriangle className="h-4 w-4" /></div>
                          <div>
                            <p className="font-medium text-[#2E4236]">处置建议：{verdict.recommended_action === "quarantine" ? "隔离邮件" : verdict.recommended_action === "review" ? "人工复核" : "允许投递"}</p>
                            <p className="mt-1 text-sm leading-5 text-[#68716A]">{verdict.notice || "自动研判已完成，请结合组织策略和邮件上下文复核。"}</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {verdict.tags.length ? verdict.tags.map((tag) => <Badge key={tag} variant="outline" className="border-[#D9D1C1] bg-[#F8F5ED] font-mono text-[10px] uppercase tracking-[0.1em] text-[#5C655D]">{tag.replace(/_/g, " ")}</Badge>) : <Badge variant="outline" className="border-[#BFDACB] bg-[#EDF6F0] text-[#336947]">未发现额外风险标签</Badge>}
                        </div>
                      </div>
                    </div>

                    <div className="grid divide-y divide-[#E3DED2] md:grid-cols-2 md:divide-x md:divide-y-0">
                      <div className="p-5 md:p-6">
                        <div className="flex items-center justify-between"><p className="eyebrow">规则证据</p><span className="font-mono text-xs text-[#A96A2A]">{result.analysis.rules.score.toFixed(1)} pts</span></div>
                        <div className="mt-4 space-y-3">
                          {latestRuleMatches.length ? latestRuleMatches.slice(0, 4).map((match) => (
                            <div key={match.rule_id} className="rounded-xl border border-[#E4DED2] bg-[#FBFAF5] p-3">
                              <div className="flex gap-3"><span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-[#C7732C]" /><div className="min-w-0"><p className="truncate text-sm font-medium text-[#334439]">{match.name}</p><p className="mt-1 text-xs leading-5 text-[#747970]">{match.description}</p></div><span className="ml-auto font-mono text-xs text-[#996021]">+{match.score}</span></div>
                            </div>
                          )) : <p className="text-sm text-[#6B746D]">没有命中 YAML 规则。</p>}
                        </div>
                      </div>
                      <div className="p-5 md:p-6">
                        <div className="flex items-center justify-between"><p className="eyebrow">机器学习判别</p><BrainCircuit className="h-4 w-4 text-[#668573]" /></div>
                        <div className="mt-4 rounded-xl bg-[#ECF2EB] p-4">
                          <div className="flex items-baseline justify-between gap-3"><p className="font-serif text-2xl text-[#274938]">{result.analysis.machine_learning.label || "unavailable"}</p>{result.analysis.machine_learning.spam_probability !== null && <span className="font-mono text-xs text-[#567260]">垃圾概率 {(result.analysis.machine_learning.spam_probability * 100).toFixed(1)}%</span>}</div>
                          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#D3E0D4]"><div className="h-full rounded-full bg-[#4D8B67]" style={{ width: `${Math.max(3, (result.analysis.machine_learning.spam_probability || 0) * 100)}%` }} /></div>
                          <p className="mt-3 text-xs leading-5 text-[#587064]">{result.analysis.machine_learning.status === "completed" ? "由当前本地模型生成；训练新样本后会自动换用新的模型工件。" : result.analysis.machine_learning.reason || "模型引擎暂不可用。"}</p>
                        </div>
                        <div className="mt-4 rounded-xl border border-[#E1DCCF] bg-[#FBFAF5] p-3.5">
                          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#8A7051]">外部检测引擎</p>
                          {result.analysis.external_engines.map((engine) => (
                            <div key={engine.engine} className="mt-2 flex items-start justify-between gap-3 text-xs">
                              <div><p className="font-medium text-[#405147]">{engine.engine}</p><p className="mt-0.5 text-[#6E786F]">{engine.status === "completed" ? `评分 ${engine.score ?? 0} · 动作 ${engine.action ?? "无"}` : engine.reason || "未启用"}</p></div>
                              <Badge className={`border font-mono text-[9px] uppercase ${statusStyle(engine.status)}`}>{engine.status}</Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            </div>

            <aside className="space-y-7">
              <article className="dossier-card overflow-hidden" id="training">
                <div className="relative min-h-[158px] overflow-hidden bg-[#E7EBE2] p-5 md:p-6">
                  <img src="/manus-storage/model-training-card_bc7d5ae5.png" alt="本地模型训练示意" className="absolute right-0 top-0 h-full w-[55%] object-cover mix-blend-multiply opacity-90" />
                  <div className="relative max-w-[62%]">
                    <p className="eyebrow">模型工作区</p>
                    <h2 className="mt-2 font-serif text-2xl leading-none tracking-[-0.025em]">训练本地<br />邮件分类器</h2>
                    <p className="mt-3 text-xs leading-5 text-[#53675A]">仅上传已经脱敏的标注文本。</p>
                  </div>
                </div>
                <div className="p-5 md:p-6">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => datasetInputRef.current?.click()}
                    onKeyDown={(event) => event.key === "Enter" && datasetInputRef.current?.click()}
                    onDragOver={(event) => { event.preventDefault(); setIsDraggingDataset(true); }}
                    onDragLeave={() => setIsDraggingDataset(false)}
                    onDrop={handleDatasetDrop}
                    className={`rounded-xl border p-4 transition ${isDraggingDataset ? "border-[#C7732C] bg-[#FFF4E4]" : "border-[#DED8CB] bg-[#FBFAF5] hover:border-[#C5AA82]"}`}
                  >
                    <input ref={datasetInputRef} type="file" accept=".jsonl,.ndjson,application/x-ndjson" className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => chooseDataset(event.target.files?.[0])} />
                    <div className="flex items-start gap-3">
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#F0E7D5] text-[#A96725]"><Database className="h-4 w-4" /></div>
                      <div className="min-w-0"><p className="truncate text-sm font-medium text-[#34443A]">{datasetFile ? datasetFile.name : "添加 JSONL 训练集"}</p><p className="mt-1 text-xs leading-5 text-[#72786F]">{datasetFile ? `${readableBytes(datasetFile.size)} · 等待校验` : "每行需含 label: ham|spam 与脱敏 text"}</p></div>
                    </div>
                  </div>
                  <div className="mt-4 rounded-xl border border-[#E1DCCF] bg-[#F7F4EC] px-3.5 py-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#8A7051]">训练前检查</p>
                    <p className="mt-1.5 text-xs leading-5 text-[#606C63]">至少 10 条有效样本，ham 与 spam 都必须出现；训练完成后会原子替换当前模型。</p>
                  </div>
                  <Button onClick={startTraining} disabled={!datasetFile || trainingBusy || !apiOnline} className="mt-4 w-full bg-[#1D382C] text-[#FFF9ED] hover:bg-[#2A5140]">
                    {trainingBusy ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <BrainCircuit className="mr-2 h-4 w-4" />}
                    {trainingBusy ? "正在训练" : apiOnline ? "验证并训练模型" : "服务连接中"}
                  </Button>
                  {trainingTask && (
                    <div className="mt-4 rounded-xl border border-[#E2DCD0] bg-white p-3.5">
                      <div className="flex items-center justify-between gap-3"><p className="text-xs font-medium text-[#44564A]">训练任务</p><Badge className={`border font-mono text-[9px] uppercase tracking-[0.1em] ${statusStyle(trainingTask.status)}`}>{trainingTask.status}</Badge></div>
                      {trainingTask.result ? <p className="mt-2 text-xs leading-5 text-[#657269]">已使用 <strong className="font-semibold text-[#3C5647]">{trainingTask.result.samples}</strong> 条样本完成本地训练，其中 ham {trainingTask.result.class_counts.ham ?? 0} 条、spam {trainingTask.result.class_counts.spam ?? 0} 条。</p> : <p className="mt-2 break-all font-mono text-[10px] text-[#777D74]">TASK / {trainingTask.task_id}</p>}
                      {trainingTask.error_message && <p className="mt-2 text-xs text-[#A34535]">{trainingTask.error_message}</p>}
                    </div>
                  )}
                </div>
              </article>

              <article className="dossier-card p-5 md:p-6">
                <div className="flex items-center justify-between"><div><p className="eyebrow">服务连接</p><h2 className="mt-1 font-serif text-xl">托管分析接口</h2></div><Settings2 className="h-4 w-4 text-[#7D8B80]" /></div>
                <div className="mt-4 rounded-xl border border-[#D9D4C8] bg-[#FBFAF6] px-3 py-2.5 font-mono text-xs text-[#3A4D42]">同源 tRPC · 发布环境可用</div>
                <div className="mt-3 flex items-start gap-2 text-xs leading-5 text-[#6D766E]"><Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#A96829]" /><p>邮件内容直接提交到本网站托管后端，不再依赖浏览器本地地址或跨域配置。</p></div>
              </article>

              {result && (
                <article className="dossier-card p-5 md:p-6">
                  <div className="flex items-center gap-2"><Layers className="h-4 w-4 text-[#B46C2A]" /><p className="eyebrow">邮件摘要</p></div>
                  <p className="mt-3 font-serif text-xl leading-snug text-[#26392F]">{result.email.subject || "（无主题）"}</p>
                  <dl className="mt-5 space-y-3 border-t border-[#E4DED2] pt-4 text-xs">
                    <div><dt className="font-mono uppercase tracking-[0.12em] text-[#8A8B82]">From</dt><dd className="mt-1 break-all text-[#48574E]">{addressLine([result.email.from])}</dd></div>
                    <div><dt className="font-mono uppercase tracking-[0.12em] text-[#8A8B82]">To</dt><dd className="mt-1 break-all text-[#48574E]">{addressLine(result.email.to)}</dd></div>
                    <div><dt className="font-mono uppercase tracking-[0.12em] text-[#8A8B82]">URLs</dt><dd className="mt-1 text-[#48574E]">{result.email.urls.hosts.length} 个主机名</dd></div>
                  </dl>
                </article>
              )}
            </aside>
          </section>

          {result && (
            <section className="mt-7 grid gap-7 lg:grid-cols-2">
              <article className="dossier-card p-5 md:p-6">
                <div className="flex items-center justify-between"><div><p className="eyebrow">附件指纹</p><h2 className="mt-1 font-serif text-2xl">解析到的附件</h2></div><Paperclip className="h-5 w-5 text-[#A96B2C]" /></div>
                <div className="mt-5 space-y-3">
                  {latestAttachments.length ? latestAttachments.map((attachment) => (
                    <div key={`${attachment.filename}-${attachment.sha256}`} className="rounded-xl border border-[#E3DED3] bg-[#FBFAF5] px-4 py-3">
                      <div className="flex items-start gap-3"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-[#C7732C]" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-[#37483D]">{attachment.filename}</p><p className="mt-1 font-mono text-[10px] text-[#7B7F77]">{attachment.content_type} · {readableBytes(attachment.size_bytes)}</p><p className="mt-2 break-all font-mono text-[10px] text-[#9A978D]">SHA-256 / {attachment.sha256}</p></div></div>
                    </div>
                  )) : <p className="rounded-xl bg-[#F6F3EB] p-4 text-sm text-[#69736B]">邮件没有包含附件。</p>}
                </div>
              </article>
              <article className="dossier-card p-5 md:p-6">
                <div className="flex items-center justify-between"><div><p className="eyebrow">邮件正文</p><h2 className="mt-1 font-serif text-2xl">可读文本预览</h2></div><FileSearch className="h-5 w-5 text-[#6F8C79]" /></div>
                <pre className="mt-5 max-h-[300px] overflow-auto whitespace-pre-wrap rounded-xl border border-[#E3DED3] bg-[#F5F3EC] p-4 font-sans text-sm leading-6 text-[#4D5B52]">{result.email.body.text || "邮件未包含可读取的纯文本正文。"}</pre>
              </article>
            </section>
          )}

          <footer className="mt-10 flex flex-col gap-2 border-t border-[#DEDACF] py-6 font-mono text-[10px] uppercase tracking-[0.12em] text-[#7B7D75] sm:flex-row sm:items-center sm:justify-between">
            <span>邮件取证工作台 / 本地分析接口</span>
            <span className="flex items-center gap-2"><ShieldCheck className="h-3.5 w-3.5 text-[#4B8E69]" /> 不执行附件 · 不访问邮件链接</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
