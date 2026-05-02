import { describe, expect, it } from "vitest";
import { mergeLayers } from "./configLayered.js";

describe("mergeLayers", () => {
  it("scalars: project wins over user-wide; user-wide wins over integration", () => {
    const r = mergeLayers({
      integrations: [{ filename: "a.yaml", config: { name: "int" } }],
      userWide: { name: "uw" },
      project: { name: "proj" },
    });
    expect(r.merged.name).toBe("proj");
    expect(r.provenance.name).toBe("project");
  });

  it("scalars: user-wide wins when project absent", () => {
    const r = mergeLayers({
      integrations: [],
      userWide: { name: "uw" },
      project: undefined,
    });
    expect(r.merged.name).toBe("uw");
    expect(r.provenance.name).toBe("user-wide");
  });

  it("scalars: integration wins when user-wide and project absent", () => {
    const r = mergeLayers({
      integrations: [{ filename: "a.yaml", config: { hooks: { enable: ["x"] } } }],
      userWide: undefined,
      project: undefined,
    });
    expect(r.merged.hooks?.enable).toEqual(["x"]);
  });

  it("arrays: concat in load order, no dedup", () => {
    const r = mergeLayers({
      integrations: [
        { filename: "a.yaml", config: { dockerRunArg: ["a1"] } },
        { filename: "b.yaml", config: { dockerRunArg: ["b1"] } },
      ],
      userWide: { dockerRunArg: ["uw1"] },
      project: { dockerRunArg: ["p1"] },
    });
    expect(r.merged.dockerRunArg).toEqual(["a1", "b1", "uw1", "p1"]);
    expect(r.provenance.dockerRunArg).toEqual([
      "user-wide-integration:a.yaml",
      "user-wide-integration:b.yaml",
      "user-wide",
      "project",
    ]);
  });

  it("hooks.enable: concat across layers", () => {
    const r = mergeLayers({
      integrations: [
        { filename: "a.yaml", config: { hooks: { enable: ["a-*"] } } },
      ],
      userWide: { hooks: { enable: ["uw-*"] } },
      project: { hooks: { enable: ["p-*"] } },
    });
    expect(r.merged.hooks?.enable).toEqual(["a-*", "uw-*", "p-*"]);
  });

  it("dockerBuildArg: per-key merge, project wins on collision", () => {
    const r = mergeLayers({
      integrations: [],
      userWide: { dockerBuildArg: { K: "uw", U: "uw" } },
      project: { dockerBuildArg: { K: "p", P: "p" } },
    });
    expect(r.merged.dockerBuildArg).toEqual({ K: "p", U: "uw", P: "p" });
  });
});
