#!/bin/sh
# Downloads the program package from OPENCODE_PACKAGE_URL into $1 unless that exact package is already there, so a
# restart does not download again and a new URL (a new version) does.
set -e
dir=${1:?target directory}
: "${OPENCODE_PACKAGE_URL:?set OPENCODE_PACKAGE_URL or OPENCODE_VERSION}"
mkdir -p "$dir"
if [ "$(cat "$dir/.package" 2>/dev/null)" != "$OPENCODE_PACKAGE_URL" ]; then
  rm -rf "$dir"/*
  curl -fsSL ${OPENCODE_PACKAGE_TOKEN:+-H "Authorization: Bearer $OPENCODE_PACKAGE_TOKEN"} "$OPENCODE_PACKAGE_URL" \
    | tar -xz -C "$dir" --strip-components=1
  echo "$OPENCODE_PACKAGE_URL" > "$dir/.package"
fi
