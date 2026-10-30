#!/bin/sh
# Builds the program packages on this machine and publishes them as a GitHub release, which deploy/*.yml download.
# Each package is one binary, bin/opencode: `serve` is the execution layer, `gateway` the Auth gateway, which also
# serves the web app embedded in the binary. Only Linux and macOS are built.
#   gh auth login                                   # once
#   sh script/release.sh v1.0.0                     # build every platform and publish
#   PUBLISH=0 sh script/release.sh v1.0.0           # build only; the archives stay in release/
#   TARGETS="linux-x64" sh script/release.sh v1.0.0 # one platform (default: linux-x64 linux-arm64 darwin-arm64 darwin-x64)
# The native packages are normally installed already; set INSTALL=1 to have the build fetch them again.
set -e
version=${1:?usage: release.sh <version, e.g. v1.0.0>}
targets=${TARGETS:-linux-x64 linux-arm64 darwin-arm64 darwin-x64}
cd "$(dirname "$0")/.."
root=$(pwd)
rm -rf release && mkdir -p release

archives=
for target in $targets; do
  out=$root/release/opencode-ex-$version-$target
  mkdir -p "$out/bin"
  OPENCODE_TARGET=$target bun run --cwd packages/cli build $([ -z "$INSTALL" ] && echo --skip-install)
  cp "packages/cli/dist/cli-$target/bin/opencode" "$out/bin/opencode"
  COPYFILE_DISABLE=1 tar -czf "$out.tar.gz" -C "$root/release" "opencode-ex-$version-$target"
  rm -rf "$out"
  archives="$archives $out.tar.gz"
  echo "built $out.tar.gz"
done

[ "${PUBLISH:-1}" = 0 ] && exit 0
gh release create "$version" $archives --title "$version" --generate-notes
