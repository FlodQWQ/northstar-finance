import { Cron } from "croner";
import type { SqliteDatabase } from "../db/database";
import type { EmailOutbox } from "./email";
import type { MonitorService } from "./monitor";
import { DomainError } from "./repository";

interface DueEventRow {
  id: string;
  owner_id: string;
  schedule: string;
  timezone: string;
  next_run_at: string;
}

interface DueExpectedRow {
  id: string;
  owner_id: string;
  next_check_at: string;
}

type MonitorServiceFactory = (ownerId: string) => MonitorService;
type EmailOutboxFactory = (ownerId: string) => EmailOutbox;

export function calculateNextRunAt(
  expression: string,
  timezone: string,
  after = new Date(),
): string | null {
  try {
    const cron = new Cron(expression, { paused: true, timezone });
    const next = cron.nextRun(after);
    cron.stop();
    return next?.toISOString() ?? null;
  } catch (error) {
    throw new DomainError(
      error instanceof Error ? `Invalid schedule: ${error.message}` : "Invalid schedule",
      400,
      "INVALID_SCHEDULE",
    );
  }
}

export class PersistentScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly monitorServiceFor: MonitorServiceFactory,
    private readonly emailOutboxFor: EmailOutboxFactory,
    private readonly pollMs = Number(process.env.SCHEDULER_POLL_MS ?? 30_000),
  ) {}

  public start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(1_000, this.pollMs));
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const nowIso = now.toISOString();
    try {
      const leaseMs = Number(process.env.SCHEDULER_LEASE_MS ?? 10 * 60 * 1000);
      const owners = this.db.prepare(`
        SELECT id FROM users WHERE status = 'active' ORDER BY created_at
      `).all() as Array<{ id: string }>;

      for (const owner of owners) {
        const monitorService = this.monitorServiceFor(owner.id);
        await monitorService.recoverInterruptedRuns(new Date(now.getTime() - leaseMs));

        const events = this.db.prepare(`
          SELECT id, owner_id, schedule, timezone, next_run_at
          FROM tracked_events
          WHERE owner_id = ? AND status = 'active'
            AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at LIMIT 20
        `).all(owner.id, nowIso) as DueEventRow[];

        for (const event of events) {
          let nextRunAt: string | null;
          try {
            nextRunAt = calculateNextRunAt(event.schedule, event.timezone, new Date(now.getTime() + 1_000));
          } catch {
            this.db.prepare(`
              UPDATE tracked_events
              SET status = 'paused', last_run_status = 'failed',
                  last_summary = 'Schedule is invalid', updated_at = ?, version = version + 1
              WHERE owner_id = ? AND id = ? AND next_run_at = ?
            `).run(nowIso, owner.id, event.id, event.next_run_at);
            continue;
          }
          const claimed = this.db.prepare(`
            UPDATE tracked_events SET next_run_at = ?, updated_at = ?, version = version + 1
            WHERE owner_id = ? AND id = ? AND next_run_at = ? AND status = 'active'
          `).run(nextRunAt, nowIso, owner.id, event.id, event.next_run_at);
          if (claimed.changes === 1) {
            await monitorService.runEvent(event.id, event.next_run_at);
          }
        }

        const expectedAssets = this.db.prepare(`
          SELECT id, owner_id, next_check_at FROM expected_assets
          WHERE owner_id = ?
            AND stage NOT IN ('claimed', 'missed', 'expired', 'rejected')
            AND next_check_at <= ?
          ORDER BY next_check_at LIMIT 20
        `).all(owner.id, nowIso) as DueExpectedRow[];
        for (const expected of expectedAssets) {
          const claimedNextCheck = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
          const claimed = this.db.prepare(`
            UPDATE expected_assets
            SET next_check_at = ?, health = 'due', updated_at = ?, version = version + 1
            WHERE owner_id = ? AND id = ? AND next_check_at = ?
          `).run(claimedNextCheck, nowIso, owner.id, expected.id, expected.next_check_at);
          if (claimed.changes === 1) {
            await monitorService.runExpectedCheck(expected.id, expected.next_check_at);
          }
        }

        await this.emailOutboxFor(owner.id).processDue();
      }
    } finally {
      this.ticking = false;
    }
  }
}
