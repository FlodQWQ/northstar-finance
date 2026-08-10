import { describe, expect, it } from "vitest";
import { openDatabase } from "../server/db/database";
import { MockAIProvider } from "../server/providers/ai";
import type { EmailOutbox } from "../server/services/email";
import { AuthService } from "../server/services/auth";
import { MonitorService } from "../server/services/monitor";
import { DomainError, FinanceRepository } from "../server/services/repository";
import { calculateNextRunAt, PersistentScheduler } from "../server/services/scheduler";
import { eventCreateSchema } from "../server/validation";

describe("calculateNextRunAt", () => {
  it("converts an Asia/Shanghai wall-clock schedule to UTC", () => {
    const nextRun = calculateNextRunAt(
      "0 9 * * *",
      "Asia/Shanghai",
      new Date("2026-08-08T02:00:00.000Z"),
    );

    expect(nextRun).toBe("2026-08-09T01:00:00.000Z");
  });

  it.each([
    ["not-a-cron", "Asia/Shanghai"],
    ["0 9 * * *", "Mars/Olympus"],
  ])("rejects invalid schedule configuration", (expression, timezone) => {
    expect(() => calculateNextRunAt(expression, timezone)).toThrowError(DomainError);
    expect(() => calculateNextRunAt(expression, timezone)).toThrow(/Invalid schedule/);
  });
});

describe("PersistentScheduler tenant isolation", () => {
  it("runs due events for multiple owners without mixing repositories or run rows", async () => {
    const db = openDatabase({ path: ":memory:", seed: false });
    const auth = new AuthService(db, {
      passwordHash: { cost: 1_024, maxmem: 16 * 1024 * 1024 },
    });
    const provider = new MockAIProvider();
    const emailOutbox: EmailOutbox = {
      enqueue: () => "skipped",
      processDue: async () => undefined,
      testConnection: async () => ({ ok: true, status: "connected", message: "test" }),
    };

    try {
      const alice = await auth.register({
        username: "scheduler-alice",
        password: "correct horse battery staple",
      });
      const bob = await auth.register({
        username: "scheduler-bob",
        password: "correct horse battery staple",
      });
      db.prepare("UPDATE users SET status = 'active' WHERE id IN (?, ?)")
        .run(alice.id, bob.id);
      const dueAt = "2026-08-10T00:00:00.000Z";
      const createEvent = (ownerId: string, id: string, name: string) => {
        const repository = new FinanceRepository(db, ownerId);
        repository.createEvent(eventCreateSchema.parse({
          id,
          name,
          topic: `${name} private topic`,
          instructions: "Check this owner's private sources.",
          schedule: "0 9 * * *",
          timezone: "Asia/Shanghai",
          nextRunAt: dueAt,
        }), dueAt);
      };
      createEvent(alice.id, "alice-due-event", "Alice event");
      createEvent(bob.id, "bob-due-event", "Bob event");

      const scheduler = new PersistentScheduler(
        db,
        (ownerId) => {
          const repository = new FinanceRepository(db, ownerId);
          return new MonitorService(db, repository, provider, emailOutbox);
        },
        () => emailOutbox,
      );
      await scheduler.tick(new Date("2026-08-10T00:00:01.000Z"));

      const rows = db.prepare(`
        SELECT owner_id, event_id, summary FROM monitor_runs ORDER BY owner_id
      `).all() as Array<{ owner_id: string; event_id: string; summary: string }>;
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          owner_id: alice.id,
          event_id: "alice-due-event",
          summary: expect.stringContaining("Alice event"),
        }),
        expect.objectContaining({
          owner_id: bob.id,
          event_id: "bob-due-event",
          summary: expect.stringContaining("Bob event"),
        }),
      ]));
      expect(new FinanceRepository(db, alice.id).listEventRuns("alice-due-event")).toHaveLength(1);
      expect(new FinanceRepository(db, bob.id).listEventRuns("bob-due-event")).toHaveLength(1);
      expect(() => new FinanceRepository(db, bob.id).listEventRuns("alice-due-event"))
        .toThrowError(expect.objectContaining({ code: "EVENT_NOT_FOUND" }));
    } finally {
      db.close();
    }
  });
});
