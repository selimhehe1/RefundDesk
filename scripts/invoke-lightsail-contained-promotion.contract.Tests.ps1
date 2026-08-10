Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Pester 3 does not make a directly executed test script fail the process.
# Re-enter exactly once with -EnableExit; the environment marker is inherited
# by the child that Pester uses to load this file and prevents recursion.
if ($env:REFUNDDESK_CONTAINED_PROMOTION_PESTER_CHILD -cne "1") {
    $previousPesterChild = $env:REFUNDDESK_CONTAINED_PROMOTION_PESTER_CHILD
    $env:REFUNDDESK_CONTAINED_PROMOTION_PESTER_CHILD = "1"
    try {
        $quotedScript = $PSCommandPath.Replace("'", "''")
        $command = "Import-Module Pester -ErrorAction Stop; Invoke-Pester -Script '$quotedScript' -EnableExit"
        & (Get-Process -Id $PID).Path -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $command
        $childExit = $LASTEXITCODE
    }
    finally { $env:REFUNDDESK_CONTAINED_PROMOTION_PESTER_CHILD = $previousPesterChild }
    exit $childExit
}

$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Wrapper = Join-Path $PSScriptRoot "invoke-lightsail-contained-promotion.ps1"
$Runner = Join-Path $Repository "deploy/lightsail/scripts/promote-contained-candidate.sh"
$InstallSource = Join-Path $Repository "deploy/lightsail/scripts/install-source.sh"
$CaddyTest = Join-Path $Repository "deploy/lightsail/scripts/test-caddy-origin-contract.sh"

function Get-TestSha256 {
    param([byte[]] $Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Set-TestRestrictedAcl {
    param([string] $Path)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return }
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = if ((Get-Item -LiteralPath $Path).PSIsContainer) {
        [Security.AccessControl.DirectorySecurity]::new()
    }
    else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($current)
    $isDirectory = (Get-Item -LiteralPath $Path).PSIsContainer
    $inheritance = if ($isDirectory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @(
        $current,
        [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
        [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    )) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        ))
    }
    if ($isDirectory) {
        [IO.Directory]::SetAccessControl($Path, $acl)
    }
    else { [IO.File]::SetAccessControl($Path, $acl) }
}

function Write-TestJson {
    param([string] $Path, $Value)
    $text = ($Value | ConvertTo-Json -Compress -Depth 100) + "`n"
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
    Set-TestRestrictedAcl $Path
    return [Text.UTF8Encoding]::new($false).GetBytes($text)
}

