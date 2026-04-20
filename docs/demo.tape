# docs/demo.tape — regenerate with: vhs docs/demo.tape
# Requirements: vhs, docker running, ccairgap on PATH, Claude creds on host.
#
# Uses Wait+Screen so vhs captures real launch/handoff time only. The trimming
# script (scripts/trim-demo-gif.mjs) is still run afterwards as a safety net
# to collapse any incidental identical-frame runs to ≤ 1 s.
#
# Privacy: stages a scrubbed copy of ~/.claude.json under
# /tmp/ccairgap-demo/.staging-claude/ with oauthAccount identity fields
# replaced, then points ccairgap at it via CLAUDE_CONFIG_DIR. The real host
# config is untouched.

Output "docs/demo.gif"

Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 720
Set Theme "Dracula"
Set Padding 18
Set TypingSpeed 40ms

Hide
Type `rm -rf /tmp/ccairgap-demo && mkdir -p /tmp/ccairgap-demo/.staging-claude`
Enter
Type `cd /tmp/ccairgap-demo && git init -q -b main && git config user.name demo && git config user.email demo@example.com`
Enter
Type `printf '# demo\n' > README.md && git add . && git commit -q -m initial`
Enter
Type `jq '.oauthAccount.emailAddress="demo@example.com" | .oauthAccount.displayName="demo" | .oauthAccount.organizationName="demo"' ~/.claude.json > /tmp/ccairgap-demo/.staging-claude/.claude.json`
Enter
Type `export CLAUDE_CONFIG_DIR=/tmp/ccairgap-demo/.staging-claude CCAIRGAP_HOME=/tmp/ccairgap-demo/.state PS1='$ '`
Enter
Type "clear"
Enter
Show

Sleep 500ms
Type "ccairgap"
Enter
Wait+Screen@45s /bypass permissions/
Sleep 1s

Type "create hello.txt with Hello World and commit it"
Sleep 500ms
Enter
Sleep 10s

Type "/exit"
Enter
Sleep 2s

Type "git log --oneline --all --decorate -3"
Enter
Sleep 2500ms
