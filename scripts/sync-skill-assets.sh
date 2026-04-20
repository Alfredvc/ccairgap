#!/usr/bin/env bash
# Sync canonical docs + docker assets into the skill's references/ and assets/.
# Skill files are committed, so this script makes them match the canonical source.
#
# Wired as a pre-commit hook and a CI drift check:
#   pre-commit: runs this script, then `git add` the skill files.
#   CI: runs this script, then `git diff --exit-code skills/` to fail on drift.
#
# Edit the canonical source (docs/*.md, docker/Dockerfile) and re-run this
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
# To customize for your project, copy this file to <git-root>/.ccairgap/Dockerfile
# and edit the copy. See docs/dockerfile.md for extension patterns.

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

sync_dockerfile() {
    local src="$1" dst="$2"
    if [ ! -f "$src" ]; then
        echo "sync-skill-assets: missing source $src" >&2
        return 1
    fi
    mkdir -p "$(dirname "$dst")"
    {
        generated_header_dockerfile "$src"
        cat "$src"
    } > "$dst"
    echo "  $src -> $dst"
}

echo "Syncing skill assets…"

for pair in "${doc_pairs[@]}"; do
    src="${pair%|*}"
    dst="${pair#*|}"
    sync_markdown "$src" "$dst"
done

sync_dockerfile "docker/Dockerfile" "$skill_assets/Dockerfile.template"

echo "Done."