function New-WrapperFixture {
    $root = Join-Path ([IO.Path]::GetTempPath()) ("refunddesk-contained-wrapper-{0}" -f [guid]::NewGuid().ToString("N"))
    [void] [IO.Directory]::CreateDirectory($root)
    Set-TestRestrictedAcl $root
    $artifacts = Join-Path $root "artifacts"
    [void] [IO.Directory]::CreateDirectory($artifacts)
    Set-TestRestrictedAcl $artifacts
    $head = (& git -C $Repository rev-parse HEAD).Trim()
    $sourcePath = Join-Path $artifacts "refunddesk-source-$head.tar.zst"
    $sourceBytes = [Text.Encoding]::UTF8.GetBytes("fixture source archive`n")
    [IO.File]::WriteAllBytes($sourcePath, $sourceBytes); Set-TestRestrictedAcl $sourcePath
    $sourceSha = Get-TestSha256 $sourceBytes
    $sourceChecksumPath = "$sourcePath.sha256"
    [IO.File]::WriteAllText($sourceChecksumPath, "$sourceSha  refunddesk-source-$head.tar.zst`n", [Text.UTF8Encoding]::new($false)); Set-TestRestrictedAcl $sourceChecksumPath
    $bundleName = "refunddesk-sandbox-$head.images.tar.zst"
    $bundlePath = Join-Path $artifacts $bundleName
    $bundleBytes = [Text.Encoding]::UTF8.GetBytes("fixture bundle`n")
    [IO.File]::WriteAllBytes($bundlePath, $bundleBytes); Set-TestRestrictedAcl $bundlePath
    $bundleSha = Get-TestSha256 $bundleBytes
    $checksumPath = "$bundlePath.sha256"
    [IO.File]::WriteAllText($checksumPath, "$bundleSha  $bundleName`n", [Text.UTF8Encoding]::new($false)); Set-TestRestrictedAcl $checksumPath
    $manifestPath = Join-Path $artifacts "refunddesk-sandbox-$head.manifest.json"
    $manifestBytes = Write-TestJson $manifestPath ([ordered]@{
        bundle = [ordered]@{ file = $bundleName; sha256 = $bundleSha }
        createdAt = "2026-08-08T20:00:00Z"
        images = @(
            [ordered]@{ expectedUser = "node"; imageId = "sha256:$(('1' * 64) -join '')"; reference = "refunddesk-web:sandbox-$head"; role = "web" },
            [ordered]@{ expectedUser = "node"; imageId = "sha256:$(('2' * 64) -join '')"; reference = "refunddesk-worker:sandbox-$head"; role = "worker" },
            [ordered]@{ expectedUser = "node"; imageId = "sha256:$(('3' * 64) -join '')"; reference = "refunddesk-migrate:sandbox-$head"; role = "migrate" }
        )
        platform = "linux/amd64"; revision = $head; schemaVersion = 1
        source = "https://github.com/selimhehe1/RefundDesk"
    })
    $manifestSha = Get-TestSha256 $manifestBytes
    $attestationPath = Join-Path $root "attestation.sigstore.json"
    $attestationBytes = [Text.Encoding]::UTF8.GetBytes("fixture attestation bundle`n")
    [IO.File]::WriteAllBytes($attestationPath, $attestationBytes); Set-TestRestrictedAcl $attestationPath
    $attestationSha = Get-TestSha256 $attestationBytes
    $provenancePath = Join-Path $root "provenance.json"
    $provenanceBytes = Write-TestJson $provenancePath ([ordered]@{
        artifactId = 1; attestationBundleSha256 = $attestationSha; attestationId = 2
        bundleEvent = "workflow_dispatch"; bundleRunId = 3; bundleSha256 = $bundleSha
        bundleWorkflowPath = ".github/workflows/sandbox-images.yml"; ciEvent = "push"; ciRunId = 4
        ciWorkflowPath = ".github/workflows/ci.yml"; kind = "refunddesk-contained-promotion-input-provenance"; manifestSha256 = $manifestSha
        rekorEntryIndex = 5; repository = "selimhehe1/RefundDesk"; revision = $head; schemaVersion = 1
        sourceSha256 = $sourceSha; verification = "github-cli-sigstore-and-actions-api-verified"; verifiedAt = "2026-08-08T20:01:00Z"
    })
    $provenanceSha = Get-TestSha256 $provenanceBytes
    $databaseLine = "123456789012345678|0|0|0|0|0|0|7|3|4|5|6|9"
    $databaseSha = Get-TestSha256 ([Text.Encoding]::ASCII.GetBytes($databaseLine))
    $now = [DateTime]::UtcNow
    $promotionPath = Join-Path $root "promotion.json"
    $promotion = [ordered]@{
        code = "PASS_CONTAINED_CANDIDATE_PROMOTED"
        completedAt = $now.AddMinutes(-3).ToString("yyyy-MM-ddTHH:mm:ssZ")
        containment = [ordered]@{ caddyStopped = $true; liveDisabled = $true; maintenanceDisabled = $true; maintenanceStopped = $true; publicListenersAbsent = $true; timersDisabled = $true; verifierHealthy = $true; webHealthy = $true; workerStopped = $true }
        database = [ordered]@{ activeFinancialJobs = 0; activeWorkflows = 0; apiMutationReceipts = 6; auditEvents = 9; liveInstallations = 0; liveTenants = 0; preparedTransactions = 0; refundExecutionAttempts = 4; refundExecutions = 3; refundRequests = 7; snapshotSha256 = $databaseSha; stable = $true; systemIdentifier = "123456789012345678"; unreleasedPaymentGuards = 0; webhookReceipts = 5 }
        fromRevision = ("b" * 40) -join ""
        inputs = [ordered]@{ bundleSha256 = $bundleSha; manifestSha256 = $manifestSha; provenanceSha256 = $provenanceSha; sourceSha256 = $sourceSha }
        kind = "refunddesk-contained-promotion"; nonce = ("9" * 64) -join ""
        operationStartedAt = $now.AddMinutes(-4).ToString("yyyy-MM-ddTHH:mm:ssZ"); phase = "complete"
        redaction = [ordered]@{ customerDataPresent = $false; rawApiKeyPresent = $false; rawPayloadPresent = $false; rawSecretPresent = $false; rawSignaturePresent = $false; stderrPresent = $false }
        result = "PASS"; resumed = $false; revision = $head
        runtime = [ordered]@{ caddyContainerId = ("4" * 64) -join ""; postgresContainerId = ("5" * 64) -join ""; verifierContainerId = ("6" * 64) -join ""; webContainerId = ("7" * 64) -join ""; workerContainerId = ("8" * 64) -join ""; workerRuntimeMode = "incident_admission" }
        schemaVersion = 1; startedAt = $now.AddMinutes(-4).ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    [void] (Write-TestJson $promotionPath $promotion)
    function New-Postflight([DateTime] $CapturedAt, [DateTime] $ValidUntil, [string] $Result = "PASS") {
        $exitCode = if ($Result -ceq "PASS") { 0 } elseif ($Result -ceq "FAIL") { 20 } else { 21 }
        return [ordered]@{
            kind = "refunddesk.lightsail.host-postflight.capture"; result = $Result; admission = "FIXTURE_ONLY"
            posture = "COHERENT_CONTAINED"; capturedAt = $CapturedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
            validUntil = $ValidUntil.ToString("yyyy-MM-ddTHH:mm:ssZ")
            remote = [ordered]@{
                code = "PASS_CONTAINED"
                completedAt = $CapturedAt.AddSeconds(2).ToString("yyyy-MM-ddTHH:mm:ssZ")
                containment = [ordered]@{ liveDisabled = $true; workerStopped = $true; caddyStopped = $true; maintenanceStopped = $true; publicListenersClosed = $true }
                exitCode = $exitCode
                financial = [ordered]@{ stable = $true; quiescent = $true }
                captures = [ordered]@{ b = [ordered]@{ identity = [ordered]@{ activeRevision = $head } } }
                nonce = ("e" * 64) -join ""
                result = $Result
                startedAt = $CapturedAt.AddSeconds(1).ToString("yyyy-MM-ddTHH:mm:ssZ")
            }
            awsControlPlane = [ordered]@{ firewallClosedBefore = $true; firewallClosedAfter = $true; firewallUnchanged = $true }
        }
    }
    $preflightPath = Join-Path $root "preflight.json"
    [void] (Write-TestJson $preflightPath (New-Postflight $now.AddMinutes(-1) $now.AddMinutes(14)))
    $postflightPath = Join-Path $root "postflight.json"
    [void] (Write-TestJson $postflightPath (New-Postflight $now.AddMinutes(-2) $now.AddMinutes(13)))
    return [pscustomobject]@{
        Root = $root; Artifacts = $artifacts; Attestation = $attestationPath; Head = $head; Source = $sourcePath; Provenance = $provenancePath
        Preflight = $preflightPath; Promotion = $promotionPath; Postflight = $postflightPath
        Output = Join-Path $root "captured-promotion.json"; PromotionValue = $promotion
    }
}

function Invoke-WrapperFixture {
    param($Fixture, [int] $PostflightExitCode = 0, [string] $CrashAfter = "")
    $previous = $env:REFUNDDESK_CONTAINED_PROMOTION_CONTRACT_MODE
    $previousCrash = $env:REFUNDDESK_CONTAINED_PROMOTION_FIXTURE_CRASH_AFTER
    $env:REFUNDDESK_CONTAINED_PROMOTION_CONTRACT_MODE = "1"
    $env:REFUNDDESK_CONTAINED_PROMOTION_FIXTURE_CRASH_AFTER = $CrashAfter
    try {
        $stdout = Join-Path $Fixture.Root "stdout.txt"
        $stderr = Join-Path $Fixture.Root "stderr.txt"
        $process = Start-Process -FilePath (Get-Process -Id $PID).Path -WindowStyle Hidden -Wait -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr -ArgumentList @(
                "-NoLogo", "-NoProfile", "-NonInteractive", "-File", $Wrapper,
                "-PreflightEvidencePath", $Fixture.Preflight,
                "-CandidateProvenancePath", $Fixture.Provenance,
                "-AttestationBundlePath", $Fixture.Attestation,
                "-SourceArchivePath", $Fixture.Source,
                "-ArtifactDirectory", $Fixture.Artifacts,
                "-ExpectedSshCidr", "192.0.2.1/32",
                "-ContractFixture",
                "-FixturePromotionEvidencePath", $Fixture.Promotion,
                "-FixturePostflightEvidencePath", $Fixture.Postflight,
                "-FixtureOutputPath", $Fixture.Output,
                "-FixturePostflightExitCode", [string] $PostflightExitCode
            )
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = [IO.File]::ReadAllText($stdout); Stderr = [IO.File]::ReadAllText($stderr) }
    }
    finally {
        $env:REFUNDDESK_CONTAINED_PROMOTION_CONTRACT_MODE = $previous
        $env:REFUNDDESK_CONTAINED_PROMOTION_FIXTURE_CRASH_AFTER = $previousCrash
    }
}

