#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/opt/order-record/node/bin:/usr/bin:/bin
umask 027

die() { echo "prepare: $*" >&2; exit 1; }
[[ $(id -un) == orderdeploy ]] || die "must run as orderdeploy"
[[ $# == 3 && $1 =~ ^[0-9a-f]{40}$ && $2 =~ ^[0-9a-f]{64}$ && $3 =~ ^[0-9a-f]{64}$ ]] ||
  die "expected commit and two SHA-256 hashes"
commit=$1
source_hash=$2
dist_hash=$3
base=/var/lib/order-record-deploy
source_tar="$base/incoming/$commit-source.tar"
dist_tar="$base/incoming/$commit-dist.tar"
release="$base/releases/$commit"

[[ -f $source_tar && ! -L $source_tar && -f $dist_tar && ! -L $dist_tar ]] ||
  die "uploaded archives missing or symlinked"
printf '%s  %s\n%s  %s\n' "$source_hash" "$source_tar" "$dist_hash" "$dist_tar" | sha256sum -c -
[[ ! -e $release && ! -L $release ]] || die "release already exists; refusing to overwrite it"
stage=$(mktemp -d "$base/releases/.prepare-$commit.XXXXXXXX")
cleanup() {
  status=$?
  trap - EXIT
  if [[ -n $stage && -d $stage && ! -L $stage ]]; then
    rm -rf -- "$stage" || echo "prepare: could not remove temporary directory $stage" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
tar -xf "$source_tar" -C "$stage" --no-same-owner --no-same-permissions
mkdir "$stage/dist"
tar -xf "$dist_tar" -C "$stage/dist" --no-same-owner --no-same-permissions
[[ -f $stage/package-lock.json && -f $stage/dist/index.html ]] || die "release is incomplete"
cd "$stage"
npm ci --include=dev --no-audit --no-fund
chmod -R g+rX "$stage"
cd /
mv -T -n -- "$stage" "$release"
[[ ! -e $stage && ! -L $stage ]] || die "release already exists; refusing to overwrite it"
stage=
echo "prepare: $commit is ready"
