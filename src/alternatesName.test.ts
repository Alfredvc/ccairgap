import { describe, expect, it } from "vitest";
import { alternatesName } from "./alternatesName.js";

describe("alternatesName", () => {
  it("produces a name of the form <basename>-<8hex>", () => {
    const n = alternatesName("myrepo", "/work/a/myrepo");
    expect(n).toMatch(/^myrepo-[0-9a-f]{8}$/);
  });

  it("returns distinct names for two repos sharing a basename", () => {
    const a = alternatesName("myrepo", "/work/a/myrepo");
    const b = alternatesName("myrepo", "/work/b/myrepo");
    expect(a).not.toBe(b);
  });

  it("is deterministic for the same input", () => {
    const a = alternatesName("myrepo", "/work/a/myrepo");
    const b = alternatesName("myrepo", "/work/a/myrepo");
    expect(a).toBe(b);
  });

  it("sanitises unsafe characters in basenames", () => {
    const n = alternatesName("weird name:1", "/x/weird name:1");
    expect(n).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
  });
});
