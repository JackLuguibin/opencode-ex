#!/bin/sh
# Starts a program from the downloaded package: entrypoint.sh opencode serve ... | entrypoint.sh opencode gateway
set -e
sh /deploy/fetch.sh /opt/opencode
# Execution layers run git and ripgrep for users, and confine organization shells, terminals and MCP servers with bubblewrap.
if [ "$1" = opencode ] && [ "$2" = serve ]; then
  missing=""
  command -v rg >/dev/null || missing="ripgrep"
  command -v bwrap >/dev/null || missing="$missing bubblewrap"
  [ -z "$missing" ] || (apt-get update -qq && apt-get install -y -qq --no-install-recommends $missing >/dev/null)
fi
exec "/opt/opencode/bin/$@"
