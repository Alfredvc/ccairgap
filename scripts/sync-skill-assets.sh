#!/usr/bin/env bash
# Sync canonical docs + docker assets into the skill's references/ and assets/.
# Skill files are committed, so this script makes them match the canonical source.
#
# Wired as a pre-commit hook and a CI drift check:
#   pre-commit: runs this script, then `git add` the skill files.
#   CI: runs this script, then `git diff --exit-code skills/` to fail on drift.
#
# Edit the canonical source (docs/*.md, docker/Dockerfile, docker/entrypoint.sh)
# and re-run this
# script. Do not hand-edit files under skills/ccairgap-configure/references/
# or skills/ccairgap-configure/assets/Dockerfile.template — they are generated.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

skill_refs="skills/ccairgap-configure/references"
skill_assets="skills/ccairgap-configure/assets"

# docs/*.md -> skills/.../references/<target>.md
#   Tuple format: "<source-relative-to-repo>|<dest-relative-to-repo>"
doc_pairs=(
    "docs/config.md|$skill_refs/config-schema.md"
    "docs/hooks.md|$skill_refs/hook-patterns.md"
    "docs/mcp.md|$skill_refs/mcp-patterns.md"
    "docs/docker-run-args.md|$skill_refs/docker-run-args.md"
    "docs/dockerfile.md|$skill_refs/dockerfile-patterns.md"
)

generated_header_md() {
    local source_path="$1"
    cat <<EOF
<!--
  GENERATED FILE — do not edit.
  Source: $source_path
  Regenerate with: scripts/sync-skill-assets.sh
-->

EOF
}

generated_header_dockerfile() {
    local source_path="$1"
    cat <<EOF
# GENERATED FILE — do not edit.
# Source: $source_path
# Regenerate with: scripts/sync-skill-assets.sh
#
# To customize for your project, copy this file to <git-root>/.ccairgap/Dockerfile.
# Add only project-specific image changes above the agent install block.

EOF
}

sync_markdown() {
    local src="$1" dst="$2"
    if [ ! -f "$src" ]; then
        echo "sync-skill-assets: missing source $src" >&2
        return 1
    fi
    mkdir -p "$(dirname "$dst")"
    {
        generated_header_md "$src"
        cat "$src"
    } > "$dst"
    echo "  $src -> $dst"
}

sync_dockerfile_template() {
    local dst="$1"
    if [ ! -f "docker/Dockerfile" ] || [ ! -f "docker/entrypoint.sh" ]; then
        echo "sync-skill-assets: missing docker image sources" >&2
        return 1
    fi
    mkdir -p "$(dirname "$dst")"
    {
        generated_header_dockerfile "ccairgap-managed runtime base image arg"
        cat <<EOF
ARG CCAIRGAP_RUNTIME_BASE_IMAGE=ccairgap:runtime-base-required
FROM \${CCAIRGAP_RUNTIME_BASE_IMAGE}

# Add project-specific image changes above the agent install block.
# Host Claude Code / Codex upgrades only invalidate the layers below.

ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION

RUN test -n "\$CLAUDE_CODE_VERSION" \\
 && test -n "\$CODEX_VERSION"

RUN npm install -g @openai/codex@\${CODEX_VERSION}

USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash -s "\${CLAUDE_CODE_VERSION}"

USER root
RUN chmod -R go+rwX /home/claude \\
 && test "\$(claude --version | node -e 'const fs=require("node:fs");const input=fs.readFileSync(0,"utf8");const match=input.match(/(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)/);process.stdout.write(match?.[1] ?? "");')" = "\$CLAUDE_CODE_VERSION" \\
 && test "\$(codex --version | node -e 'const fs=require("node:fs");const input=fs.readFileSync(0,"utf8");const match=input.match(/(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)/);process.stdout.write(match?.[1] ?? "");')" = "\$CODEX_VERSION"
EOF
    } > "$dst"
    echo "  managed-runtime-base Dockerfile template -> $dst"
}

echo "Syncing skill assets…"

for pair in "${doc_pairs[@]}"; do
    src="${pair%|*}"
    dst="${pair#*|}"
    sync_markdown "$src" "$dst"
done

sync_dockerfile_template "$skill_assets/Dockerfile.template"

echo "Done."
