#!/usr/bin/env bash
# Launches real claude with a throwaway prompt. Human eyeballs the exit.
# Requires: valid creds, docker, network.
set -e
toplevel="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
tmpdir="$(mktemp -d)"
repo="$tmpdir/smoke-repo"
git init -q "$repo"
cd "$repo" && touch README && git add . && git -c user.email=s@m -c user.name=s commit -q -m init
node "$toplevel/dist/cli.js" --repo "$repo" -p "print 'hello' and exit" || echo "SMOKE: non-zero exit"
