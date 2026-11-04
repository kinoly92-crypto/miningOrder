#!/usr/bin/env bash
set -Eeuo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
bin="$test_root/bin"
base="$test_root/base"
commit=0123456789012345678901234567890123456789
mkdir -p "$bin" "$base/incoming" "$base/releases" "$test_root/source" "$test_root/dist"
printf '{}\n' >"$test_root/source/package-lock.json"
printf '<html></html>\n' >"$test_root/dist/index.html"
tar -cf "$base/incoming/$commit-source.tar" -C "$test_root/source" .
tar -cf "$base/incoming/$commit-dist.tar" -C "$test_root/dist" .
source_hash=$(sha256sum "$base/incoming/$commit-source.tar" | cut -d ' ' -f 1)
dist_hash=$(sha256sum "$base/incoming/$commit-dist.tar" | cut -d ' ' -f 1)
printf '#!/usr/bin/env bash\necho orderdeploy\n' >"$bin/id"
printf '#!/usr/bin/env bash\n[[ ${TEST_FAIL_NPM:-} != 1 ]]\n' >"$bin/npm"
chmod +x "$bin/id" "$bin/npm"
sed \
  -e "s|^export PATH=.*|export PATH=$bin:/usr/bin:/bin|" \
  -e "s|^base=/var/lib/order-record-deploy|base=$base|" \
  "$repo/deploy/prepare-release.sh" >"$test_root/prepare.sh"

wrong_hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
if bash "$test_root/prepare.sh" "$commit" "$wrong_hash" "$dist_hash"; then
  echo 'Expected hash mismatch rejection' >&2
  exit 1
fi
[[ ! -e "$base/releases/$commit" ]]
if TEST_FAIL_NPM=1 bash "$test_root/prepare.sh" "$commit" "$source_hash" "$dist_hash"; then
  echo 'Expected dependency installation failure' >&2
  exit 1
fi
[[ ! -e "$base/releases/$commit" ]]
[[ -z $(find "$base/releases" -mindepth 1 -maxdepth 1 -name '.prepare-*' -print) ]]
bash "$test_root/prepare.sh" "$commit" "$source_hash" "$dist_hash"
[[ -f "$base/releases/$commit/dist/index.html" ]]
if bash "$test_root/prepare.sh" "$commit" "$source_hash" "$dist_hash"; then
  echo 'Expected existing release rejection' >&2
  exit 1
fi
echo 'Release preparation simulation passed'
