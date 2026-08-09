import { randomUUID } from "node:crypto";
import type { AIProvider, ResearchResult } from "../providers/ai";
import type { SqliteDatabase } from "../db/database";
import type { MonitorRun } from "../../shared/types";
import type { EmailOutbox } from "./email";
import { FinanceRepository, mapMonitorRun } from "./repository";

type Row = Record<string, unknown>;

export class MonitorService {
  public constructor(
    private readonly db: SqliteDatabase,
    private readonly repository: FinanceRepository,
    private readonly aiProvider: AIProvider,
    private readonly emailOutbox: EmailOutbox,
  ) {}

  private createRun(input: {
    targetType: "event" | "expected";
    targetId: string;
    scheduledFor: string;
    resumeExisting?: boolean;
  }): { runId: string; existing?: MonitorRun } {
    const dedupeKey = `${input.targetType}:${input.targetId}:${input.scheduledFor}`;
    const existing = this.db.prepare(`
      SELECT * FROM monitor_runs WHERE owner_id = ? AND dedupe_key = ?
    `).get(this.repository.ownerId, dedupeKey) as
      | Row
      | undefined;
    if (existing) {
      const status = String(existing.status);
      if (input.resumeExisting && (status === "queued" || status === "running")) {
        return { runId: String(existing.id) };
      }
      return { runId: String(existing.id), existing: mapMonitorRun(existing) };
    }
    const runId = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO monitor_runs (
        id, owner_id, target_type, event_id, expected_asset_id, status, scheduled_for,
        started_at, finished_at, summary, change_summary, sources_json,
        provider, email_status, error, dedupe_key, created_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, '', '', '[]', ?, 'skipped', '', ?, ?)
    `).run(
      runId,
      this.repository.ownerId,
      input.targetType,
      input.targetType === "event" ? input.targetId : null,
      input.targetType === "expected" ? input.targetId : null,
      input.scheduledFor,
      this.aiProvider.id,
      dedupeKey,
      now,
    );
    return { runId };
  }

  private completeRun(runId: string, result: ResearchResult, status: "success" | "no_change"): void {
    this.db.prepare(`
      UPDATE monitor_runs
      SET status = ?, finished_at = ?, summary = ?, change_summary = ?,
          sources_json = ?, provider = ?, error = ''
      WHERE owner_id = ? AND id = ?
    `).run(
      status,
      new Date().toISOString(),
      result.summary,
      result.changeSummary,
      JSON.stringify(
        result.searchEvidence
          ? { sources: result.sources, searchEvidence: result.searchEvidence }
          : result.sources,
      ),
      result.provider ?? this.aiProvider.id,
      this.repository.ownerId,
      runId,
    );
  }

  private failRun(runId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : "Unknown research error";
    this.db.prepare(`
      UPDATE monitor_runs
      SET status = 'failed', finished_at = ?, provider = ?, error = ?
      WHERE owner_id = ? AND id = ?
    `).run(
      new Date().toISOString(),
      this.aiProvider.id,
      message.slice(0, 4_000),
      this.repository.ownerId,
      runId,
    );
  }

  public async runEvent(
    eventId: string,
    scheduledFor = new Date().toISOString(),
    resumeExisting = false,
  ): Promise<MonitorRun> {
    const event = this.repository.getEvent(eventId);
    const created = this.createRun({
      targetType: "event",
      targetId: eventId,
      scheduledFor,
      resumeExisting,
    });
    if (created.existing) return created.existing;
    const startedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE monitor_runs SET status = 'running', started_at = ?
      WHERE owner_id = ? AND id = ?
    `).run(startedAt, this.repository.ownerId, created.runId);

