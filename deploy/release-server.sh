#!/bin/bash
set -Eeuo pipefail
export PATH=/opt/order-record/node/bin:/usr/sbin:/usr/bin:/sbin:/bin

die() { echo "release: $*" >&2; exit 1; }
listener_belongs_to_unit() {
  local unit=$1 port=$2 pid listeners
  pid=$(systemctl show "$unit" -p MainPID --value) || return 1
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  listeners=$(ss -H -ltnp "sport = :$port") || return 1
  grep -Fq "pid=$pid," <<<"$listeners"
}
wait_for_service() {
  local unit=$1 port=$2 i
  for ((i=0; i<30; i++)); do
    if systemctl is-active --quiet "$unit" &&
       listener_belongs_to_unit "$unit" "$port" &&
       curl --noproxy '*' --silent --fail --max-time 2 "http://127.0.0.1:$port/" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
[[ ${EUID} == 0 ]] || die "must run as root"
[[ $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || die "expected a full Git commit ID"
commit=$1
release="/var/lib/mining-order-deploy/releases/$commit"
dropdir=/etc/systemd/system/mining-order.service.d
dropin="$dropdir/zz-mining-order-release.conf"
preview=mining-order-release-preview.service
lock=/run/mining-order-release.lock

exec 9>"$lock"
flock -n 9 || die "another release is running"
[[ -d $release && ! -L $release ]] || die "release directory missing or a symlink"
[[ $(realpath "$release") == "$release" ]] || die "release path is not canonical"
[[ -f $release/dist/index.html && -f $release/server/src/index.ts && -d $release/node_modules ]] ||
  die "release is incomplete"
[[ -d $dropdir && ! -L $dropdir && ! -L $dropin ]] || die "unsafe service configuration directory"
[[ $(stat -c %u "$dropdir") == 0 ]] || die "service configuration directory is not root-owned"
mode=$(stat -c %a "$dropdir")
(( (8#$mode & 8#022) == 0 )) || die "service configuration directory is writable by others"
systemctl is-active --quiet mining-order.service || die "production service is not active"
listener_belongs_to_unit mining-order.service 3002 || die "production service does not own port 3002"
curl --noproxy '*' --silent --show-error --fail --max-time 5 http://127.0.0.1:3002/ >/dev/null ||
  die "production HTTP check failed before release"
listeners=$(ss -H -ltn 'sport = :31083') || die "cannot check preview port"
[[ -z $listeners ]] || die "preview port 31083 is in use"
[[ $(systemctl show "$preview" -p LoadState --value) == not-found ]] ||
  die "preview unit already exists"

backup=$(mktemp /run/mining-order-release.XXXXXXXX)
had_dropin=0
changed=0
preview_started=0
if [[ -e $dropin ]]; then
  [[ -f $dropin ]] || die "release drop-in is not a regular file"
  cp -p -- "$dropin" "$backup"
  had_dropin=1
fi

cleanup() {
  status=$?
  trap - EXIT
  if (( preview_started )); then
    systemctl stop "$preview" >/dev/null 2>&1 || true
  fi
  if (( status != 0 && changed )); then
    echo "release: restoring previous service configuration" >&2
    if (( had_dropin )); then
      cp -p -- "$backup" "$dropin"
    else
      rm -f -- "$dropin"
    fi
    if systemctl daemon-reload && systemctl restart mining-order.service &&
       wait_for_service mining-order.service 3002; then
      echo "release: previous service restored" >&2
    else
      echo "release: ROLLBACK FAILED; check mining-order.service immediately" >&2
    fi
  fi
  rm -f -- "$backup"
  exit "$status"
}
trap cleanup EXIT

systemd-run --unit="$preview" --collect \
  --property=User=miningorder --property=Group=miningorder \
  --property="WorkingDirectory=$release" \
  --property=EnvironmentFile=/etc/mining-order/app.env \
  --property=NoNewPrivileges=yes --property=PrivateTmp=yes \
  --property=ProtectSystem=strict --property=ProtectHome=yes \
  --property=UMask=0077 \
  --setenv=NODE_ENV=production --setenv=DB_CLIENT=mysql \
  --setenv=HOST=127.0.0.1 --setenv=PORT=31083 \
  --setenv=TRUST_PROXY=loopback --setenv=HOME=/var/lib/mining-order \
  --setenv=PATH=/opt/order-record/node/bin:/usr/bin:/bin \
  /opt/order-record/node/bin/node --import tsx server/src/index.ts
preview_started=1
wait_for_service "$preview" 31083 || die "preview failed; production was not switched"
systemctl stop "$preview"
preview_started=0

tmp=$(mktemp "$dropdir/.release.XXXXXXXX")
printf '[Service]\nWorkingDirectory=%s\n' "$release" >"$tmp"
chmod 0644 "$tmp"
mv -f -- "$tmp" "$dropin"
changed=1
systemctl daemon-reload
[[ $(systemctl show mining-order.service -p WorkingDirectory --value) == "$release" ]] ||
  die "another drop-in overrides the release directory"
systemctl restart mining-order.service
wait_for_service mining-order.service 3002 || die "production health check failed"
changed=0
echo "release: deployed $commit"
