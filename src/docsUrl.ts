/**
 * URL of a user doc for CLI messages and generated files. The npm package does
 * not ship these pages, so a repo-relative path would not resolve for a user.
 * skillDocs.test.ts checks that each page in {@link DocsPage} exists.
 */
export const DOCS_PAGES = ["config", "network"] as const;
export type DocsPage = (typeof DOCS_PAGES)[number];

export const DOCS_DIR = "skills/ccairgap-configure/references";

export function docsUrl(page: DocsPage): string {
  return `https://github.com/alfredvc/ccairgap/blob/main/${DOCS_DIR}/${page}.md`;
}
