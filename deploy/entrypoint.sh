#!/bin/sh
# Starts a program from the downloaded package: entrypoint.sh opencode serve ... | entrypoint.sh opencode gateway
set -e
sh /deploy/fetch.sh /opt/opencode
# Execution layers run git and ripgrep for users.
if [ "$1" = opencode ] && [ "$2" = serve ]; then
  command -v rg >/dev/null || (apt-get update -qq && apt-get install -y -qq --no-install-recommends ripgrep >/dev/null)
fi
exec "/opt/opencode/bin/$@"
