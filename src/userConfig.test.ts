import { describe, expect, it } from "vitest";
import { resolveUserWideDir } from "./userConfig.js";

describe("resolveUserWideDir", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(
      resolveUserWideDir({ env: { XDG_CONFIG_HOME: "/x/cfg" }, home: "/h" }),
    ).toBe("/x/cfg/ccairgap");
  });

  it("falls back to $HOME/.config/ccairgap", () => {
    expect(resolveUserWideDir({ env: {}, home: "/h" })).toBe(
      "/h/.config/ccairgap",
    );
  });

  it("ignores empty XDG_CONFIG_HOME (treat as unset)", () => {
    expect(
      resolveUserWideDir({ env: { XDG_CONFIG_HOME: "" }, home: "/h" }),
    ).toBe("/h/.config/ccairgap");
  });
});
