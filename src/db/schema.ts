import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import type {
  AiReviewSkip,
  CategoryScores,
  CategorySummaries,
  ReportIssue,
} from "@/lib/analysis/report-types";
import { EMBEDDING_DIMENSIONS } from "@/modules/ingestion";

// Enums

export const planEnum = pgEnum("plan", ["free", "premium"]);

export const planStatusEnum = pgEnum("plan_status", [
  "none",
  "active",
  "past_due",
  "canceled",
]);

export const projectSourceEnum = pgEnum("project_source", ["github", "upload"]);

export const projectStatusEnum = pgEnum("project_status", [
  "queued",
  "processing",
  "completed",
  "failed",
]);

// Helpers

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

// Tables

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  passwordHash: text("password_hash"),

  authProvider: text("auth_provider"), // google | email | github
  githubAccessToken: text("github_access_token"),
  githubUsername: text("github_username"),

  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  stripePriceId: text("stripe_price_id"),
  plan: planEnum("plan").default("free").notNull(),
  planStatus: planStatusEnum("plan_status").default("none").notNull(),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // analysis
    createdAt: createdAt(),
  },
  (t) => [index("usage_events_user_id_type_created_at_idx").on(t.userId, t.type, t.createdAt)],
).enableRLS();

// Fixed-window counters shared by every serverless instance (replaces the
// tutorial's in-memory Map). `key` is a SHA-256 hash, so no emails/IPs are stored.
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).defaultNow().notNull(),
}).enableRLS();

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [unique("accounts_provider_provider_account_id_key").on(t.provider, t.providerAccountId)],
).enableRLS();

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionToken: text("session_token").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
}).enableRLS();

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull().unique(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [unique("verification_tokens_identifier_token_key").on(t.identifier, t.token)],
).enableRLS();

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    source: projectSourceEnum("source").notNull(),
    repositoryUrl: text("repository_url"),
    framework: text("framework"),
    status: projectStatusEnum("status").default("queued").notNull(),
    errorMessage: text("error_message"),
    fileCount: integer("file_count").default(0).notNull(),
    progressStep: text("progress_step"),
    progressPercent: integer("progress_percent").notNull(),
    // The analysis workflow run that owns this project while "processing"
    // (ADR-005): asked for its status instead of guessing from updatedAt.
    // Null before the run starts, for imports and for older projects.
    analysisRunId: text("analysis_run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_user_id_idx").on(t.userId)],
).enableRLS();

// Extracted files of a project (replaces the tutorial's local .data/ folder,
// which does not survive or get shared across serverless instances).
export const projectFiles = pgTable(
  "project_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    relativePath: text("relative_path").notNull(),
    content: text("content").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("project_files_project_id_relative_path_key").on(t.projectId, t.relativePath),
  ],
).enableRLS();

export const codeChunks = pgTable(
  "code_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    content: text("content").notNull(),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    // TD-03: what the vector was made from and by which model. A rebuild
    // reuses vectors with the same hash and model; a model change re-embeds.
    // Null for chunks stored before migration 0008 (embedded again once).
    contentHash: text("content_hash"),
    embeddingModel: text("embedding_model"),
  },
  (t) => [index("code_chunks_project_id_idx").on(t.projectId)],
).enableRLS();

// Shape written by the report step: scores, per-category summaries and, when
// the report came out without the AI review, why (graceful degradation).
type StoredCategoryScores = CategoryScores & {
  summaries?: CategorySummaries;
  aiReviewSkipped?: AiReviewSkip;
};

/**
 * The LLM review behind a report, kept so that re-analyzing the same code
 * reuses it instead of asking again (TD-43): the model's answers vary between
 * runs, so a new call could change the score with no code change.
 * `inputHash` covers everything the model receives.
 */
export type StoredLlmReview = {
  inputHash: string;
  architectureSummary: string;
  securitySummary: string;
  performanceSummary: string;
  issues: ReportIssue[];
};

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  healthScore: integer("health_score").notNull(),
  categoryScores: jsonb("category_scores").$type<StoredCategoryScores>().notNull(),
  issues: jsonb("issues").$type<ReportIssue[]>().notNull(),
  // Null for reports from before TD-43: the next analysis calls the LLM.
  llmReview: jsonb("llm_review").$type<StoredLlmReview>(),
  createdAt: createdAt(),
}).enableRLS();

// Public read-only link to a project's report. One per project (a new link
// replaces the old one). Only the SHA-256 of the token is stored: the link
// itself is shown to the owner once. Null expiresAt = no expiry (revocable).
export const reportShares = pgTable("report_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
}).enableRLS();

export const llmFeatureEnum = pgEnum("llm_feature", ["report", "chat", "explain"]);

// One row per LLM call (roadmap Phase 4): counts only, never the prompt or
// the answer. The project link is cleared, not cascaded, when a project is
// deleted: the user's spending of the day must not disappear with it.
// costMicroUsd is the estimate at the provider's list price (null for a
// model without a known price).
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    feature: llmFeatureEnum("feature").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    ok: boolean("ok").notNull(),
    costMicroUsd: integer("cost_micro_usd"),
    createdAt: createdAt(),
  },
  (t) => [index("llm_calls_user_id_created_at_idx").on(t.userId, t.createdAt)],
).enableRLS();

// Kill switches (roadmap Phase 4): turn an LLM feature off without a deploy.
// No row = on. Flipped with SQL, see docs/runbooks/llm-kill-switch.md.
export const llmSwitches = pgTable("llm_switches", {
  feature: llmFeatureEnum("feature").primaryKey(),
  enabled: boolean("enabled").notNull(),
  updatedAt: updatedAt(),
}).enableRLS();

// Relations

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  projects: many(projects),
  usageEvents: many(usageEvents),
}));

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  user: one(users, { fields: [usageEvents.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
  files: many(projectFiles),
  chunks: many(codeChunks),
  report: one(reports),
}));

export const projectFilesRelations = relations(projectFiles, ({ one }) => ({
  project: one(projects, { fields: [projectFiles.projectId], references: [projects.id] }),
}));

// Vectors embedded in batches across workflow steps (ADR-006, TD-46), kept
// until the last step swaps the project's knowledge at once and clears
// them. Keyed like the reuse in code_chunks: same text, same model.
export const embeddingCache = pgTable(
  "embedding_cache",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("embedding_cache_key").on(t.projectId, t.contentHash, t.embeddingModel)],
).enableRLS();

export const codeChunksRelations = relations(codeChunks, ({ one }) => ({
  project: one(projects, { fields: [codeChunks.projectId], references: [projects.id] }),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  project: one(projects, { fields: [reports.projectId], references: [projects.id] }),
}));
