import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAssetIconFallback, resolveAssetIcon } from "../src/assetIcons";

describe("asset icon resolution", () => {
  it.each([
    ["BTC", "BTC"],
    ["ETH", "ETH"],
    ["USDT", "USDT"],
    ["OKB", "OKB"],
    ["CFX", "CFX"],
    ["XPL", "XPL"],
    ["SOL", "SOL"],
    ["XAUT", "XAUT"],
    ["U", "U"],
    ["NVDAon", "NVDAON"],
    ["QQQon", "QQQON"],
    ["IBMon", "IBMON"],
    ["preOPAI", "PREOPAI"],
    ["spSEI", "SPSEI"],
    ["USD1", "USD1"],
    ["RLUSD", "RLUSD"],
    ["sUSDat", "SUSDAT"],
  ])("maps %s to its canonical icon", (symbol, key) => {
    const icon = resolveAssetIcon({ symbol });
    expect(icon?.key).toBe(key);
    expect(existsSync(path.join(process.cwd(), "public", icon?.path || "missing"))).toBe(true);
  });

  it("reuses the USDT icon for the debt holding", () => {
    expect(resolveAssetIcon({ symbol: "usdt debt" })?.key).toBe("USDT");
  });

  it("recognizes the imported blank Gate stablecoin from its denomination", () => {
    expect(resolveAssetIcon({ symbol: "", name: "", currency: "USDT" })?.key).toBe("USDT");
  });

  it("does not confuse United Stables with Tether", () => {
    expect(resolveAssetIcon({ symbol: "U" })?.key).toBe("U");
    expect(resolveAssetIcon({ symbol: "U" })?.path).toContain("/u.jpg");
  });

  it.each(["rNVDA", "xNVDA", "rQQQ", "xQQQ"])("does not alias the separate %s product", (symbol) => {
    expect(resolveAssetIcon({ symbol })).toBeNull();
  });

  it("uses exact project names for expected assets and falls back for unknown names", () => {
    expect(resolveAssetIcon({ name: "Splashing Staked SEI" })?.key).toBe("SPSEI");
    expect(resolveAssetIcon({ name: "NVIDIA (Ondo Tokenized Stock)" })?.key).toBe("NVDAON");
    expect(resolveAssetIcon({ name: "OpenAI (Republic Pre-IPO)" })?.key).toBe("PREOPAI");
    expect(resolveAssetIcon({ name: "Unlisted Campaign" })).toBeNull();
    expect(resolveAssetIcon({ name: "未知资产", currency: "USDT" })).toBeNull();
    expect(getAssetIconFallback({ name: "Unlisted Campaign" })).toBe("UN");
  });
});
