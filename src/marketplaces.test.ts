import { describe, expect, it } from "vitest";
import { filterSubsumedMarketplaces } from "./marketplaces.js";

describe("filterSubsumedMarketplaces", () => {
  it("passes marketplaces through when no repos subsume them", () => {
    const r = filterSubsumedMarketplaces(["/mkt/a", "/mkt/b"], ["/repos/x"]);
    expect(r.marketplaces).toEqual(["/mkt/a", "/mkt/b"]);
    expect(r.warnings).toEqual([]);
  });

  it("drops marketplace whose path equals a repo hostPath exactly", () => {
    const r = filterSubsumedMarketplaces(["/work/agentfiles"], ["/work/agentfiles"]);
    expect(r.marketplaces).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("/work/agentfiles");
    expect(r.warnings[0]).toContain("marketplace");
    expect(r.warnings[0]).toContain("committed");
  });

  it("drops marketplace nested inside a repo tree", () => {
    const r = filterSubsumedMarketplaces(
      ["/work/mono/plugins/market"],
      ["/work/mono"],
    );
    expect(r.marketplaces).toEqual([]);
    expect(r.warnings[0]).toContain("/work/mono/plugins/market");
    expect(r.warnings[0]).toContain("/work/mono");
  });

  it("keeps marketplaces that are siblings of repos (not subsumed)", () => {
    const r = filterSubsumedMarketplaces(["/work/marketplaces"], ["/work/repo"]);
    expect(r.marketplaces).toEqual(["/work/marketplaces"]);
    expect(r.warnings).toEqual([]);
  });

  it("does not treat prefix-similar paths as subsumed (path boundary check)", () => {
    const r = filterSubsumedMarketplaces(["/work/repo-plugins"], ["/work/repo"]);
    expect(r.marketplaces).toEqual(["/work/repo-plugins"]);
    expect(r.warnings).toEqual([]);
  });

  it("mentions session-clone HEAD semantics in the warning", () => {
    const r = filterSubsumedMarketplaces(["/work/r"], ["/work/r"]);
    expect(r.warnings[0]).toMatch(/session clone|HEAD|committed/);
  });
});
