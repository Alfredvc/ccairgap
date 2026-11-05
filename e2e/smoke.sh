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

# Network policy. Tier 2 uses a fake image, so only this run covers the forwarder
# and CA bundle in the real entrypoint. Expect "hello", then 200, 403 and 000,
# because a denied CONNECT reaches curl as a failed tunnel with no HTTP status.
mkdir -p "$repo/.ccairgap"
cat > "$repo/.ccairgap/config.yaml" <<'YAML'
network:
  rules:
    - host: example.com
      methods: [GET]
YAML
node "$toplevel/dist/cli.js" --repo "$repo" -p "print 'hello' and exit" || echo "SMOKE: non-zero exit under a network policy"
node "$toplevel/dist/cli.js" --repo "$repo" exec -- sh -c '
  for args in "https://example.com/" "-X POST https://example.com/" "https://www.iana.org/"; do
    curl -sS -o /dev/null -w "%{http_code} $args\n" $args || true
  done
' || echo "SMOKE: non-zero exit from the network policy probe"
