import { COOKIE_NAME } from "@shared/const";
import { z } from "zod";
import { getActiveMailModel, getMailTaskById, saveMailModel, saveMailTask } from "./db";
import { analyzeEmail, DEFAULT_MODEL, parseTrainingDataset, trainNaiveBayes, type ModelRecord } from "./mailAnalysis";
import { storagePut } from "./storage";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  mail: router({
    health: publicProcedure.query(() => ({ status: "ok", service: "托管邮件分析服务" })),
    analyze: publicProcedure.input(z.object({ filename: z.string().min(1).max(180), contentBase64: z.string().min(1).max(22_000_000) })).mutation(async ({ input }) => {
      const raw = Buffer.from(input.contentBase64, "base64");
      if (!raw.length || raw.length > 15 * 1024 * 1024) throw new Error("EML 文件必须大于 0 且不超过 15 MB");
      const saved = await getActiveMailModel();
      let model = DEFAULT_MODEL;
      if (saved) {
        try { model = JSON.parse(saved.modelJson) as ModelRecord; } catch { model = DEFAULT_MODEL; }
      }
      const task = await analyzeEmail({ filename: input.filename, raw, model });
      try { await storagePut(`mail-analysis/${task.task_id}/${input.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`, raw, "message/rfc822"); } catch (error) { console.warn("邮件存档失败，不影响分析结果", error); }
      await saveMailTask({ taskId: task.task_id, taskType: "analysis", status: task.status, originalFilename: input.filename, resultJson: JSON.stringify(task) });
      return task;
    }),
    train: publicProcedure.input(z.object({ filename: z.string().min(1).max(180), datasetText: z.string().min(1).max(10_000_000) })).mutation(async ({ input }) => {
      const rows = parseTrainingDataset(input.datasetText);
      const model = trainNaiveBayes(rows);
      const classCounts = rows.reduce((result, row) => ({ ...result, [row.label]: result[row.label] + 1 }), { ham: 0, spam: 0 });
      await saveMailModel({ modelJson: JSON.stringify(model), sampleCount: rows.length, hamCount: classCounts.ham, spamCount: classCounts.spam });
      try { await storagePut(`mail-analysis/training/${input.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`, input.datasetText, "application/x-ndjson"); } catch (error) { console.warn("训练集存档失败，不影响模型更新", error); }
      const task = { task_id: crypto.randomUUID(), status: "completed", original_filename: input.filename, created_at: new Date().toISOString(), completed_at: new Date().toISOString(), result: { samples: rows.length, class_counts: classCounts, classes: ["ham", "spam"], notice: "托管朴素贝叶斯模型已更新，将用于后续邮件分析。" } };
      await saveMailTask({ taskId: task.task_id, taskType: "training", status: task.status, originalFilename: input.filename, resultJson: JSON.stringify(task) });
      return task;
    }),
    getTask: publicProcedure.input(z.object({ taskId: z.string().uuid() })).query(async ({ input }) => {
      const task = await getMailTaskById(input.taskId);
      if (!task) throw new Error("未找到对应的分析任务");
      return task.resultJson ? JSON.parse(task.resultJson) : { task_id: task.taskId, status: task.status, original_filename: task.originalFilename, error_message: task.errorMessage };
    }),
  }),
});

export type AppRouter = typeof appRouter;
