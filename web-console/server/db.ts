import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { InsertUser, mailModels, mailTasks, users } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;
const LOCAL_STATE_FILE = process.env.MAIL_ANALYSIS_STATE_FILE || "/var/lib/mail-analysis-console/state.json";

type LocalModel = { id: number; modelJson: string; sampleCount: number; hamCount: number; spamCount: number; isActive: boolean; createdAt: string };
type LocalTask = { taskId: string; taskType: "analysis" | "training"; status: string; originalFilename: string; resultJson?: string; errorMessage?: string; completedAt?: string };
type LocalState = { models: LocalModel[]; tasks: LocalTask[] };

async function readLocalState(): Promise<LocalState> {
  try {
    return JSON.parse(await readFile(LOCAL_STATE_FILE, "utf8")) as LocalState;
  } catch {
    return { models: [], tasks: [] };
  }
}

async function writeLocalState(state: LocalState) {
  await mkdir(dirname(LOCAL_STATE_FILE), { recursive: true });
  await writeFile(LOCAL_STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getActiveMailModel() {
  const db = await getDb();
  if (!db) {
    const state = await readLocalState();
    return [...state.models].reverse().find(model => model.isActive);
  }
  const result = await db.select().from(mailModels).where(eq(mailModels.isActive, true)).orderBy(mailModels.id).limit(1);
  return result[0];
}

export async function saveMailModel(input: { modelJson: string; sampleCount: number; hamCount: number; spamCount: number }) {
  const db = await getDb();
  if (!db) {
    const state = await readLocalState();
    state.models.forEach(model => { model.isActive = false; });
    state.models.push({ ...input, id: (state.models.at(-1)?.id ?? 0) + 1, isActive: true, createdAt: new Date().toISOString() });
    await writeLocalState(state);
    return;
  }
  await db.update(mailModels).set({ isActive: false }).where(eq(mailModels.isActive, true));
  await db.insert(mailModels).values({ ...input, isActive: true });
}

export async function saveMailTask(input: { taskId: string; taskType: "analysis" | "training"; status: string; originalFilename: string; resultJson?: string; errorMessage?: string }) {
  const db = await getDb();
  if (!db) {
    const state = await readLocalState();
    state.tasks.push({ ...input, completedAt: input.status === "completed" ? new Date().toISOString() : undefined });
    await writeLocalState(state);
    return;
  }
  await db.insert(mailTasks).values({ ...input, completedAt: input.status === "completed" ? new Date() : null });
}

export async function getMailTaskById(taskId: string) {
  const db = await getDb();
  if (!db) return (await readLocalState()).tasks.find(task => task.taskId === taskId);
  const result = await db.select().from(mailTasks).where(eq(mailTasks.taskId, taskId)).limit(1);
  return result[0];
}
