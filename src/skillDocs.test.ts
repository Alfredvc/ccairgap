import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { DOCS_DIR, DOCS_PAGES } from "./docsUrl.js";
import { parseNetworkConfig } from "./network.js";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_DIR = join(ROOT, "skills/ccairgap-configure");
const REFERENCES = join(ROOT, DOCS_DIR);

function markdownIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f));
}

const skillPages = [join(SKILL_DIR, "SKILL.md"), ...markdownIn(REFERENCES)];
const repoPages = [join(ROOT, "README.md"), join(ROOT, "SECURITY.md"), ...markdownIn(join(ROOT, "docs"))];

/** Remove fenced code, because a `](x)` there is not a link. */
function withoutFences(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, "");
}

function relativeLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of withoutFences(text).matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]!;
    if (!/^[a-z]+:/i.test(target) && !target.startsWith("#")) out.push(target);
  }
  return out;
}

/** GitHub's heading anchor: lowercase, punctuation removed, spaces become dashes. */
function anchors(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of withoutFences(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    out.add(
      m[1]!
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .trim()
        .replace(/\s/g, "-"),
    );
  }
  return out;
}

function brokenLinks(page: string): string[] {
  const broken: string[] = [];
  for (const link of relativeLinks(readFileSync(page, "utf8"))) {
    const [file, anchor] = link.split("#") as [string, string | undefined];
    const target = resolve(dirname(page), file);
    if (!existsSync(target)) broken.push(link);
    else if (anchor && target.endsWith(".md") && !anchors(readFileSync(target, "utf8")).has(anchor)) {
      broken.push(link);
    }
  }
  return broken;
}

describe("doc links", () => {
  it.each([...skillPages, ...repoPages].map((p) => [relative(ROOT, p), p]))(
    "%s has no broken relative link",
    (_name, page) => {
      expect(brokenLinks(page as string)).toEqual([]);
    },
  );

  // `npx skills add` installs the skill directory alone, so these links would break for a user.
  it.each(skillPages.map((p) => [relative(ROOT, p), p]))(
    "%s has no relative link that leaves the skill",
    (_name, page) => {
      const leaving = relativeLinks(readFileSync(page as string, "utf8")).filter((link) => {
        const target = resolve(dirname(page as string), link.split("#")[0]!);
        return !target.startsWith(SKILL_DIR + sep);
      });
      expect(leaving).toEqual([]);
    },
  );

  it.each(DOCS_PAGES.map((p) => [p]))("the page behind docsUrl(%s) exists", (page) => {
    expect(existsSync(join(REFERENCES, `${page}.md`))).toBe(true);
  });
});

describe("skill layout", () => {
  const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

  it("names only references that exist", () => {
    const named = [...skill.matchAll(/`references\/([\w.-]+\.md)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((f) => !existsSync(join(REFERENCES, f)))).toEqual([]);
  });

  it("names every reference, so no page is orphaned", () => {
    const direct = new Set([...skill.matchAll(/`references\/([\w.-]+\.md)`/g)].map((m) => m[1]!));
    const orphans = readdirSync(REFERENCES).filter((f) => !direct.has(f));
    expect(orphans).toEqual([]);
  });

  it("keeps the frontmatter name and a description within the 1024-character limit", () => {
    const front = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1];
    const meta = parseYaml(front!) as { name: string; description: string };
    expect(meta.name).toBe("ccairgap-configure");
    expect(meta.description.length).toBeLessThanOrEqual(1024);
  });

  // The installer skips a symlink whose target is outside the skill root.
  it("holds no symlink that leaves the skill", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return realpathSync(path).startsWith(SKILL_DIR + sep) ? [] : [path];
        return stat.isDirectory() ? walk(path) : [];
      });
    expect(walk(SKILL_DIR)).toEqual([]);
  });
});

describe("network examples", () => {
  const yamlBlocks = (page: string): string[] =>
    [...readFileSync(page, "utf8").matchAll(/^```yaml\n([\s\S]*?)^```/gm)].map((m) => m[1]!);

  const withNetwork = [join(ROOT, "README.md"), join(REFERENCES, "network.md"), join(REFERENCES, "config.md")].flatMap(
    (page) =>
      yamlBlocks(page)
        .filter((block) => /^network:/m.test(block))
        .map((block): [string, string] => [relative(ROOT, page), block]),
  );

  it("finds the examples", () => {
    expect(withNetwork.length).toBeGreaterThanOrEqual(9);
  });

  it.each(withNetwork)("%s example parses: %s", (_page, block) => {
    const config = parseYaml(block) as { network: unknown };
    expect(() => parseNetworkConfig(config.network)).not.toThrow();
  });
});