    try {
      const result = await this.aiProvider.research({
        targetType: "event",
        targetId: event.id,
        title: event.name,
        topic: event.topic,
        instructions: event.instructions,
        previousSummary: event.lastSummary,
      });
      const status = result.changed ? "success" : "no_change";
      this.completeRun(created.runId, result, status);
      this.db.prepare(`
        UPDATE tracked_events
        SET last_run_at = ?, last_run_status = ?, last_summary = ?,
            version = version + 1, updated_at = ?
        WHERE owner_id = ? AND id = ?
      `).run(
        startedAt,
        status,
        result.summary,
        new Date().toISOString(),
        this.repository.ownerId,
        eventId,
      );

      const shouldEmail = event.emailEnabled && (!event.notifyOnChangeOnly || result.changed);
      if (shouldEmail) {
        this.emailOutbox.enqueue({
          runId: created.runId,
          recipient: event.emailTo,
          subject: `[Northstar] ${event.name}`,
          body: `${result.summary}\n\n${result.changeSummary}\n\n${result.sources
            .map((source) => `${source.title}: ${source.url}`)
            .join("\n")}`,
        });
      }
    } catch (error) {
      this.failRun(created.runId, error);
      this.db.prepare(`
        UPDATE tracked_events
        SET last_run_at = ?, last_run_status = 'failed',
            version = version + 1, updated_at = ?
        WHERE owner_id = ? AND id = ?
      `).run(startedAt, new Date().toISOString(), this.repository.ownerId, eventId);
    }
    return this.repository.getRun(created.runId);
  }

  public async runExpectedCheck(
    expectedAssetId: string,
    scheduledFor = new Date().toISOString(),
    resumeExisting = false,
  ): Promise<MonitorRun> {
    const expected = this.repository.getExpectedAsset(expectedAssetId);
    const created = this.createRun({
      targetType: "expected",
      targetId: expectedAssetId,
      scheduledFor,
      resumeExisting,
    });
    if (created.existing) return created.existing;
    const startedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE monitor_runs SET status = 'running', started_at = ?
      WHERE owner_id = ? AND id = ?
    `).run(startedAt, this.repository.ownerId, created.runId);

    try {
      const result = await this.aiProvider.research({
        targetType: "expected",
        targetId: expected.id,
        title: expected.name,
        topic: `${expected.category} ${expected.ecosystem}`.trim(),
        instructions: `Check current status and material news. Next action: ${expected.nextAction}`,
        previousSummary: expected.latestUpdate,
        sourceUrl: expected.sourceUrl,
        keywords: expected.keywords,
      });
      const status = result.changed ? "success" : "no_change";
      const now = new Date().toISOString();
      const nextCheck = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const write = this.db.transaction(() => {
        this.completeRun(created.runId, result, status);
        this.db.prepare(`
          INSERT INTO asset_updates (
            id, owner_id, expected_asset_id, update_type, title, summary, source_url,
            provider, published_at, created_at
          ) VALUES (?, ?, ?, 'research', ?, ?, ?, ?, NULL, ?)
        `).run(
          randomUUID(),
          this.repository.ownerId,
          expectedAssetId,
          result.changed ? "Research update" : "Research check: no change",
          result.summary,
          result.sources[0]?.url ?? expected.sourceUrl,
          result.provider ?? this.aiProvider.id,
          now,
        );
        // The AI result updates research metadata only. It cannot alter stage, value, or holdings.
        this.db.prepare(`
          UPDATE expected_assets
          SET latest_update = ?, last_checked_at = ?, next_check_at = ?, health = 'healthy',
              version = version + 1, updated_at = ?
          WHERE owner_id = ? AND id = ?
        `).run(result.summary, now, nextCheck, now, this.repository.ownerId, expectedAssetId);
      });
      write();
    } catch (error) {
      this.failRun(created.runId, error);
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE expected_assets
        SET last_checked_at = ?, health = 'failed', version = version + 1, updated_at = ?
        WHERE owner_id = ? AND id = ?
      `).run(now, now, this.repository.ownerId, expectedAssetId);
    }
    return this.repository.getRun(created.runId);
  }

  public async recoverInterruptedRuns(cutoff: Date): Promise<void> {
    const rows = this.db.prepare(`
      SELECT id, target_type, event_id, expected_asset_id, scheduled_for
      FROM monitor_runs
      WHERE owner_id = ? AND status IN ('queued', 'running')
        AND COALESCE(started_at, created_at) <= ?
      ORDER BY created_at
      LIMIT 20
    `).all(this.repository.ownerId, cutoff.toISOString()) as Array<{
      id: string;
      target_type: "event" | "expected";
      event_id: string | null;
      expected_asset_id: string | null;
      scheduled_for: string;
    }>;

    for (const row of rows) {
      const targetId = row.target_type === "event" ? row.event_id : row.expected_asset_id;
      if (!targetId) {
        this.db.prepare(`
          UPDATE monitor_runs
          SET status = 'failed', finished_at = ?, error = 'Target was deleted before recovery'
          WHERE owner_id = ? AND id = ?
        `).run(new Date().toISOString(), this.repository.ownerId, row.id);
        continue;
      }
      this.db.prepare(`
        UPDATE monitor_runs
        SET status = 'queued', started_at = NULL, finished_at = NULL,
            error = 'Recovered after an interrupted worker lease'
        WHERE owner_id = ? AND id = ? AND status IN ('queued', 'running')
      `).run(this.repository.ownerId, row.id);
      if (row.target_type === "event") {
        await this.runEvent(targetId, row.scheduled_for, true);
      } else {
        await this.runExpectedCheck(targetId, row.scheduled_for, true);
      }
    }
  }
}
