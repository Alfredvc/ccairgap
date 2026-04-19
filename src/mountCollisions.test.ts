import { describe, expect, it } from "vitest";
import { resolveMountCollisions, reservedContainerPaths } from "./mountCollisions.js";
import type { Mount } from "./mounts.js";

const HOME_IN_CONTAINER = "/home/claude";

const repoMount = (hostPath: string, src = hostPath + "/.clone"): Mount => ({
  src,
  dst: hostPath,
  mode: "rw",
  source: { kind: "repo", hostPath },
});
const marketMount = (p: string): Mount => ({
  src: p,
  dst: p,
  mode: "ro",
  source: { kind: "marketplace", path: p },
});
const roMount = (p: string): Mount => ({
  src: p,
  dst: p,
  mode: "ro",
  source: { kind: "ro", path: p },
});
const mountFlag = (raw: string, dst: string): Mount => ({
  src: dst,
  dst,
  mode: "rw",
  source: { kind: "artifact", flag: "mount", raw },
});
const outputMount = (): Mount => ({
  src: "/host/out",
  dst: "/output",
  mode: "rw",
  source: { kind: "output" },
});
const transcriptsMount = (): Mount => ({
  src: "/host/transcripts",
  dst: `${HOME_IN_CONTAINER}/.claude/projects`,
  mode: "rw",
  source: { kind: "transcripts" },
});

describe("resolveMountCollisions", () => {
  it("passes through a non-colliding list unchanged", () => {
    const mounts: Mount[] = [repoMount("/a"), roMount("/b")];
    const r = resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER });
    expect(r.mounts).toEqual(mounts);
  });

  it("throws on exact dst collision between two user mounts", () => {
    const mounts: Mount[] = [roMount("/x"), marketMount("/x")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /duplicate container path \/x.*--ro.*marketplace/,
    );
  });

  it("throws on exact dst collision between --mount and a repo", () => {
    const mounts: Mount[] = [repoMount("/r"), mountFlag("x", "/r")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /duplicate container path \/r.*--repo.*--mount/,
    );
  });

  it("throws on two repo entries with identical dst (defense-in-depth vs symlink bypass)", () => {
    const mounts: Mount[] = [repoMount("/a"), repoMount("/a")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /duplicate container path \/a/,
    );
  });

  it("allows two alternates mounts with different alternatesName segments", () => {
    const a: Mount = {
      src: "/host/a/.git/objects",
      dst: "/host-git-alternates/a-00000000/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host/a", category: "objects" },
    };
    const b: Mount = {
      src: "/host/b/.git/objects",
      dst: "/host-git-alternates/b-11111111/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host/b", category: "objects" },
    };
    const r = resolveMountCollisions([a, b], { homeInContainer: HOME_IN_CONTAINER });
    expect(r.mounts).toHaveLength(2);
  });

  it("throws if two alternates mounts collide (alternatesName bug regression test)", () => {
    const a: Mount = {
      src: "/host/a/.git/objects",
      dst: "/host-git-alternates/myrepo-deadbeef/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host/a/myrepo", category: "objects" },
    };
    const b: Mount = {
      src: "/host/b/.git/objects",
      dst: "/host-git-alternates/myrepo-deadbeef/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host/b/myrepo", category: "objects" },
    };
    expect(() => resolveMountCollisions([a, b], { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /duplicate container path.*myrepo-deadbeef/,
    );
  });

  it("errors on --ro colliding with /output", () => {
    const mounts: Mount[] = [outputMount(), roMount("/output")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /\/output.*reserved.*--ro/,
    );
  });

  it("errors on --mount colliding with /host-claude", () => {
    const host: Mount = {
      src: "/real/.claude",
      dst: "/host-claude",
      mode: "ro",
      source: { kind: "host-claude" },
    };
    const mounts: Mount[] = [host, mountFlag("weird", "/host-claude")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /\/host-claude.*reserved/,
    );
  });

  it("errors on user mount using a reserved homeInContainer path", () => {
    const mounts: Mount[] = [
      transcriptsMount(),
      roMount(`${HOME_IN_CONTAINER}/.claude/projects`),
    ];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /\.claude\/projects.*reserved/,
    );
  });

  it("errors on user mount using a path under /host-git-alternates", () => {
    const alt: Mount = {
      src: "/host/.git/objects",
      dst: "/host-git-alternates/myrepo-aa/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host", category: "objects" },
    };
    const mounts: Mount[] = [alt, roMount("/host-git-alternates/myrepo-aa/objects")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /host-git-alternates/,
    );
  });

  it("does not reorder surviving mounts", () => {
    const mounts: Mount[] = [outputMount(), repoMount("/r"), roMount("/x"), mountFlag("m", "/y")];
    const r = resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER });
    expect(r.mounts.map((m) => m.dst)).toEqual(["/output", "/r", "/x", "/y"]);
  });

  it("exposes the reserved-path set for external consumers (stability check)", () => {
    const reserved = reservedContainerPaths({ homeInContainer: HOME_IN_CONTAINER });
    expect(reserved.exact).toEqual(
      expect.arrayContaining([
        "/output",
        "/host-claude",
        "/host-claude-json",
        "/host-claude-creds",
        "/host-claude-patched-settings.json",
        "/host-claude-patched-json",
        `${HOME_IN_CONTAINER}/.claude/projects`,
        `${HOME_IN_CONTAINER}/.claude/plugins/cache`,
      ]),
    );
    expect(reserved.prefixes).toEqual(expect.arrayContaining(["/host-git-alternates"]));
  });

  it("blocks --ro mounting under the clipboard bridge prefix", () => {
    expect(() =>
      resolveMountCollisions(
        [
          { src: "/tmp/a", dst: "/run/ccairgap-clipboard/current.png", mode: "ro", source: { kind: "ro", path: "/tmp/a" } },
        ],
        { homeInContainer: "/home/claude" },
      ),
    ).toThrow(/reserved prefix \/run\/ccairgap-clipboard.*--ro \/tmp\/a/);
  });

  it("blocks --ro mounting the clipboard bridge dir exactly", () => {
    expect(() =>
      resolveMountCollisions(
        [
          { src: "/tmp/a", dst: "/run/ccairgap-clipboard", mode: "ro", source: { kind: "ro", path: "/tmp/a" } },
        ],
        { homeInContainer: "/home/claude" },
      ),
    ).toThrow(/reserved prefix \/run\/ccairgap-clipboard.*--ro \/tmp\/a/);
  });
});
