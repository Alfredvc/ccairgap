# Shell completion

ccairgap ships tab-completion for **bash**, **zsh**, and **fish**, backed by [`@pnpm/tabtab`](https://www.npmjs.com/package/@pnpm/tabtab) — the same library pnpm uses.

## Install

```bash
ccairgap install-completion          # prompts for your shell
ccairgap install-completion zsh      # or name the shell directly
```

One `source …` line is added to your shell rc (`~/.bashrc`, `~/.zshrc`, or `~/.config/fish/config.fish`). The actual completion script lives under `~/.config/tabtab/` and defers each tab-press back to `ccairgap completion-server`. Re-running the command is a no-op — the line is inserted only once.

Reload your shell (or `source ~/.zshrc` etc.) to pick up the new completion.

## Uninstall

```bash
ccairgap uninstall-completion
```

Removes the source line from every supported rc and deletes the tabtab scripts when no other program still uses them. Idempotent.

## What completes

| Context | Candidates |
|---------|-----------|
| `ccairgap <TAB>` | Every subcommand + every long-form launch flag. |
| `ccairgap recover <TAB>` / `ccairgap discard <TAB>` | Session ids — directory names under `$XDG_STATE_HOME/ccairgap/sessions/`. |
| `ccairgap -r <TAB>` / `ccairgap --resume <TAB>` | Custom titles of transcripts under `~/.claude/projects/<encoded-workspace-cwd>/*.jsonl`. Requires the current working directory to be a git repo — that's what ccairgap treats as the workspace for resume resolution. |
| `ccairgap install-completion <TAB>` | `bash`, `zsh`, `fish`. |

Static candidates are introspected from the same commander `program` instance that parses real invocations, so they never drift from the CLI surface.

## Caveats

- **Resume-title completion needs a workspace.** The completer uses `process.cwd()` as the workspace; if you're not inside a git repo, no candidates are produced. Pass a UUID or a title literal in that case.
- **Titles with brackets or spaces complete oddly in bash.** ccairgap's Claude sessions are titled `[ccairgap] <id>`, and bash's default word splitting doesn't escape `[`/`]` or spaces for you. zsh and fish handle these correctly. Workaround on bash: use the UUID, or quote the title yourself.
- **Stale completion after upgrade.** If the flag set changes between releases, re-source your rc (or open a new shell) — the tabtab callback reads the current binary at tab-press time, so upgrades usually just work, but the cached shell function itself is only loaded at rc sourcing.

## Troubleshooting

- *Nothing completes.* Confirm the rc was sourced: `grep tabtab ~/.zshrc` (or your shell's rc). Re-run `install-completion` if missing.
- *Wrong shell detected.* tabtab picks the shell from `$SHELL` in the install env. Pass the shell name explicitly: `install-completion bash`.
- *Errors on tab-press.* The completion-server swallows its own errors by design, so tab-press never renders a stacktrace. To debug, invoke it manually: `COMP_LINE="ccairgap recover " COMP_POINT=17 COMP_CWORD=2 SHELL=bash ccairgap completion-server`.

## How it works

`install-completion` calls `tabtab.install({ name: "ccairgap", completer: "ccairgap", shell })`. The shell script tabtab writes sets `COMP_LINE` / `COMP_POINT` / `COMP_CWORD` on every tab-press and calls `ccairgap completion-server`. That subcommand is hidden from `--help` but is a real commander subcommand — so the `--` passthrough guard recognizes it and the same-introspected flag list powers both the parser and the completer.

Host-side only. Nothing about completion crosses the container boundary; the container image ships no tabtab state and is unaware that the host has completion installed.
