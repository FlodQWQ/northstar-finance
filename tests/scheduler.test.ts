import { describe, expect, it } from "vitest";
import { calculateNextRunAt } from "../server/services/scheduler";
import { DomainError } from "../server/services/repository";

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
