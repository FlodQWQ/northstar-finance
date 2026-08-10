import { describe, expect, it } from "vitest";
import { formatCompactMoney, formatMoney } from "../src/utils";

describe("money formatting", () => {
  it("formats non-ISO asset denominations without throwing", () => {
    expect(formatMoney("12345.67", "USDT")).toMatch(/USDT$/);
    expect(formatCompactMoney("12345.67", "USDT")).toMatch(/USDT$/);
  });

  it("keeps ISO currencies in currency style", () => {
    expect(formatMoney("123.45", "USD")).toContain("US$");
    expect(formatCompactMoney("12345", "USD")).toContain("US$");
  });

  it("returns a stable placeholder for invalid values", () => {
    expect(formatCompactMoney("not-a-number", "USDT")).toBe("-- USDT");
  });
});
