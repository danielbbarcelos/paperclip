import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { issueService } from "../services/issues.js";
import { runSoftDeletePurge } from "../services/soft-delete-purge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ACTOR = { actorType: "user" as const, actorId: "user-1", agentId: null, runId: null };

describeEmbeddedPostgres("soft delete (companies & issues)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-soft-delete-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // activity_log references companies; clear it first to avoid FK violations
    // when tearing down (soft delete writes an audit entry there).
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany() {
    return db
      .insert(companies)
      .values({ name: `Co ${randomUUID()}`, issuePrefix: `SD${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function makeIssue(companyId: string) {
    return db
      .insert(issues)
      .values({ companyId, title: `Issue ${randomUUID()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("soft-deletes a company: hidden from reads, row retained, status=deleted", async () => {
    const company = await makeCompany();
    const svc = companyService(db);

    const removed = await svc.remove(company.id, ACTOR);
    expect(removed?.id).toBe(company.id);

    // Hidden from the service reads.
    expect(await svc.getById(company.id)).toBeNull();
    expect((await svc.list()).some((c) => c.id === company.id)).toBe(false);

    // But the row is retained (recoverable) with deletion metadata.
    const raw = await db.select().from(companies).where(eq(companies.id, company.id)).then((r) => r[0]!);
    expect(raw.deletedAt).not.toBeNull();
    expect(raw.status).toBe("deleted");
    expect(raw.deletedByUserId).toBe("user-1");

    // Deleting again is idempotent (already deleted -> null).
    expect(await svc.remove(company.id, ACTOR)).toBeNull();
  });

  it("soft-deletes an issue: hidden from reads, row retained, status=cancelled", async () => {
    const company = await makeCompany();
    const issue = await makeIssue(company.id);
    const svc = issueService(db);

    const removed = await svc.remove(issue.id, ACTOR);
    expect(removed?.id).toBe(issue.id);

    expect(await svc.getById(issue.id)).toBeNull();
    expect((await svc.list(company.id)).some((i) => i.id === issue.id)).toBe(false);

    const raw = await db.select().from(issues).where(eq(issues.id, issue.id)).then((r) => r[0]!);
    expect(raw.deletedAt).not.toBeNull();
    expect(raw.status).toBe("cancelled");
    expect(raw.deletedByUserId).toBe("user-1");
  });

  it("purge hard-deletes records past the grace window", async () => {
    const company = await makeCompany();
    const issue = await makeIssue(company.id);
    await issueService(db).remove(issue.id, ACTOR);
    await companyService(db).remove(company.id, ACTOR);

    // grace=0 with a now slightly in the future so the just-deleted rows are due.
    const future = new Date(Date.now() + 60_000);
    const result = await runSoftDeletePurge(db, undefined, 0, future);
    expect(result.issuesPurged).toBeGreaterThanOrEqual(1);
    expect(result.companiesPurged).toBe(1);

    // Rows are gone from the database.
    expect(await db.select().from(companies).where(eq(companies.id, company.id))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.id, issue.id))).toHaveLength(0);
  });

  it("purge leaves records still inside the grace window untouched", async () => {
    const company = await makeCompany();
    await companyService(db).remove(company.id, ACTOR);

    // grace=30 days, now = real now -> nothing is due yet.
    const result = await runSoftDeletePurge(db, undefined, 30);
    expect(result.companiesPurged).toBe(0);
    expect(await db.select().from(companies).where(eq(companies.id, company.id))).toHaveLength(1);
  });
});
