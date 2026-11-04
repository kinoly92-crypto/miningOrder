#!/usr/bin/env bash
set -Eeuo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
export TEST_ROOT="$test_root"
bin="$test_root/bin"
dropdir="$test_root/systemd"
releases="$test_root/releases"
commit=0123456789012345678901234567890123456789
release="$releases/$commit"
mkdir -p "$bin" "$dropdir" "$release/dist" "$release/server/src" "$release/node_modules"
touch "$release/dist/index.html" "$release/server/src/index.ts"

cat >"$bin/mock" <<'MOCK'
#!/usr/bin/env bash
set -eu
case "$(basename "$0")" in
  flock|systemd-run|sleep) exit 0 ;;
  ss)
    if [[ $* == *-ltnp* ]]; then echo 'LISTEN 0 128 127.0.0.1:3001 0.0.0.0:* users:(("node",pid=123,fd=1))'; fi
    exit 0 ;;
  curl)
    count=$(cat "$TEST_ROOT/restarts" 2>/dev/null || printf 0)
    if [[ ${TEST_SCENARIO:-} == fail-production && $count == 1 && ${*: -1} == *:3001/ ]]; then
      exit 1
    fi
    exit 0 ;;
  systemctl)
    case "$1" in
      is-active|stop|daemon-reload) exit 0 ;;
      restart)
        count=$(cat "$TEST_ROOT/restarts" 2>/dev/null || printf 0)
        echo "$((count + 1))" >"$TEST_ROOT/restarts"
        exit 0 ;;
      show)
        if [[ ${4:-} == MainPID ]]; then
          echo 123
        elif [[ $2 == order-record-release-preview.service ]]; then
          echo not-found
        else
          sed -n 's/^WorkingDirectory=//p' "$TEST_ROOT/systemd/zz-order-record-release.conf"
        fi
        exit 0 ;;
    esac ;;
esac
exit 1
MOCK
chmod +x "$bin/mock"
for command in flock systemd-run ss curl systemctl sleep; do
  cp "$bin/mock" "$bin/$command"
done
sed \
  -e "s|^export PATH=.*|export PATH=$bin:/usr/bin:/bin|" \
  -e 's/^\[\[ ${EUID} == 0 \]\].*/:/' \
  -e 's/^\[\[ $(stat -c %u "\$dropdir") == 0 \]\].*/:/' \
  -e "s|/var/lib/order-record-deploy/releases|$releases|g" \
  -e "s|/etc/systemd/system/order-record.service.d|$dropdir|g" \
  -e "s|/run/order-record-release.lock|$test_root/release.lock|g" \
  -e "s|/run/order-record-release.XXXXXXXX|$test_root/backup.XXXXXXXX|g" \
  "$repo/deploy/release-server.sh" >"$test_root/release-server.sh"

printf '[Service]\nWorkingDirectory=/old/version\n' >"$dropdir/zz-order-record-release.conf"
cp "$dropdir/zz-order-record-release.conf" "$test_root/original"
bash "$test_root/release-server.sh" "$commit"
grep -Fx "WorkingDirectory=$release" "$dropdir/zz-order-record-release.conf"

cp "$test_root/original" "$dropdir/zz-order-record-release.conf"
echo 0 >"$test_root/restarts"
if TEST_SCENARIO=fail-production bash -x "$test_root/release-server.sh" "$commit" 2>"$test_root/failure.log"; then
  echo 'Expected failed release' >&2
  exit 1
fi
if ! cmp "$test_root/original" "$dropdir/zz-order-record-release.conf"; then
  cat "$test_root/failure.log" >&2
  exit 1
fi
[[ $(cat "$test_root/restarts") == 2 ]]

if bash "$test_root/release-server.sh" '../not-a-commit'; then
  echo 'Expected invalid commit rejection' >&2
  exit 1
fi
echo 'Release server simulation passed'