function Set-FixturePostflightResult {
    param($Fixture, [ValidateSet("PASS", "FAIL", "INCOMPLETE")][string] $Result)
    $value = [IO.File]::ReadAllText($Fixture.Postflight) | ConvertFrom-Json
    $exitCode = if ($Result -ceq "PASS") { 0 } elseif ($Result -ceq "FAIL") { 20 } else { 21 }
    $value.result = $Result
    $value.remote.result = $Result
    $value.remote.exitCode = $exitCode
    [void] (Write-TestJson $Fixture.Postflight $value)
}

Describe "contained Lightsail promotion wrapper" {
    It "pins the complete source/bundle transport and refuses quiesce recovery" {
        $wrapperSource = [IO.File]::ReadAllText($Wrapper)
        $installSource = [IO.File]::ReadAllText($InstallSource)
        $runner = [IO.File]::ReadAllText($Runner)
        $caddy = [IO.File]::ReadAllText($CaddyTest)
        $wrapperSource | Should Match "SourceArchivePath"
        $wrapperSource | Should Match "ArtifactDirectory"
        $wrapperSource | Should Match "O_EXCL"
        $wrapperSource | Should Match "--no-quiesce-recovery"
        $wrapperSource | Should Match "--operator-lock-inherited"
        $wrapperSource | Should Match "acquire_operator_lock"
        @([regex]::Matches($wrapperSource, 'Invoke-BoundedProcess \$PinnedSshPath \(\$sshBase \+ @\(\$transactionCommand\)\)').Count) | Should Be 1
        $wrapperSource | Should Match "WORKTREE_NOT_CLEAN"
        $wrapperSource | Should Match "PINNED_SOURCE_NOT_HEAD"
        $wrapperSource | Should Match "MinimumPreflightLifetimeSeconds = 720"
        $wrapperSource | Should Match "--untracked-files=no"
        $wrapperSource | Should Not Match "--untracked-files=all"
        $wrapperSource | Should Match "0037-bounded-cloudfront-origin-window\.md"
        $wrapperSource | Should Match "Open-RestrictedCredentialLock"
        $wrapperSource | Should Match "bytes are deliberately never read or"
        $installSource | Should Match "--no-quiesce-recovery"
        $runner | Should Not Match "recover-quiesced-runtime\.sh[^:]"
        $caddy | Should Match 'source=\$\{CADDYFILE\},target=/etc/caddy/Caddyfile,readonly'
    }

    It "writes one CreateNew exact PASS evidence after a later contained postflight" {
        $fixture = New-WrapperFixture
        try {
            $result = Invoke-WrapperFixture $fixture
            if ($result.ExitCode -ne 0) { throw "fixture-wrapper-failed:$($result.Stderr):$($result.Stdout)" }
            $result.ExitCode | Should Be 0
            $result.Stdout.Trim() | Should Be "CONTAINED_PROMOTION_COMPLETE_PASS"
            [IO.File]::ReadAllText($fixture.Output) | Should Be ([IO.File]::ReadAllText($fixture.Promotion))
        }
        finally { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
    }

    It "fails before output when the preflight has less than 720 seconds remaining" {
        $fixture = New-WrapperFixture
        try {
            $value = [IO.File]::ReadAllText($fixture.Preflight) | ConvertFrom-Json
            $value.validUntil = [DateTime]::UtcNow.AddMinutes(10).ToString("yyyy-MM-ddTHH:mm:ssZ")
            [void] (Write-TestJson $fixture.Preflight $value)
            $result = Invoke-WrapperFixture $fixture
            $result.ExitCode | Should Be 1
            Test-Path -LiteralPath $fixture.Output | Should Be $false
        }
        finally { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
    }

    It "rejects a postflight captured before promotion completion" {
        $fixture = New-WrapperFixture
        try {
            $value = [IO.File]::ReadAllText($fixture.Postflight) | ConvertFrom-Json
            $value.capturedAt = ([DateTime]::Parse($fixture.PromotionValue.startedAt)).AddSeconds(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")
            [void] (Write-TestJson $fixture.Postflight $value)
            $result = Invoke-WrapperFixture $fixture
            $result.ExitCode | Should Be 1
            Test-Path -LiteralPath $fixture.Output | Should Be $false
        }
        finally { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
    }

    It "uses CreateNew so a racing or existing output is never overwritten" {
        $fixture = New-WrapperFixture
        try {
            [IO.File]::WriteAllText($fixture.Output, "sentinel`n")
            $result = Invoke-WrapperFixture $fixture
            $result.ExitCode | Should Be 1
            [IO.File]::ReadAllText($fixture.Output) | Should Be "sentinel`n"
        }
        finally { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
    }

    It "resumes the exact nonce-bound attempt after remote PASS receipt or postflight validation crashes" {
        foreach ($crashPoint in @("promotion_validated", "postflight_validated")) {
            $fixture = New-WrapperFixture
            try {
                $crashed = Invoke-WrapperFixture $fixture 0 $crashPoint
                $crashed.ExitCode | Should Be 99
                Test-Path -LiteralPath $fixture.Output | Should Be $false
                @(Get-ChildItem -LiteralPath $fixture.Root -Filter "contained-promotion-attempt-*.local.json").Count | Should Be 1
                $resumed = Invoke-WrapperFixture $fixture
                $resumed.ExitCode | Should Be 0
                [IO.File]::ReadAllText($fixture.Output) | Should Be ([IO.File]::ReadAllText($fixture.Promotion))
                $markers = @(Get-ChildItem -LiteralPath $fixture.Root -Filter "contained-promotion-attempt-*.local.json")
                $markers.Count | Should Be 1
                ([IO.File]::ReadAllText($markers[0].FullName) | ConvertFrom-Json).status | Should Be "complete"
            }
            finally { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
        }
    }

    It "consumes a completed candidate exactly once and a second invocation is read-only" {
        $fixture = New-WrapperFixture
        try {
            $first = Invoke-WrapperFixture $fixture
            $first.ExitCode | Should Be 0
            $marker = @(Get-ChildItem -LiteralPath $fixture.Root -Filter "contained-promotion-attempt-*.local.json")
            $marker.Count | Should Be 1
            $markerBefore = [IO.File]::ReadAllBytes($marker[0].FullName)
            $outputBefore = [IO.File]::ReadAllBytes($fixture.Output)
            $second = Invoke-WrapperFixture $fixture 0 "promotion_validated"
            $second.ExitCode | Should Be 0
            $second.Stdout.Trim() | Should Be "CONTAINED_PROMOTION_ALREADY_COMPLETE_PASS"
            (Get-TestSha256 ([IO.File]::ReadAllBytes($marker[0].FullName))) | Should Be (Get-TestSha256 $markerBefore)
            (Get-TestSha256 ([IO.File]::ReadAllBytes($fixture.Output))) | Should Be (Get-TestSha256 $outputBefore)
        }
        finally { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
    }

    It "writes strict postflight FAIL and INCOMPLETE outcomes and resumes to PASS" {
        foreach ($mapping in @(@("FAIL", 20), @("INCOMPLETE", 21))) {
            $fixture = New-WrapperFixture
            try {
                Set-FixturePostflightResult $fixture $mapping[0]
                $failed = Invoke-WrapperFixture $fixture $mapping[1]
                $failed.ExitCode | Should Be $mapping[1]
                Test-Path -LiteralPath $fixture.Output | Should Be $false
                @(Get-ChildItem -LiteralPath $fixture.Root -Filter "contained-promotion-outcome-*-postflight.local.json").Count | Should Be 1
                Set-FixturePostflightResult $fixture "PASS"
                $resumed = Invoke-WrapperFixture $fixture
                $resumed.ExitCode | Should Be 0
                [IO.File]::ReadAllText($fixture.Output) | Should Be ([IO.File]::ReadAllText($fixture.Promotion))
            }
            finally { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
        }
    }

    It "rejects an extra permissive input ACE on Windows" -Skip:([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        $fixture = New-WrapperFixture
        try {
            $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl = [Security.AccessControl.FileSecurity]::new()
            $acl.SetAccessRuleProtection($true, $false)
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current, "FullControl", "Allow"))
            $everyone = [Security.Principal.SecurityIdentifier]::new("S-1-1-0")
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, "Read", "Allow"))
            [IO.File]::SetAccessControl($fixture.Provenance, $acl)
            $result = Invoke-WrapperFixture $fixture
            $result.ExitCode | Should Be 1
            Test-Path -LiteralPath $fixture.Output | Should Be $false
        }
        finally { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
    }

    It "rejects deny ACEs and enabled ACL inheritance without reading the SACL" -Skip:([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        foreach ($mode in @("deny", "inherited")) {
            $fixture = New-WrapperFixture
            try {
                $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
                $acl = Get-Acl -LiteralPath $fixture.Provenance
                if ($mode -ceq "deny") {
                    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                        $current,
                        [Security.AccessControl.FileSystemRights]::Read,
                        [Security.AccessControl.AccessControlType]::Deny
                    ))
                }
                else { $acl.SetAccessRuleProtection($false, $true) }
                [IO.File]::SetAccessControl($fixture.Provenance, $acl)
                $result = Invoke-WrapperFixture $fixture
                $result.ExitCode | Should Be 1
                Test-Path -LiteralPath $fixture.Output | Should Be $false
            }
            finally { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
        }
    }
}
