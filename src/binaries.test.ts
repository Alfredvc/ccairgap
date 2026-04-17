import { describe, expect, it } from "vitest";
import { checkHostBinary, requireHostBinaries } from "./binaries.js";

describe("checkHostBinary", () => {
  it("resolves a binary that is on PATH", async () => {
    // `sh` is guaranteed on macOS + Linux CI; the function itself runs via sh
    // so if this test can run, sh exists.
    const r = await checkHostBinary("sh");
    expect(r.ok).toBe(true);
    expect(r.name).toBe("sh");
    expect(r.detail.length).toBeGreaterThan(0);
  });

  it("reports missing for a binary that does not exist", async () => {
    const r = await checkHostBinary("ccairgap-nonexistent-xyzzy");
    expect(r.ok).toBe(false);
    expect(r.name).toBe("ccairgap-nonexistent-xyzzy");
  });
});

describe("requireHostBinaries", () => {
  it("resolves when all binaries present", async () => {
    await expect(requireHostBinaries(["sh"])).resolves.toBeUndefined();
  });

  it("throws with every missing binary named", async () => {
    await expect(
      requireHostBinaries(["sh", "ccairgap-missing-a", "ccairgap-missing-b"]),
    ).rejects.toThrow(/ccairgap-missing-a, ccairgap-missing-b/);
  });
});
