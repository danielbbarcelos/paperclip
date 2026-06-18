import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { logger } from "../middleware/logger.js";

export type SoftDeletePurgeResult = {
  issuesPurged: number;
  companiesPurged: number;
  attachmentObjectsDeleted: number;
};

/**
 * Permanently delete records that were soft-deleted longer than `graceDays` ago.
 *
 * Order matters: issues are purged first (cleaning their attachment object
 * storage on the way out, which the soft-delete path deferred), then companies
 * run their full cascade. A company's own issues are purged as part of the
 * company cascade regardless, so the grace window is the same for both.
 */
export async function runSoftDeletePurge(
  db: Db,
  storage: StorageService | undefined,
  graceDays: number,
  now: Date = new Date(),
): Promise<SoftDeletePurgeResult> {
  const cutoff = new Date(now.getTime() - Math.max(0, graceDays) * 24 * 60 * 60 * 1000);
  // Imported lazily so wiring the purge timer into server startup does not pull
  // the full company/issue service graph into the startup module-eval path.
  const [{ companyService }, { issueService }] = await Promise.all([
    import("./companies.js"),
    import("./issues.js"),
  ]);
  const issues = issueService(db);
  const companies = companyService(db);

  let issuesPurged = 0;
  let attachmentObjectsDeleted = 0;

  const dueIssues = await issues.listSoftDeletedBefore(cutoff);
  for (const { id, companyId } of dueIssues) {
    try {
      // Collect attachment object keys BEFORE the hard delete removes the rows,
      // then tear down storage after the DB cascade succeeds.
      const attachments = storage ? await issues.listAttachments(id) : [];
      await issues.hardRemove(id);
      issuesPurged += 1;
      for (const attachment of attachments) {
        try {
          await storage!.deleteObject(attachment.companyId, attachment.objectKey);
          attachmentObjectsDeleted += 1;
        } catch (err) {
          logger.warn(
            { err, issueId: id, attachmentId: attachment.id },
            "soft-delete purge: failed to delete attachment object",
          );
        }
      }
    } catch (err) {
      logger.error({ err, issueId: id, companyId }, "soft-delete purge: issue hard delete failed");
    }
  }

  const companiesPurged = await companies.purgeDeleted(cutoff);

  if (issuesPurged > 0 || companiesPurged > 0) {
    logger.info(
      { issuesPurged, companiesPurged, attachmentObjectsDeleted, graceDays },
      "soft-delete purge sweep complete",
    );
  }
  return { issuesPurged, companiesPurged, attachmentObjectsDeleted };
}

/**
 * Run a purge sweep daily. Returns a stop function. The first sweep runs after
 * one interval (not immediately at boot) to avoid competing with startup work.
 */
export function startSoftDeletePurgeTimer(
  db: Db,
  storage: StorageService | undefined,
  graceDays: number,
  intervalMs: number = 24 * 60 * 60 * 1000,
): () => void {
  const timer = setInterval(() => {
    void runSoftDeletePurge(db, storage, graceDays).catch((err) => {
      logger.error({ err }, "soft-delete purge sweep failed");
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
