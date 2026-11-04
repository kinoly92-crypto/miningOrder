[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$key = Join-Path $env:USERPROFILE '.ssh\order-record-deploy'
$hostName = 'orderdeploy@47.108.254.13'
$remoteBase = '/var/lib/order-record-deploy'
$sshOptions = @('-i', $key, '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no', '-o', 'StrictHostKeyChecking=yes')

function Run-Native {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE." }
}

if (-not (Test-Path -LiteralPath $key -PathType Leaf)) { throw 'Deployment SSH key not found.' }
$commit = (& git -C $repo rev-parse --verify 'HEAD^{commit}').Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve HEAD.' }
Write-Host "Commit to publish: $commit"
Write-Host 'Only this committed version will be built. Uncommitted and staged changes are excluded.'
Write-Host 'Review the commit and confirm that it has no database schema or data migration.'
if ((Read-Host 'Type RELEASE to continue') -cne 'RELEASE') { throw 'Release cancelled.' }

$current = (& ssh @sshOptions $hostName 'systemctl show order-record.service -p WorkingDirectory --value')
if ($LASTEXITCODE -ne 0 -or $current.Count -ne 1) { throw 'Could not identify the production version.' }
$currentName = ($current.Trim() -split '/')[-1]
if ($currentName -notmatch '^[0-9a-f]{7,40}$') { throw 'Production directory is not a recognized Git version; stop for manual review.' }
$baseline = (& git -C $repo rev-parse --verify "${currentName}^{commit}")
if ($LASTEXITCODE -ne 0 -or $baseline -notmatch '^[0-9a-f]{40}$') { throw 'Production commit is not available locally.' }
$dbChanges = @(& git -C $repo diff --name-only $baseline $commit -- server/src/mysql-schema.ts server/src/migrate-sqlite-to-mysql.ts server/src/storage.ts server/src/mysql-config.ts)
if ($LASTEXITCODE -ne 0) { throw 'Could not compare database files.' }
if ($dbChanges.Count -gt 0 -and $env:ORDER_RECORD_SKIP_DB_CHECK -ne '1') {
  throw "Database-related files changed; manual review required: $($dbChanges -join ', '). Set ORDER_RECORD_SKIP_DB_CHECK=1 only after the migration is applied."
}
if ($dbChanges.Count -gt 0) {
  Write-Host 'Database files changed but ORDER_RECORD_SKIP_DB_CHECK=1 is set; assuming migration already applied.'
}
if ($baseline -eq $commit) { throw 'This commit is already deployed.' }

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("order-record-release-" + [guid]::NewGuid().ToString('N'))
$work = Join-Path $temp 'work'
$sourceTar = Join-Path $temp "$commit-source.tar"
$distTar = Join-Path $temp "$commit-dist.tar"
try {
    New-Item -ItemType Directory -Path $work | Out-Null
    Run-Native git @('-C', $repo, 'archive', '--format=tar', "--output=$sourceTar", $commit)
    Run-Native tar.exe @('-xf', $sourceTar, '-C', $work)
    $prepare = Join-Path $work 'deploy\prepare-release.sh'
    if ([IO.File]::ReadAllBytes($prepare) -contains [byte]13) {
        throw 'The archived Linux preparation script has invalid line endings.'
    }
    Push-Location $work
    try {
        Run-Native npm.cmd @('ci', '--include=dev', '--no-audit', '--no-fund')
        Run-Native npm.cmd @('run', 'typecheck')
        Run-Native npm.cmd @('run', 'test:security')
        Run-Native npm.cmd @('run', 'test:board')
        Run-Native node @('--import', 'tsx', '--test', 'tests/business-rules.test.mjs')
        Run-Native npm.cmd @('run', 'build')
    } finally {
        Pop-Location
    }
    Run-Native tar.exe @('-cf', $distTar, '-C', (Join-Path $work 'dist'), '.')
    $sourceHash = (Get-FileHash -LiteralPath $sourceTar -Algorithm SHA256).Hash.ToLowerInvariant()
    $distHash = (Get-FileHash -LiteralPath $distTar -Algorithm SHA256).Hash.ToLowerInvariant()
    $target = "${hostName}:$remoteBase/incoming/"
    Run-Native scp ($sshOptions + @($sourceTar, $distTar, $prepare, $target))
    $command = "bash $remoteBase/incoming/prepare-release.sh $commit $sourceHash $distHash && sudo -n /usr/local/sbin/order-record-release $commit"
    Run-Native ssh ($sshOptions + @($hostName, $command))
    Write-Host "Release completed: $commit"
    Write-Host 'Verify the public site and sign in. Git push is a separate operation.'
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
