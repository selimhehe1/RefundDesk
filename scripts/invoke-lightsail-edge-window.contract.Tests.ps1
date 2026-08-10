[CmdletBinding()]
param(
    [Parameter()]
    [switch] $NoStdoutRecoveryOnly,
    [Parameter()]
    [switch] $TransportBindingOnly,
    [Parameter()]
    [switch] $InputAdmissionOnly,
    [Parameter()]
    [switch] $OperatorClockOnly,
    [Parameter()]
    [switch] $ShortFixtureOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$targetedContractCount = 0
foreach ($selection in @($NoStdoutRecoveryOnly, $TransportBindingOnly, $InputAdmissionOnly, $OperatorClockOnly, $ShortFixtureOnly)) {
    if ([bool] $selection) { $targetedContractCount += 1 }
}
if ($targetedContractCount -gt 1) { throw "targeted contract switches are mutually exclusive" }
$skipShortContract = [bool] ($NoStdoutRecoveryOnly -or $TransportBindingOnly -or $InputAdmissionOnly -or $OperatorClockOnly)

$failures = [Collections.Generic.List[string]]::new()
$runningProductionFixtures = [Collections.Generic.List[object]]::new()
function Assert-Contract([bool] $Condition, [string] $Message) {
    if (-not $Condition) { $failures.Add($Message) }
}
function Assert-Contains([string] $Text, [string] $Needle, [string] $Message) {
    Assert-Contract ($Text.IndexOf($Needle, [StringComparison]::Ordinal) -ge 0) $Message
}
function Set-TestAcl([string] $Path) {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($current)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @(
        $current,
        [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
        [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    )) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        ))
    }
    [IO.Directory]::SetAccessControl($Path, $acl)
}
function Set-TestFileAcl([string] $Path) {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($current)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @(
        $current,
        [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
        [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    )) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        ))
    }
    [IO.File]::SetAccessControl($Path, $acl)
}
function Sort-TestJsonValue([AllowNull()] $Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        [string[]] $keys = @($Value.Keys | ForEach-Object { [string] $_ })
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        foreach ($key in $keys) { $ordered[$key] = Sort-TestJsonValue $Value[$key] }
        return $ordered
    }
    if ($Value -is [Management.Automation.PSCustomObject]) {
        $ordered = [ordered]@{}
        [string[]] $keys = @($Value.PSObject.Properties.Name)
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        foreach ($key in $keys) { $ordered[$key] = Sort-TestJsonValue $Value.$key }
        return $ordered
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
        $items = @($Value | ForEach-Object { Sort-TestJsonValue $_ })
        return ,$items
    }
    return $Value
}
function Canonical($Value) {
    $sorted = Sort-TestJsonValue $Value
    return ((ConvertTo-Json -InputObject $sorted -Compress -Depth 100) + "`n")
}
function Test-Sha256Bytes([byte[]] $Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function Test-FileSha256([string] $Path) { return Test-Sha256Bytes ([IO.File]::ReadAllBytes($Path)) }
function Test-TextSha256([string] $Text) { return Test-Sha256Bytes ([Text.UTF8Encoding]::new($false).GetBytes($Text)) }
function Write-TestJson([string] $Path, $Value) {
    [IO.File]::WriteAllText($Path, (Canonical $Value), [Text.UTF8Encoding]::new($false))
}
function Copy-TestContext($Context) {
    $copy = [ordered]@{}
    foreach ($property in $Context.PSObject.Properties) { $copy[$property.Name] = $property.Value }
    return [pscustomobject] $copy
}
function New-FreshAdmissionContext($Context, [string] $Leaf) {
    if ($Leaf -notmatch "^[A-Za-z0-9._-]{1,96}$") { throw "unsafe fresh admission fixture leaf" }
    $fresh = Copy-TestContext $Context
    $now = [DateTime]::UtcNow
    $preflightCapturedAt = $now.AddSeconds(-60).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $preflightValidUntil = $now.AddMinutes(14).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $incidentCapturedAt = $now.AddSeconds(-50).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $incidentCompletedAt = $now.AddSeconds(-45).ToString("yyyy-MM-ddTHH:mm:ssZ")

    $preflight = Get-Content -LiteralPath $Context.PreflightPath -Raw | ConvertFrom-Json
    $preflight.capturedAt = $preflightCapturedAt
    $preflight.validUntil = $preflightValidUntil
    $preflightPath = Join-Path $Context.InputRoot "preflight-fresh-$Leaf.json"
    Write-TestJson $preflightPath $preflight
    Set-TestFileAcl $preflightPath
    $preflightSha256 = Test-FileSha256 $preflightPath

    $incident = Get-Content -LiteralPath $Context.IncidentPath -Raw | ConvertFrom-Json
    $incident.capturedAt = $incidentCapturedAt
    $incident.validUntil = $preflightValidUntil
    $incident.remote.completedAt = $incidentCompletedAt
    $incident.finalPostflight.awsControlPlane = $preflight.awsControlPlane
    $incident.finalPostflight.capturedAt = $preflightCapturedAt
    $incident.finalPostflight.provenance = $preflight.provenance
    $incident.finalPostflight.sha256 = $preflightSha256
    $incident.finalPostflight.validUntil = $preflightValidUntil
    $incidentPath = Join-Path $Context.InputRoot "incident-fresh-$Leaf.json"
    Write-TestJson $incidentPath $incident
    Set-TestFileAcl $incidentPath

    $authorization = Get-Content -LiteralPath $Context.AuthorizationPath -Raw | ConvertFrom-Json
    $authorization.validFrom = $now.AddMinutes(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $authorization.validUntil = $now.AddMinutes(110).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $authorizationPath = Join-Path $Context.InputRoot "authorization-fresh-$Leaf.json"
    Write-TestJson $authorizationPath $authorization
    Set-TestFileAcl $authorizationPath

    $fresh.PreflightPath = $preflightPath
    $fresh.PreflightSha256 = $preflightSha256
    $fresh.IncidentPath = $incidentPath
    $fresh.IncidentSha256 = Test-FileSha256 $incidentPath
    $fresh.AuthorizationPath = $authorizationPath
    $fresh.AuthorizationSha256 = Test-FileSha256 $authorizationPath
    return $fresh
}
function Invoke-CheckpointSubmit([string] $ScriptPath, [string] $RequestPath, [string] $CheckpointPath, [string] $ErrorPath) {
    foreach ($value in @($ScriptPath, $RequestPath, $CheckpointPath)) {
        if ($value.Contains("'")) { throw "unsafe test path" }
    }
    $command = "& '$ScriptPath' -RequestPath '$RequestPath' -CheckpointPath '$CheckpointPath' -HttpStatus 200 -Duplicate " + '$true' + "`nexit `$LASTEXITCODE`n"
    $launcher = "$ErrorPath.launch.ps1"
    [IO.File]::WriteAllText($launcher, $command, [Text.UTF8Encoding]::new($false))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = "$PSHOME\powershell.exe"
    $start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "submit process start failed" }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        [IO.File]::WriteAllText($ErrorPath, $stderr, [Text.UTF8Encoding]::new($false))
        return $process.ExitCode
    }
    finally { $process.Dispose() }
}
function Invoke-WrapperFixture(
    [string] $ScriptPath,
    [string] $Revision,
    [string] $FixturePath,
    [string] $OutputPath,
    [string] $CheckpointPath,
    [string] $CrashAfter,
    [string] $CapturePrefix
) {
    foreach ($value in @($ScriptPath, $FixturePath, $OutputPath, $CheckpointPath, $CapturePrefix)) {
        if ($value.Contains("'")) { throw "unsafe test path" }
    }
    $digest = "1" * 64
    $arguments = @(
        "-ExpectedRevision '$Revision'",
        "-IncidentEvidencePath '$FixturePath'", "-ExpectedIncidentEvidenceSha256 '$digest'",
        "-PreflightEvidencePath '$FixturePath'", "-ExpectedPreflightEvidenceSha256 '$digest'",
        "-PromotionEvidencePath '$FixturePath'", "-ExpectedPromotionEvidenceSha256 '$digest'",
        "-PromotionNonce '$digest'", "-ExpectedBundleSha256 '$digest'", "-ExpectedManifestSha256 '$digest'",
        "-ExpectedPromotionProvenanceSha256 '$digest'", "-ExpectedSourceSha256 '$digest'",
        "-AuthorizationPath '$FixturePath'", "-ExpectedAuthorizationSha256 '$digest'",
        "-OperatorArchivePath '$FixturePath'", "-ExpectedOperatorArchiveSha256 '$digest'",
        "-OperatorArchiveSidecarPath '$FixturePath'", "-ExpectedOperatorArchiveSidecarSha256 '$digest'",
        "-OperatorManifestPath '$FixturePath'", "-ExpectedOperatorManifestSha256 '$digest'",
        "-OperatorAttestationBundlePath '$FixturePath'", "-ExpectedOperatorAttestationBundleSha256 '$digest'",
        "-OperatorProvenancePath '$FixturePath'", "-ExpectedOperatorProvenanceSha256 '$digest'",
        "-GitHubTokenPath '$FixturePath'", "-AwsCredentialsPath '$FixturePath'", "-AwsProfile 'default'",
        "-SshIdentityPath '$FixturePath'", "-SshKnownHostsPath '$FixturePath'",
        "-ExpectedSshCidr '192.0.2.44/32'", "-WorkbenchCheckpointPath '$CheckpointPath'",
        "-OutputDirectory '$OutputPath'", "-ContractFixture", "-FixtureFinalEvidencePath '$FixturePath'",
        "-FixtureCrashAfter '$CrashAfter'"
    )
    $launcher = "$CapturePrefix.launch.ps1"
    $stdoutPath = "$CapturePrefix.stdout"
    $stderrPath = "$CapturePrefix.stderr"
    $command = "& '$ScriptPath' " + ($arguments -join " ") + "`nexit `$LASTEXITCODE`n"
    [IO.File]::WriteAllText($launcher, $command, [Text.UTF8Encoding]::new($false))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = "$PSHOME\powershell.exe"
    $start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "wrapper fixture process start failed" }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        if (-not $process.WaitForExit(60000)) { throw "wrapper fixture process timeout" }
        [IO.File]::WriteAllText($stdoutPath, $stdout, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($stderrPath, $stderr, [Text.UTF8Encoding]::new($false))
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
    }
    finally { $process.Dispose() }
}

function Start-ProductionWrapperFixture(
    $Context,
    [string] $TerminalPath,
    [string] $OutputPath,
    [string] $CheckpointPath,
    [string] $CrashAfter,
    [string] $CapturePrefix,
    [int] $ClockAdvanceSeconds = 0,
    [int] $PostMarkerWallClockOffsetSeconds = 0,
    [long] $PostMarkerMonotonicAdvanceMilliseconds = 0,
    [long] $PreRunnerStartMonotonicAdvanceMilliseconds = 0,
    [long] $RunnerMonitorMonotonicAdvanceMilliseconds = 0,
    [string] $PostMarkerBootIdentifierSha256 = ""
) {
    foreach ($value in @($Context.WrapperPath, $Context.FixtureRoot, $TerminalPath, $OutputPath, $CheckpointPath, $CapturePrefix)) {
        if ([string] $value -match "'") { throw "unsafe production fixture path" }
    }
    $arguments = @(
        "-ExpectedRevision '$($Context.Revision)'",
        "-IncidentEvidencePath '$($Context.IncidentPath)'", "-ExpectedIncidentEvidenceSha256 '$($Context.IncidentSha256)'",
        "-PreflightEvidencePath '$($Context.PreflightPath)'", "-ExpectedPreflightEvidenceSha256 '$($Context.PreflightSha256)'",
        "-PromotionEvidencePath '$($Context.PromotionPath)'", "-ExpectedPromotionEvidenceSha256 '$($Context.PromotionSha256)'",
        "-PromotionNonce '$($Context.PromotionNonce)'", "-ExpectedBundleSha256 '$($Context.BundleSha256)'",
        "-ExpectedManifestSha256 '$($Context.ManifestSha256)'", "-ExpectedPromotionProvenanceSha256 '$($Context.PromotionProvenanceSha256)'",
        "-ExpectedSourceSha256 '$($Context.SourceSha256)'",
        "-AuthorizationPath '$($Context.AuthorizationPath)'", "-ExpectedAuthorizationSha256 '$($Context.AuthorizationSha256)'",
        "-OperatorArchivePath '$($Context.OperatorArchivePath)'", "-ExpectedOperatorArchiveSha256 '$($Context.OperatorArchiveSha256)'",
        "-OperatorArchiveSidecarPath '$($Context.OperatorArchiveSidecarPath)'", "-ExpectedOperatorArchiveSidecarSha256 '$($Context.OperatorArchiveSidecarSha256)'",
        "-OperatorManifestPath '$($Context.OperatorManifestPath)'", "-ExpectedOperatorManifestSha256 '$($Context.OperatorManifestSha256)'",
        "-OperatorAttestationBundlePath '$($Context.AttestationPath)'", "-ExpectedOperatorAttestationBundleSha256 '$($Context.AttestationSha256)'",
        "-OperatorProvenancePath '$($Context.OperatorProvenancePath)'", "-ExpectedOperatorProvenanceSha256 '$($Context.OperatorProvenanceSha256)'",
        "-GitHubTokenPath '$($Context.GitHubTokenPath)'", "-AwsCredentialsPath '$($Context.AwsCredentialsPath)'", "-AwsProfile 'default'",
        "-SshIdentityPath '$($Context.SshIdentityPath)'", "-SshKnownHostsPath '$($Context.KnownHostsPath)'",
        "-ExpectedSshCidr '192.0.2.44/32'", "-WorkbenchCheckpointPath '$CheckpointPath'",
        "-OutputDirectory '$OutputPath'", "-WindowSeconds 60", "-ContractFixture",
        "-FixtureToolDirectory '$($Context.FixtureRoot)'", "-FixtureFinalEvidencePath '$TerminalPath'",
        "-FixtureCrashAfter '$CrashAfter'", "-FixtureClockAdvanceSeconds $ClockAdvanceSeconds",
        "-FixturePostMarkerWallClockOffsetSeconds $PostMarkerWallClockOffsetSeconds",
        "-FixturePostMarkerMonotonicAdvanceMilliseconds $PostMarkerMonotonicAdvanceMilliseconds",
        "-FixturePreRunnerStartMonotonicAdvanceMilliseconds $PreRunnerStartMonotonicAdvanceMilliseconds",
        "-FixtureRunnerMonitorMonotonicAdvanceMilliseconds $RunnerMonitorMonotonicAdvanceMilliseconds"
    )
    if (-not [string]::IsNullOrWhiteSpace($PostMarkerBootIdentifierSha256)) {
        if ($PostMarkerBootIdentifierSha256 -cnotmatch "^[0-9a-f]{64}$") { throw "unsafe fixture boot hash" }
        $arguments += "-FixturePostMarkerBootIdentifierSha256 '$PostMarkerBootIdentifierSha256'"
    }
    $launcher = "$CapturePrefix.launch.ps1"
    $command = "& '$($Context.WrapperPath)' " + ($arguments -join " ") + "`nexit `$LASTEXITCODE`n"
    [IO.File]::WriteAllText($launcher, $command, [Text.UTF8Encoding]::new($false))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = "$PSHOME\powershell.exe"
    $start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { $process.Dispose(); throw "production wrapper fixture process start failed" }
    $running = [pscustomobject]@{ Prefix = $CapturePrefix; Process = $process }
    $runningProductionFixtures.Add($running)
    return $running
}
function Stop-ProductionWrapperFixture($Running) {
    $process = $Running.Process
    if ($null -eq $process -or $process.HasExited) { return }
    try { & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null } catch {}
    try { [void] $process.WaitForExit(10000) } catch {}
}
function Complete-ProductionWrapperFixture($Running, [int] $TimeoutMilliseconds = 360000) {
    $process = $Running.Process
    try {
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            Stop-ProductionWrapperFixture $Running
            throw "production wrapper fixture process timeout"
        }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        [IO.File]::WriteAllText("$($Running.Prefix).stdout", $stdout, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText("$($Running.Prefix).stderr", $stderr, [Text.UTF8Encoding]::new($false))
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
    }
    finally {
        [void] $runningProductionFixtures.Remove($Running)
        $process.Dispose()
    }
}
function Wait-ProductionRequest([string] $OutputPath, [string] $Revision, $Running, [int] $TimeoutSeconds = 180) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $requests = @(Get-ChildItem -LiteralPath $OutputPath -Filter "edge-window-workbench-request-$Revision-*.local.json" -File -ErrorAction SilentlyContinue)
        if ($requests.Count -eq 1) { return $requests[0].FullName }
        if ($null -ne $Running -and $Running.Process.HasExited) { throw "production fixture exited before Workbench request" }
        Start-Sleep -Milliseconds 100
    }
    throw "production fixture Workbench request timeout"
}
function Invoke-ProductionTerminalScenario($Context, [string] $TerminalPath, [string] $Leaf, [string] $SubmitPath) {
    $Context = New-FreshAdmissionContext $Context $Leaf
    $output = Join-Path $Context.TestRoot "production-output-$Leaf"
    [void] [IO.Directory]::CreateDirectory($output)
    Set-TestAcl $output
    $checkpoint = Join-Path $output "checkpoint.json"
    $running = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "none" (Join-Path $Context.TestRoot "production-$Leaf")
    try { $request = Wait-ProductionRequest $output $Context.Revision $running }
    catch {
        if ($running.Process.HasExited) {
            $early = Complete-ProductionWrapperFixture $running
            throw "production fixture $Leaf exited before Workbench request: exit=$($early.ExitCode) stderr=$($early.Stderr.Trim())"
        }
        Stop-ProductionWrapperFixture $running
        [void] $runningProductionFixtures.Remove($running)
        $running.Process.Dispose()
        throw
    }
    $submitStatus = Invoke-CheckpointSubmit $SubmitPath $request $checkpoint (Join-Path $Context.TestRoot "production-$Leaf-submit.stderr")
    if ($submitStatus -ne 0) { throw "production fixture checkpoint submission failed for $Leaf" }
    $result = Complete-ProductionWrapperFixture $running
    return [pscustomobject]@{ Checkpoint = $checkpoint; Output = $output; Result = $result }
}

function New-OperatorClockAdmissionContext($Context, [string] $Leaf) {
    $fresh = New-FreshAdmissionContext $Context $Leaf
    $authorization = Get-Content -LiteralPath $fresh.AuthorizationPath -Raw | ConvertFrom-Json
    # The staged wall rollback is deliberately larger than the ordinary
    # fixture skew. Keep authority valid on both sides so only the monotonic
    # budget decides whether a new runner may start.
    $authorization.validFrom = [DateTime]::UtcNow.AddMinutes(-15).ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-TestJson $fresh.AuthorizationPath $authorization
    Set-TestFileAcl $fresh.AuthorizationPath
    $fresh.AuthorizationSha256 = Test-FileSha256 $fresh.AuthorizationPath
    return $fresh
}

function Invoke-OperatorClockTerminalScenario(
    $Context,
    [string] $TerminalPath,
    [string] $Leaf,
    [string] $SubmitPath,
    [int] $PostMarkerWallClockOffsetSeconds = 0,
    [long] $PostMarkerMonotonicAdvanceMilliseconds = 0,
    [long] $PreRunnerStartMonotonicAdvanceMilliseconds = 0
) {
    $clockContext = New-OperatorClockAdmissionContext $Context $Leaf
    $output = Join-Path $clockContext.TestRoot "production-output-$Leaf"
    [void] [IO.Directory]::CreateDirectory($output)
    Set-TestAcl $output
    $checkpoint = Join-Path $output "checkpoint.json"
    $running = Start-ProductionWrapperFixture -Context $clockContext -TerminalPath $TerminalPath -OutputPath $output `
        -CheckpointPath $checkpoint -CrashAfter "none" -CapturePrefix (Join-Path $clockContext.TestRoot "production-$Leaf") `
        -PostMarkerWallClockOffsetSeconds $PostMarkerWallClockOffsetSeconds `
        -PostMarkerMonotonicAdvanceMilliseconds $PostMarkerMonotonicAdvanceMilliseconds `
        -PreRunnerStartMonotonicAdvanceMilliseconds $PreRunnerStartMonotonicAdvanceMilliseconds
    $request = Wait-ProductionRequest $output $clockContext.Revision $running
    $submitStatus = Invoke-CheckpointSubmit $SubmitPath $request $checkpoint (Join-Path $clockContext.TestRoot "production-$Leaf-submit.stderr")
    if ($submitStatus -ne 0) { throw "operator clock fixture checkpoint submission failed for $Leaf" }
    $result = Complete-ProductionWrapperFixture $running
    return [pscustomobject]@{ Context = $clockContext; Output = $output; Result = $result }
}

function Invoke-OperatorClockNoStartScenario(
    $Context,
    [string] $TerminalPath,
    [string] $Leaf,
    [long] $PostMarkerMonotonicAdvanceMilliseconds = 0,
    [long] $PreRunnerStartMonotonicAdvanceMilliseconds = 0,
    [string] $PostMarkerBootIdentifierSha256 = ""
) {
    $clockContext = New-OperatorClockAdmissionContext $Context $Leaf
    $output = Join-Path $clockContext.TestRoot "production-output-$Leaf"
    [void] [IO.Directory]::CreateDirectory($output)
    Set-TestAcl $output
    $running = Start-ProductionWrapperFixture -Context $clockContext -TerminalPath $TerminalPath -OutputPath $output `
        -CheckpointPath (Join-Path $output "checkpoint.json") -CrashAfter "none" `
        -CapturePrefix (Join-Path $clockContext.TestRoot "production-$Leaf") `
        -PostMarkerMonotonicAdvanceMilliseconds $PostMarkerMonotonicAdvanceMilliseconds `
        -PreRunnerStartMonotonicAdvanceMilliseconds $PreRunnerStartMonotonicAdvanceMilliseconds `
        -PostMarkerBootIdentifierSha256 $PostMarkerBootIdentifierSha256
    $result = Complete-ProductionWrapperFixture $running
    return [pscustomobject]@{ Context = $clockContext; Output = $output; Result = $result }
}

function Invoke-UncommittedInputCrashScenario(
    $Context,
    [string] $TerminalPath,
    [string] $CrashAfter,
    [string] $Leaf,
    [int] $ResumeClockAdvanceSeconds = 0
) {
    $Context = New-FreshAdmissionContext $Context $Leaf
    if ($ResumeClockAdvanceSeconds -gt 0) {
        # Keep the exact same authority bytes for both invocations while making
        # the old current-time-plus-35-minute precheck observably wrong.
        $authorization = Get-Content -LiteralPath $Context.AuthorizationPath -Raw | ConvertFrom-Json
        $authorization.validUntil = [DateTime]::UtcNow.AddMinutes(40).ToString("yyyy-MM-ddTHH:mm:ssZ")
        Write-TestJson $Context.AuthorizationPath $authorization
        Set-TestFileAcl $Context.AuthorizationPath
        $Context.AuthorizationSha256 = Test-FileSha256 $Context.AuthorizationPath
    }
    $output = Join-Path $Context.TestRoot "production-output-$Leaf"
    [void] [IO.Directory]::CreateDirectory($output)
    Set-TestAcl $output
    $checkpoint = Join-Path $output "checkpoint.json"
    $operationsPath = Join-Path $Context.FixtureRoot "operations.jsonl"
    $operationCountBefore = if ([IO.File]::Exists($operationsPath)) { @(Get-Content -LiteralPath $operationsPath).Count } else { 0 }

    $crashed = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint $CrashAfter (Join-Path $Context.TestRoot "$Leaf-crash")
    $crashResult = Complete-ProductionWrapperFixture $crashed
    Assert-Contract ($crashResult.ExitCode -eq 99) "$CrashAfter must hard-crash before immutable input digests are journaled"

    $markers = @(Get-ChildItem -LiteralPath $output -Filter "edge-window-attempt-$($Context.Revision)-*.local.json" -File)
    if ($markers.Count -ne 1) { throw "$CrashAfter did not leave exactly one durable attempt marker" }
    $marker = Get-Content -LiteralPath $markers[0].FullName -Raw | ConvertFrom-Json
    $digestValues = @(
        $marker.immutableInputs.awsConfigSha256,
        $marker.immutableInputs.controlSha256,
        $marker.immutableInputs.sshConfigSha256,
        $marker.immutableInputs.transportSha256
    )
    Assert-Contract (@($digestValues | Where-Object { $null -eq $_ }).Count -eq 4) "$CrashAfter must leave every immutable input digest uncommitted"
    $stateVolumePath = Join-Path (Join-Path $Context.FixtureRoot "fake-volumes") ([string] $marker.volume)
    $inputVolumePath = Join-Path (Join-Path $Context.FixtureRoot "fake-volumes") ([string] $marker.inputVolume)
    $containerPath = Join-Path (Join-Path $Context.FixtureRoot "fake-containers") ([string] $marker.containerName)
    Assert-Contract ([IO.Directory]::Exists($stateVolumePath) -and [IO.Directory]::Exists($inputVolumePath) -and
        -not [IO.Directory]::Exists($containerPath)) "$CrashAfter must occur with both private volumes present and no runner container"
    Assert-Contract (-not [IO.File]::Exists($checkpoint) -and
        @(Get-ChildItem -LiteralPath $output -Filter "edge-window-workbench-request-*.local.json" -File).Count -eq 0) "$CrashAfter must precede every public-window checkpoint request"

    $operationCountBeforeResume = @(Get-Content -LiteralPath $operationsPath).Count
    $resumed = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "none" (Join-Path $Context.TestRoot "$Leaf-resume") $ResumeClockAdvanceSeconds
    $resumeResult = Complete-ProductionWrapperFixture $resumed
    $closedMarker = Get-Content -LiteralPath $markers[0].FullName -Raw | ConvertFrom-Json
    Assert-Contract ($resumeResult.ExitCode -eq 21 -and $resumeResult.Stderr.Contains("ATTEMPT_CLEANUP_COMPLETE_NO_REOPEN") -and
        $closedMarker.state -ceq "cleanup_complete" -and $closedMarker.localCleanupComplete -eq $true -and
        $null -eq $closedMarker.evidenceFile -and $null -eq $closedMarker.evidenceSha256) "$CrashAfter recovery must durably close cleanup-only with exact exit 21"
    Assert-Contract (-not [IO.Directory]::Exists($stateVolumePath) -and -not [IO.Directory]::Exists($inputVolumePath) -and
        -not [IO.Directory]::Exists($containerPath)) "$CrashAfter recovery must leave no state volume, input volume or runner container"
    Assert-Contract (@(Get-ChildItem -LiteralPath $output -Filter "edge-window-$($Context.Revision)-*.local.json" -File).Count -eq 0) "$CrashAfter recovery must not invent terminal evidence"

    $newOperations = @(
        Get-Content -LiteralPath $operationsPath | Select-Object -Skip $operationCountBefore | ForEach-Object { $_ | ConvertFrom-Json }
    )
    $runnerOperations = @($newOperations | Where-Object {
        $dockerArguments = @($_.arguments)
        $offset = if ($dockerArguments.Count -ge 2 -and $dockerArguments[0] -ceq "--host") { 2 } else { 0 }
        $_.tool -ceq "docker" -and $dockerArguments.Count -ge ($offset + 2) -and
        $dockerArguments[$offset] -ceq "container" -and $dockerArguments[$offset + 1] -in @("create", "start", "logs", "kill", "rm")
    })
    $removedVolumes = @($newOperations | Where-Object {
        $dockerArguments = @($_.arguments)
        $offset = if ($dockerArguments.Count -ge 2 -and $dockerArguments[0] -ceq "--host") { 2 } else { 0 }
        $_.tool -ceq "docker" -and $dockerArguments.Count -ge ($offset + 3) -and
        $dockerArguments[$offset] -ceq "volume" -and $dockerArguments[$offset + 1] -ceq "rm"
    } | ForEach-Object { [string] @($_.arguments)[-1] })
    Assert-Contract ($runnerOperations.Count -eq 0 -and
        @($newOperations | Where-Object { $_.tool -ceq "postflight" }).Count -eq 0) "$CrashAfter recovery must never create, start, consume or clean up a runner"
    Assert-Contract ($removedVolumes -contains [string] $marker.volume -and
        $removedVolumes -contains [string] $marker.inputVolume) "$CrashAfter recovery must remove both exact labelled volumes"
    if ($ResumeClockAdvanceSeconds -gt 0) {
        $style = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        $culture = [Globalization.CultureInfo]::InvariantCulture
        $durableStartedAt = [DateTime]::ParseExact([string] $marker.startedAt, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $preflight = Get-Content -LiteralPath $Context.PreflightPath -Raw | ConvertFrom-Json
        $authorization = Get-Content -LiteralPath $Context.AuthorizationPath -Raw | ConvertFrom-Json
        $preflightValidUntil = [DateTime]::ParseExact([string] $preflight.validUntil, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $authorizationValidUntil = [DateTime]::ParseExact([string] $authorization.validUntil, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $simulatedResumeNow = $durableStartedAt.AddSeconds($ResumeClockAdvanceSeconds)
        Assert-Contract ($preflightValidUntil -lt $simulatedResumeNow -and
            $authorizationValidUntil -ge $durableStartedAt.AddMinutes(35) -and
            $authorizationValidUntil -lt $simulatedResumeNow.AddMinutes(35)) "the delayed replay fixture must be expired at current time while its immutable admission and authority covered the durable start"

        $resumeOperations = @(
            Get-Content -LiteralPath $operationsPath | Select-Object -Skip $operationCountBeforeResume | ForEach-Object { $_ | ConvertFrom-Json }
        )
        $resumeAdmissionValidations = @($resumeOperations | Where-Object {
            $values = @($_.arguments)
            $_.tool -ceq "node" -and $values.Count -gt 0 -and
            [IO.Path]::GetFileName([string] $values[0]) -ceq "validate-lightsail-incident-admission.mjs"
        })
        $allReplayTimesMatch = $resumeAdmissionValidations.Count -eq 2
        foreach ($validation in $resumeAdmissionValidations) {
            $values = @($validation.arguments)
            $nowIndex = [Array]::IndexOf([object[]] $values, "--now")
            if ($nowIndex -lt 0 -or $nowIndex + 1 -ge $values.Count -or [string] $values[$nowIndex + 1] -cne [string] $marker.startedAt) {
                $allReplayTimesMatch = $false
            }
        }
        Assert-Contract $allReplayTimesMatch "delayed cleanup replay must validate both immutable point-in-time documents at exact marker.startedAt"
    }
}

function Invoke-AttemptStartedAtTamperScenario($Context, [string] $TerminalPath) {
    $Context = New-FreshAdmissionContext $Context "attempt-started-at-tamper"
    $output = Join-Path $Context.TestRoot "production-output-attempt-started-at-tamper"
    [void] [IO.Directory]::CreateDirectory($output)
    Set-TestAcl $output
    $checkpoint = Join-Path $output "checkpoint.json"
    $operationsPath = Join-Path $Context.FixtureRoot "operations.jsonl"
    $crashed = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "after_input_volume_create" (Join-Path $Context.TestRoot "attempt-started-at-tamper-crash")
    $crashResult = Complete-ProductionWrapperFixture $crashed
    Assert-Contract ($crashResult.ExitCode -eq 99) "attempt startedAt tamper setup must leave one prepared marker"
    $markerPath = @(Get-ChildItem -LiteralPath $output -Filter "edge-window-attempt-$($Context.Revision)-*.local.json" -File)[0].FullName
    $original = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    $originalStartedAt = [string] $original.startedAt

    $malformed = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    $malformed.startedAt = "not-a-utc-second"
    Write-TestJson $markerPath $malformed; Set-TestFileAcl $markerPath
    $operationsBeforeMalformed = @(Get-Content -LiteralPath $operationsPath).Count
    $malformedRun = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "none" (Join-Path $Context.TestRoot "attempt-started-at-malformed") 901
    $malformedResult = Complete-ProductionWrapperFixture $malformedRun
    Assert-Contract ($malformedResult.ExitCode -eq 21 -and $malformedResult.Stderr.Contains("ATTEMPT_MARKER_INVALID") -and
        @(Get-Content -LiteralPath $operationsPath).Count -eq $operationsBeforeMalformed) "malformed durable startedAt must fail before every fake Node, gh or Docker call"

    $style = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    $originalValue = [DateTime]::ParseExact($originalStartedAt, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, $style)
    $tampered = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    $tampered.startedAt = $originalValue.AddSeconds(181).ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-TestJson $markerPath $tampered; Set-TestFileAcl $markerPath
    $operationsBeforeTampered = @(Get-Content -LiteralPath $operationsPath).Count
    $tamperedRun = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "none" (Join-Path $Context.TestRoot "attempt-started-at-shifted") 901
    $tamperedResult = Complete-ProductionWrapperFixture $tamperedRun
    $tamperedOperations = @(
        Get-Content -LiteralPath $operationsPath | Select-Object -Skip $operationsBeforeTampered | ForEach-Object { $_ | ConvertFrom-Json }
    )
    Assert-Contract ($tamperedResult.ExitCode -eq 21 -and
        ($tamperedResult.Stderr.Contains("PREFLIGHT_FRESHNESS_INVALID") -or $tamperedResult.Stderr.Contains("INCIDENT_FRESHNESS_INVALID")) -and
        @($tamperedOperations | Where-Object { $_.tool -ceq "docker" }).Count -eq 0) "a canonical but shifted durable startedAt must fail semantic admission before Docker or effect"
}

function Invoke-PreparedBeforeDockerCrashScenario($Context, [string] $TerminalPath) {
    $Context = New-FreshAdmissionContext $Context "prepared-before-docker"
    $authorization = Get-Content -LiteralPath $Context.AuthorizationPath -Raw | ConvertFrom-Json
    $authorization.validUntil = [DateTime]::UtcNow.AddMinutes(40).ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-TestJson $Context.AuthorizationPath $authorization
    Set-TestFileAcl $Context.AuthorizationPath
    $Context.AuthorizationSha256 = Test-FileSha256 $Context.AuthorizationPath

    $output = Join-Path $Context.TestRoot "production-output-prepared-before-docker"
    [void] [IO.Directory]::CreateDirectory($output)
    Set-TestAcl $output
    $checkpoint = Join-Path $output "checkpoint.json"
    $operationsPath = Join-Path $Context.FixtureRoot "operations.jsonl"
    $operationCountBeforeCrash = @(Get-Content -LiteralPath $operationsPath).Count
    $crashed = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "after_attempt_marker" (Join-Path $Context.TestRoot "prepared-before-docker-crash")
    $crashResult = Complete-ProductionWrapperFixture $crashed
    Assert-Contract ($crashResult.ExitCode -eq 99) "the prepared-before-Docker hook must hard-crash immediately after durable marker creation"

    $markers = @(Get-ChildItem -LiteralPath $output -Filter "edge-window-attempt-$($Context.Revision)-*.local.json" -File)
    if ($markers.Count -ne 1) { throw "prepared-before-Docker crash did not leave exactly one marker" }
    $marker = Get-Content -LiteralPath $markers[0].FullName -Raw | ConvertFrom-Json
    $digestValues = @(
        $marker.immutableInputs.awsConfigSha256,
        $marker.immutableInputs.controlSha256,
        $marker.immutableInputs.sshConfigSha256,
        $marker.immutableInputs.transportSha256
    )
    $stateVolumePath = Join-Path (Join-Path $Context.FixtureRoot "fake-volumes") ([string] $marker.volume)
    $inputVolumePath = Join-Path (Join-Path $Context.FixtureRoot "fake-volumes") ([string] $marker.inputVolume)
    $containerPath = Join-Path (Join-Path $Context.FixtureRoot "fake-containers") ([string] $marker.containerName)
    $crashOperations = @(
        Get-Content -LiteralPath $operationsPath | Select-Object -Skip $operationCountBeforeCrash | ForEach-Object { $_ | ConvertFrom-Json }
    )
    Assert-Contract ($marker.state -ceq "prepared" -and @($digestValues | Where-Object { $null -eq $_ }).Count -eq 4 -and
        $marker.inputs.authorizationSha256 -ceq $Context.AuthorizationSha256 -and
        $marker.inputs.incidentSha256 -ceq $Context.IncidentSha256 -and
        $marker.inputs.preflightSha256 -ceq $Context.PreflightSha256) "the pre-Docker marker must bind the exact immutable evidence while leaving input digests uncommitted"
    Assert-Contract (-not [IO.Directory]::Exists($stateVolumePath) -and -not [IO.Directory]::Exists($inputVolumePath) -and
        -not [IO.Directory]::Exists($containerPath) -and
        @($crashOperations | Where-Object { $_.tool -ceq "docker" }).Count -eq 0) "the exact marker crash hook must precede every Docker object and invocation"

    $operationCountBeforeResume = @(Get-Content -LiteralPath $operationsPath).Count
    $resumed = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "none" (Join-Path $Context.TestRoot "prepared-before-docker-resume") 901
    $resumeResult = Complete-ProductionWrapperFixture $resumed
    $closedMarker = Get-Content -LiteralPath $markers[0].FullName -Raw | ConvertFrom-Json
    Assert-Contract ($resumeResult.ExitCode -eq 21 -and $resumeResult.Stderr.Contains("ATTEMPT_CLEANUP_COMPLETE_NO_REOPEN") -and
        $closedMarker.state -ceq "cleanup_complete" -and $closedMarker.localCleanupComplete -eq $true) "delayed pre-Docker recovery must close cleanup-only with exact exit 21"
    Assert-Contract (-not [IO.Directory]::Exists($stateVolumePath) -and -not [IO.Directory]::Exists($inputVolumePath) -and
        -not [IO.Directory]::Exists($containerPath)) "delayed pre-Docker recovery must leave no Docker object"

    $style = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $durableStartedAt = [DateTime]::ParseExact([string] $marker.startedAt, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
    $preflight = Get-Content -LiteralPath $Context.PreflightPath -Raw | ConvertFrom-Json
    $authorization = Get-Content -LiteralPath $Context.AuthorizationPath -Raw | ConvertFrom-Json
    $preflightValidUntil = [DateTime]::ParseExact([string] $preflight.validUntil, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
    $authorizationValidUntil = [DateTime]::ParseExact([string] $authorization.validUntil, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
    $simulatedResumeNow = $durableStartedAt.AddSeconds(901)
    Assert-Contract ($preflightValidUntil -lt $simulatedResumeNow -and
        $authorizationValidUntil -ge $durableStartedAt.AddMinutes(35) -and
        $authorizationValidUntil -lt $simulatedResumeNow.AddMinutes(35)) "the pre-Docker replay must use expired-current bytes that covered only the durable operation deadline"

    $resumeOperations = @(
        Get-Content -LiteralPath $operationsPath | Select-Object -Skip $operationCountBeforeResume | ForEach-Object { $_ | ConvertFrom-Json }
    )
    $resumeAdmissionValidations = @($resumeOperations | Where-Object {
        $values = @($_.arguments)
        $_.tool -ceq "node" -and $values.Count -gt 0 -and
        [IO.Path]::GetFileName([string] $values[0]) -ceq "validate-lightsail-incident-admission.mjs"
    })
    $allReplayTimesMatch = $resumeAdmissionValidations.Count -eq 2
    foreach ($validation in $resumeAdmissionValidations) {
        $values = @($validation.arguments)
        $nowIndex = [Array]::IndexOf([object[]] $values, "--now")
        if ($nowIndex -lt 0 -or $nowIndex + 1 -ge $values.Count -or [string] $values[$nowIndex + 1] -cne [string] $marker.startedAt) {
            $allReplayTimesMatch = $false
        }
    }
    $dockerObjectMutations = @($resumeOperations | Where-Object {
        if ($_.tool -cne "docker") { return $false }
        $values = @($_.arguments)
        $offset = if ($values.Count -ge 2 -and $values[0] -ceq "--host") { 2 } else { 0 }
        if ($values.Count -le $offset) { return $false }
        return (($values[$offset] -ceq "volume" -and $values.Count -gt ($offset + 1) -and $values[$offset + 1] -ceq "create") -or
            ($values[$offset] -ceq "image" -and $values.Count -gt ($offset + 1) -and $values[$offset + 1] -ceq "load") -or
            ($values[$offset] -ceq "container" -and $values.Count -gt ($offset + 1) -and $values[$offset + 1] -in @("create", "start")) -or
            $values[$offset] -ceq "run")
    })
    Assert-Contract ($allReplayTimesMatch -and $dockerObjectMutations.Count -eq 0 -and
        @($resumeOperations | Where-Object { $_.tool -ceq "postflight" }).Count -eq 0) "delayed pre-Docker replay must validate at marker.startedAt without creating a volume, image, runner or public probe"
}

function Get-TestTreeSha256([string[]] $Roots) {
    $binding = [ordered]@{}
    foreach ($root in $Roots) {
        $rootName = [IO.Path]::GetFileName($root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
        foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -Force | Sort-Object -Property FullName)) {
            $relative = $file.FullName.Substring($root.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace("\", "/")
            $binding["$rootName/$relative"] = Test-FileSha256 $file.FullName
        }
    }
    return Test-TextSha256 (Canonical $binding)
}

function Invoke-NoStdoutPostCrashScenario($Context, [string] $TerminalPath, [string] $SubmitPath) {
    $Context = New-FreshAdmissionContext $Context "runner-exit21-no-stdout"
    $output = Join-Path $Context.TestRoot "production-output-runner-exit21-no-stdout"
    [void] [IO.Directory]::CreateDirectory($output)
    Set-TestAcl $output
    $checkpoint = Join-Path $output "checkpoint.json"
    $operationsPath = Join-Path $Context.FixtureRoot "operations.jsonl"

    $crashed = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "after_remote_terminal" (Join-Path $Context.TestRoot "runner-exit21-no-stdout-crash")
    try { $request = Wait-ProductionRequest $output $Context.Revision $crashed }
    catch {
        if ($crashed.Process.HasExited) {
            $early = Complete-ProductionWrapperFixture $crashed
            $operationTail = if ([IO.File]::Exists($operationsPath)) {
                @(
                    Get-Content -LiteralPath $operationsPath | Select-Object -Last 8 | ForEach-Object {
                        $entry = $_ | ConvertFrom-Json
                        "{0}:{1}" -f [string] $entry.tool, (@($entry.arguments) -join " ")
                    }
                ) -join " | "
            }
            else { "missing" }
            throw "no-stdout crash fixture exited before Workbench request: exit=$($early.ExitCode) stderr=$($early.Stderr.Trim()) operations=$operationTail"
        }
        throw
    }
    Assert-Contract ((Invoke-CheckpointSubmit $SubmitPath $request $checkpoint (Join-Path $Context.TestRoot "runner-exit21-no-stdout-submit.stderr")) -eq 0) "the no-stdout crash fixture checkpoint must be admitted"
    $crashResult = Complete-ProductionWrapperFixture $crashed
    if ($crashResult.ExitCode -ne 99) {
        throw "the no-stdout fixture did not reach its hard-crash point: exit=$($crashResult.ExitCode) stdout=$($crashResult.Stdout.Trim()) stderr=$($crashResult.Stderr.Trim())"
    }

    $markers = @(Get-ChildItem -LiteralPath $output -Filter "edge-window-attempt-$($Context.Revision)-*.local.json" -File)
    if ($markers.Count -ne 1) { throw "the no-stdout crash did not leave exactly one attempt marker" }
    $markerPath = $markers[0].FullName
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    $markerSha256 = Test-FileSha256 $markerPath
    $stateVolumePath = Join-Path (Join-Path $Context.FixtureRoot "fake-volumes") ([string] $marker.volume)
    $inputVolumePath = Join-Path (Join-Path $Context.FixtureRoot "fake-volumes") ([string] $marker.inputVolume)
    $containerPath = Join-Path (Join-Path $Context.FixtureRoot "fake-containers") ([string] $marker.containerName)
    $logsPath = Join-Path $containerPath "logs.bin"
    $statePath = Join-Path $containerPath "state.json"
    $terminalEvidence = @(Get-ChildItem -LiteralPath $output -Filter "edge-window-$($Context.Revision)-*.local.json" -File)
    $immutableDigests = @(
        $marker.immutableInputs.awsConfigSha256,
        $marker.immutableInputs.controlSha256,
        $marker.immutableInputs.sshConfigSha256,
        $marker.immutableInputs.transportSha256
    )
    Assert-Contract ($marker.state -ceq "prepared" -and $null -eq $marker.completedAt -and
        $null -eq $marker.evidenceFile -and $null -eq $marker.evidenceSha256 -and
        $marker.localCleanupComplete -eq $false -and
        @($immutableDigests | Where-Object { $_ -isnot [string] -or $_ -notmatch "^[0-9a-f]{64}$" }).Count -eq 0) "exit 21 without stdout must remain an unclassified prepared attempt"
    Assert-Contract ([IO.Directory]::Exists($stateVolumePath) -and [IO.Directory]::Exists($inputVolumePath) -and
        [IO.Directory]::Exists($containerPath) -and [IO.File]::Exists($logsPath) -and
        ([IO.File]::ReadAllBytes($logsPath)).Length -eq 0 -and $terminalEvidence.Count -eq 0) "the crash must retain the stopped runner and both private volumes without terminal evidence"
    $containerState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    Assert-Contract ($containerState.Running -eq $false -and [int] $containerState.ExitCode -eq 21) "the retained runner must be exact stopped exit 21"
    $controlPath = Join-Path $inputVolumePath ("fs/control-{0}.json" -f [string] $marker.nonce)
    $control = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json
    Assert-Contract ($control.provenance.fixtureOnly -eq $true) "the retained no-stdout recovery inputs must remain unmistakably fixtureOnly"
    $treeSha256 = Get-TestTreeSha256 @($stateVolumePath, $inputVolumePath, $containerPath)
    $operationCountAfterCrash = if ([IO.File]::Exists($operationsPath)) { @(Get-Content -LiteralPath $operationsPath).Count } else { 0 }

    foreach ($resumeNumber in @(1, 2)) {
        $resumed = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "none" (Join-Path $Context.TestRoot "runner-exit21-no-stdout-resume-$resumeNumber")
        $resumeResult = Complete-ProductionWrapperFixture $resumed
        Assert-Contract ($resumeResult.ExitCode -eq 21 -and $resumeResult.Stdout.Length -eq 0 -and
            $resumeResult.Stderr.Trim() -ceq "edge-window-wrapper-error:ATTEMPT_TERMINAL_OUTPUT_INVALID") "no-stdout recovery $resumeNumber must fail closed with exact exit 21 and no invented evidence"
        Assert-Contract ((Test-FileSha256 $markerPath) -ceq $markerSha256 -and
            (Get-TestTreeSha256 @($stateVolumePath, $inputVolumePath, $containerPath)) -ceq $treeSha256 -and
            [IO.Directory]::Exists($stateVolumePath) -and [IO.Directory]::Exists($inputVolumePath) -and
            [IO.Directory]::Exists($containerPath) -and ([IO.File]::ReadAllBytes($logsPath)).Length -eq 0) "no-stdout recovery $resumeNumber must preserve the exact prepared marker, stopped runner and both volumes"
        Assert-Contract (@(Get-ChildItem -LiteralPath $output -Filter "edge-window-$($Context.Revision)-*.local.json" -File).Count -eq 0) "no-stdout recovery $resumeNumber must never classify terminal evidence"
    }

    $recoveryOperations = @(
        Get-Content -LiteralPath $operationsPath | Select-Object -Skip $operationCountAfterCrash | ForEach-Object { $_ | ConvertFrom-Json }
    )
    $forbiddenRecoveryMutations = 0
    $terminalLogReads = 0
    foreach ($operation in $recoveryOperations) {
        if ($operation.tool -cne "docker") { continue }
        $dockerArguments = @($operation.arguments)
        $offset = if ($dockerArguments.Count -ge 2 -and $dockerArguments[0] -ceq "--host") { 2 } else { 0 }
        if ($dockerArguments.Count -lt ($offset + 2)) { continue }
        if ($dockerArguments[$offset] -ceq "container" -and $dockerArguments[$offset + 1] -ceq "logs") { $terminalLogReads += 1 }
        if (($dockerArguments[$offset] -ceq "volume" -and $dockerArguments[$offset + 1] -in @("create", "rm")) -or
            ($dockerArguments[$offset] -ceq "container" -and $dockerArguments[$offset + 1] -in @("create", "start", "kill", "rm")) -or
            $dockerArguments -contains "cleanup") { $forbiddenRecoveryMutations += 1 }
    }
    Assert-Contract ($terminalLogReads -eq 2 -and $forbiddenRecoveryMutations -eq 0) "repeated no-stdout recovery may only re-read the exact stopped runner; it must never create, clean, remove or replace resources"
}

function Invoke-TransportPreEffectNegativeScenario($Context, [string] $TerminalPath, [string] $Leaf, [string] $ExpectedCode) {
    $Context = New-FreshAdmissionContext $Context $Leaf
    $output = Join-Path $Context.TestRoot "production-output-$Leaf"
    [void] [IO.Directory]::CreateDirectory($output)
    Set-TestAcl $output
    $checkpoint = Join-Path $output "checkpoint.json"
    $operationsPath = Join-Path $Context.FixtureRoot "operations.jsonl"
    $rejectionsPath = Join-Path $Context.FixtureRoot "runner-pre-effect-rejections.jsonl"
    $operationCountBefore = if ([IO.File]::Exists($operationsPath)) { @(Get-Content -LiteralPath $operationsPath).Count } else { 0 }
    $rejectionCountBefore = if ([IO.File]::Exists($rejectionsPath)) { @(Get-Content -LiteralPath $rejectionsPath).Count } else { 0 }

    $running = Start-ProductionWrapperFixture $Context $TerminalPath $output $checkpoint "none" (Join-Path $Context.TestRoot $Leaf)
    $result = Complete-ProductionWrapperFixture $running
    Assert-Contract ($result.ExitCode -eq 21 -and $result.Stderr.Length -eq 0 -and
        $result.Stdout.Trim() -match "^edge-window-$($Context.Revision)-[0-9a-f]{12}\.local\.json$") "$Leaf must fail closed with exact terminal 21 before requesting a public window"
    Assert-Contract (-not [IO.File]::Exists($checkpoint) -and
        @(Get-ChildItem -LiteralPath $output -Filter "edge-window-workbench-request-*.local.json" -File).Count -eq 0) "$Leaf must reject transport before any Workbench request or checkpoint"

    $evidencePath = if ([string]::IsNullOrWhiteSpace($result.Stdout)) { $null } else { Join-Path $output $result.Stdout.Trim() }
    if ($null -ne $evidencePath -and [IO.File]::Exists($evidencePath)) {
        $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
        Assert-Contract ([int] $evidence.exitCode -eq 21 -and $evidence.result -ceq "INCOMPLETE" -and
            $evidence.provenance.fixtureOnly -eq $true) "$Leaf terminal evidence must remain exact fixtureOnly INCOMPLETE"
    }
    else { Assert-Contract $false "$Leaf must preserve one validated terminal artifact" }

    [object[]] $newRejections = @(
        if ([IO.File]::Exists($rejectionsPath)) {
            Get-Content -LiteralPath $rejectionsPath | Select-Object -Skip $rejectionCountBefore | ForEach-Object { $_ | ConvertFrom-Json }
        }
    )
    $rejectionNonce = if ($newRejections.Count -eq 1) { [string] $newRejections[0].nonce } else { "" }
    Assert-Contract ($newRejections.Count -eq 1 -and $newRejections[0].code -ceq $ExpectedCode -and
        $newRejections[0].fixtureOnly -eq $true -and $rejectionNonce -match "^[0-9a-f]{64}$") "$Leaf must be rejected by the autonomous runner transport check with exact code $ExpectedCode"

    $newOperations = @(
        Get-Content -LiteralPath $operationsPath | Select-Object -Skip $operationCountBefore | ForEach-Object { $_ | ConvertFrom-Json }
    )
    $workbenchWrites = @($newOperations | Where-Object {
        if ($_.tool -cne "docker") { return $false }
        $dockerArguments = @($_.arguments)
        $offset = if ($dockerArguments.Count -ge 2 -and $dockerArguments[0] -ceq "--host") { 2 } else { 0 }
        return ($dockerArguments.Count -gt $offset -and $dockerArguments[$offset] -ceq "run" -and
            [string] $dockerArguments[-1] -ceq "workbench-$rejectionNonce.json")
    })
    Assert-Contract (@($newOperations | Where-Object { $_.tool -ceq "postflight" }).Count -eq 0 -and
        ($rejectionNonce.Length -eq 64) -and
        $workbenchWrites.Count -eq 0) "$Leaf must stop before every postflight capture and Workbench effect input"
}

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$wrapperPath = Join-Path $PSScriptRoot "invoke-lightsail-edge-window.ps1"
$submitPath = Join-Path $PSScriptRoot "submit-lightsail-edge-window-checkpoint.ps1"
$fakeToolContractPath = Join-Path $repository "deploy/lightsail/test-fixtures/edge-window-wrapper-fake-tool.ps1"
$workflowPath = Join-Path $repository ".github/workflows/ci.yml"
$wrapper = [IO.File]::ReadAllText($wrapperPath)
$submit = [IO.File]::ReadAllText($submitPath)
$fakeToolContract = [IO.File]::ReadAllText($fakeToolContractPath)
$workflow = [IO.File]::ReadAllText($workflowPath)

foreach ($path in @($wrapperPath, $submitPath, $fakeToolContractPath)) {
    $tokens = $null
    $parseErrors = $null
    [void] [Management.Automation.Language.Parser]::ParseFile($path, [ref] $tokens, [ref] $parseErrors)
    Assert-Contract ($parseErrors.Count -eq 0) "PowerShell syntax must be valid: $path"
}

foreach ($contract in @(
    @('GIT_CONFIG_NOSYSTEM = "1"', "system Git configuration must be disabled"),
    @('GIT_NO_REPLACE_OBJECTS = "1"', "Git replace objects must be disabled"),
    @('"--no-replace-objects"', "Git CLI must explicitly disable replace objects"),
    @('"status", "--porcelain=v1", "--untracked-files=no"', "tracked worktree cleanliness must be checked"),
    @('Open-RepositoryControlBinding', "HEAD/ref/index/config/object-pack handles must be held"),
    @('$looseObjectPaths', "loose Git commit/tree/blob objects must be locked"),
    @('objects/info/alternates', "Git alternates must be rejected and rechecked"),
    @('$PinnedPowerShellSha256', "PowerShell must be hash pinned"),
    @('$PinnedTaskkillSha256', "taskkill must be hash pinned"),
    @('Stop-ProcessTree $process', "timeouts and output bounds must kill the process tree"),
    @('$ExpectedDockerEndpoint = "npipe:////./pipe/docker_engine"', "Docker must use the canonical engine endpoint"),
    @('$environment.DOCKER_CONFIG = $script:DockerConfigDirectory', "Docker config must be isolated"),
    @('"--pull", "never"', "all helper containers must forbid pulls"),
    @('$Container.HostConfig.NetworkMode -cne "bridge"', "operator network mode must be exact"),
    @('$Container.HostConfig.CapDrop[0] -cne "ALL"', "operator capabilities must be dropped"),
    @('$Container.HostConfig.ReadonlyRootfs -ne $true', "operator root filesystem must be read-only"),
    @('$tmpfs."/tmp" -cne "rw,noexec,nosuid,nodev,size=32m"', "tmpfs options must be exact"),
    @('OPERATOR_SOURCES_INVALID', "the image-baked source allowlist must be inspected"),
    @('$mounts.Count -ne 5', "the runner must expose separate RW state, RO input and three restricted credential mounts"),
    @('type=volume,source=$inputVolume,target=/var/lib/refunddesk/input,readonly', "immutable runner inputs must use a separate read-only volume mount"),
    @('REFUNDDESK_IMMUTABLE_INPUT_BUNDLE_V1', "immutable inputs must be created and sealed together offline"),
    @('s.st_nlink==2', "the immutable input root must have the real named-volume directory link count"),
    @('stat.S_IMODE(s.st_mode)==0o555', "the immutable input root must be root-owned and non-writable"),
    @('stat.S_IMODE(s.st_mode)==0o444', "every immutable input file must be root-owned and non-writable"),
    @('"--signer-workflow", "selimhehe1/RefundDesk/.github/workflows/sandbox-images.yml"', "attestation signer workflow must be exact"),
    @('"--source-digest", $ExpectedRevision', "attestation source digest must be exact"),
    @('"--deny-self-hosted-runners"', "self-hosted attestations must be denied"),
    @('"api", "--method", "GET"', "the exact Actions run must be observed"),
    @('$workflowRun.conclusion -cne "success"', "the Actions run conclusion must be success"),
    @('$operatorProvenanceIntegerField -isnot [int]', "operator provenance must reject coercible integer strings"),
    @('[DateTime]::ParseExact([string] $operatorProvenance.createdAt', "operator provenance time must parse exactly"),
    @('INCIDENT_CANDIDATE_BINDING_INVALID', "incident postflight identities must bind all promotion runtime identities"),
    @('awsConfigSha256 = $awsConfigSha256', "transport must bind the exact immutable AWS configuration bytes"),
    @('sshConfigSha256 = $sshConfigSha256', "transport must bind the exact immutable SSH configuration bytes"),
    @('sshConfigPath = "/var/lib/refunddesk/input/ssh-config"', "transport must use the one immutable SSH configuration path"),
    @('authorizationMaxWindowSeconds = [int] $script:Authorization.maxWindowSeconds', "control admission must preserve the authorization duration ceiling"),
    @('authorizedAwsAccountIdSha256 = Get-TextSha256', "control admission must bind the authorized AWS account"),
    @('authorizedAwsRegionSha256 = Get-TextSha256', "control admission must bind the authorized AWS region"),
    @('authorizedSshCidrSha256 = Get-TextSha256', "control admission must bind the authorized SSH CIDR"),
    @('Open-AttemptLease', "a deterministic local attempt lease must serialize wrappers"),
    @('$attempt.state -notin @("prepared", "finalizing", "cleanup_required", "cleanup_complete", "complete")', "attempt states must be closed"),
    @('$resumingPrepared = $true', "prepared attempts must resume cleanup-only"),
    @('$resumingUncommittedPrepared = $true', "pre-digest prepared attempts must use their own no-runner cleanup branch"),
    @('ATTEMPT_UNCOMMITTED_CONTAINER_PRESENT', "pre-digest recovery must reject any impossible runner container"),
    @('after_input_volume_create', "the harness must crash immediately after both private volumes exist"),
    @('after_attempt_marker', "the harness must crash after durable preparation and before every Docker object"),
    @('after_input_seal_before_marker', "the harness must crash after sealing and before digest publication"),
    @('$resumingFinalizing = $true', "persisted PASS attempts must resume local finalization"),
    @('Assert-EdgeTerminalIdentity $consumedEvidence', "consumed evidence must preserve exact 0/20/21 identity"),
    @('$ExpectedExitCode -notin @(0, 20, 21)', "only terminal runner exits may be consumed"),
    @('$attempt.state -eq "cleanup_required"', "an unsafe terminal result must resume cleanup-only"),
    @('ATTEMPT_TERMINAL_OUTPUT_INVALID', "a stopped 0/20/21 runner without stdout must never be classified as terminal"),
    @('$attemptFinalizing', "PASS evidence must be journaled before local cleanup"),
    @('RUNNER_CONTAINER_CONVERGENCE_AMBIGUOUS', "a possibly effect-capable runner must be allowed bounded AWS-first convergence"),
    @('function Assert-RunnerContainerContract', "normal and cleanup runners must share one exact container predicate"),
    @('CLEANUP_CONTAINER_CONTRACT_INVALID', "the cleanup helper container must be inspected before start"),
    @('$initialCleanupState.Status -ceq "created"', "an exact created cleanup helper must resume without creating a competitor"),
    @('CLEANUP_RUNNER_CONVERGENCE_AMBIGUOUS', "a running cleanup helper must be preserved when bounded observation expires"),
    @('"requestBootIdSha256", "requestedAt", "requestedBoottimeMilliseconds"', "final postflight requests must carry exact boot and monotonic anchors"),
    @('$Request.requestedBoottimeMilliseconds -isnot [int]', "final postflight monotonic anchors must reject coercible strings"),
    @('function Assert-OfficialFinalPostflightBytes', "one immutable final capture must be admitted through both official validators"),
    @('$incidentArguments += @("--fixture-only", "true")', "the final incident projection must use its exact explicit fixture-only CLI value"),
    @('(Join-Path $Repository "scripts/validate-lightsail-postflight.mjs")', "the complete ADR 0034 postflight validator must run on the embedded remote bytes"),
    @('(Get-Sha256Hex $remoteBytes) -cne [string] $document.provenance.remoteDocumentSha256', "the embedded remote must be bound to the immutable outer capture digest"),
    @('[string] $document.remote.nonce -cne $ExpectedNonce', "the complete final postflight must bind the current runner nonce rather than self-asserting one"),
    @('$official.result -cne "PASS" -or $official.posture -cne "COHERENT_CONTAINED"', "the complete validator must return exact contained PASS semantics"),
    @('FINAL_POSTFLIGHT_PROVENANCE_INVALID', "the complete validator sources must equal the outer capture provenance"),
    @('$postflightCapturedAtValue -gt $incidentCapturedAtValue', "the admitted final postflight must not follow the incident capture"),
    @('$IncidentCapturedAt -gt $startedAtValue', "the incident capture must not follow the durable edge operation start"),
    @('$PostflightValidUntil - $startedAtValue', "postflight remaining time must be derived from its validity and the durable edge start"),
    @('Read-AttemptMarkerDiscovery $attemptMarkerPath $attemptBindingSha256 $attemptInputs', "the durable attempt must be discovered and hash-bound before semantic freshness"),
    @('$admissionValidationTimestamp = $attemptStartedAt', "resume validators must use the durable attempt timestamp"),
    @('$freshIncidentValidation', "fresh attempts must re-run immutable admission immediately before marker creation"),
    @('$AuthorizationValidUntil -lt $attemptDeadlineValue', "authorization validity must cover the complete bounded operation from its durable start"),
    @('incidentRemainingSecondsAtStart = $incidentRemaining', "runner control must carry the incident TTL derived at durable start"),
    @('operationStartedAt = $attemptStartedAt', "runner control must carry the first durable operation start"),
    @('[RefundDesk.WindowsOperatorClock]::ReadBootIdentifier()', "the wrapper must pin the Windows boot generation through the native boot identifier"),
    @('[RefundDesk.WindowsOperatorClock]::ReadMonotonicMilliseconds()', "the wrapper must use GetTickCount64-backed monotonic time"),
    @('operatorBootIdentifierSha256 = $operatorBootIdentifierSha256', "the marker and runner control must bind only the boot identifier digest"),
    @('operatorControlCalculatedMonotonicMilliseconds = $operatorControlCalculatedMonotonicMilliseconds', "runner control must expose the exact grant calculation instant"),
    @('operatorStartedMonotonicMilliseconds = $operatorStartedMonotonicMilliseconds', "the operation budget must start with durable marker preparation"),
    @('operatorDeadlineMonotonicMilliseconds = $operatorDeadlineMonotonicMilliseconds', "the monotonic deadline must be carried without wall-clock derivation"),
    @('operationRemainingSecondsAtRunnerStart = [int] $operationRemainingSecondsAtRunnerStart', "runner control must receive the conservative remaining grant"),
    @('$RunnerLaunchReserveSeconds = 240', "the control seal must reserve the complete bounded Windows launch path"),
    @('$RunnerStartTimeoutSeconds = 30', "the final Docker start call must have an explicit reserved timeout"),
    @('Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath', "clock invalidity must become a durable monotone latch before cleanup"),
    @('FileMode]::CreateNew', "checkpoint and markers must use CreateNew"),
    @('FileShare]::None', "attempt/checkpoint creation must exclude races"),
    @('Read-LockedStreamBytes $checkpointLock.Stream', "the checkpoint must be transported from its locked handle"),
    @('if ([DateTime]::UtcNow -gt $deadline)', "checkpoint arrival must be rechecked against the deadline")
)) {
    Assert-Contains $wrapper ([string] $contract[0]) ([string] $contract[1])
}
Assert-Contract (-not $wrapper.Contains('target=/workspace,readonly')) "the caller repository must never be mounted into the network-enabled operator"
Assert-Contract (([regex]::Matches($wrapper, 'Assert-RunnerContainerContract \$(?:container|cleanupInspect\[0\])')).Count -eq 2) "normal and cleanup containers must both use the shared exact predicate"
Assert-Contract (([regex]::Matches($wrapper, 'Assert-RunnerContainerContract \$existingContainer\[0\]')).Count -eq 2) "both recovery paths must reapply the shared exact container predicate"
Assert-Contract (-not $wrapper.Contains('"container", "kill", "--signal", "KILL", $Name')) "the wrapper must never KILL a runner before exact AWS-close evidence"
Assert-Contract (-not $wrapper.Contains('"container", "kill", "--signal", "TERM", $cleanupName')) "the wrapper must never signal a running cleanup helper before exact AWS-close evidence"
Assert-Contract (-not $wrapper.Contains('"container", "rm", "--force", $cleanupName')) "an ambiguous cleanup helper must never be force-removed"
Assert-Contains $wrapper '$script:ProductionContractFixture' "the production-path harness must be explicitly fixture gated"
Assert-Contains $wrapper 'Throw-SafeError "FIXTURE_MODE_INVALID"' "fixture-only paths and crash switches must be rejected outside explicit fixture mode"
Assert-Contains $wrapper 'fixtureOnly = [bool] $script:ProductionContractFixture' "production-path fixture evidence must be unmistakably fixture-only"
    Assert-Contains $fakeToolContract 'exit (Invoke-RealNode $arguments $stdinBytes)' "the bounded fake Node boundary must delegate the complete postflight validator to the exact copied script"
    Assert-Contains $fakeToolContract '$control.operationStartedAt' "the runner fixture must derive admission and terminal timing from the durable control start"
    Assert-Contains $fakeToolContract '$control.operatorBootIdentifierSha256' "the runner fixture must validate the operator boot digest"
    Assert-Contains $fakeToolContract '$control.operationRemainingSecondsAtRunnerStart' "the runner fixture must validate the conservative Windows grant"
    Assert-Contains $fakeToolContract '$admission.incidentRemainingSecondsAtStart' "the runner fixture must independently verify the incident remaining-time projection"
Assert-Contains $fakeToolContract 'realNodeSha256' "the faithful Node delegate must be executable-digest pinned"
Assert-Contains $fakeToolContract 'runner-exit21-no-stdout.json' "the fake runner must expose an exact terminal-21/zero-byte-stdout recovery case"
Assert-Contains $fakeToolContract 'TRANSPORT_SSH_CONFIG_PATH_INVALID' "the fake runner must reject an escaped SSH configuration path before effect"
Assert-Contains $fakeToolContract 'TRANSPORT_CONFIG_DIGEST_INVALID' "the fake runner must reject immutable configuration digest drift before effect"
foreach ($postflightNegativeName in @("postflight-caddy-running", "postflight-caddy-image", "postflight-listener", "postflight-derived-lie")) {
    Assert-Contains $fakeToolContract $postflightNegativeName "the faithful final postflight producer must expose negative variant $postflightNegativeName"
}
Assert-Contains $submit '[DateTime]::UtcNow' "the Workbench receiver must derive capturedAt itself"
Assert-Contains $submit '[IO.FileMode]::CreateNew' "the Workbench receiver must create the checkpoint exclusively"
Assert-Contains $submit '[IO.FileOptions]::WriteThrough' "the Workbench receiver must request durable writes"
Assert-Contract (([regex]::Matches($workflow, [regex]::Escape('scripts/invoke-lightsail-edge-window.contract.Tests.ps1'))).Count -eq 1) "CI must run this contract exactly once"

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("refunddesk-edge-contract-{0}" -f [Guid]::NewGuid().ToString("N"))
try {
    [void] [IO.Directory]::CreateDirectory($temporary)
    Set-TestAcl $temporary
    $nonce = "a" * 64
    $revision = "b" * 40
    $fingerprint = "c" * 64
    $now = [DateTime]::UtcNow
    $request = [ordered]@{
        deadlineAt = $now.AddMinutes(2).ToString("yyyy-MM-ddTHH:mm:ssZ")
        eventFingerprintSha256 = $fingerprint
        expectedRevision = $revision
        kind = "refunddesk.operator-workbench-request"
        nonce = $nonce
        openedAt = $now.AddSeconds(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
        schemaVersion = 1
    }
    $requestPath = Join-Path $temporary "request.json"
    $checkpointPath = Join-Path $temporary "checkpoint.json"
    [IO.File]::WriteAllText($requestPath, (Canonical $request), [Text.UTF8Encoding]::new($false))
    $errorPath = Join-Path $temporary "submit.stderr"
    $submissionStatus = Invoke-CheckpointSubmit $submitPath $requestPath $checkpointPath $errorPath
    Assert-Contract ($submissionStatus -eq 0) "the first Workbench CreateNew submission must pass"
    Assert-Contract ([IO.File]::Exists($checkpointPath)) "the first Workbench submission must create one checkpoint"
    $firstBytes = [IO.File]::ReadAllBytes($checkpointPath)
    $checkpoint = ([Text.UTF8Encoding]::new($false, $true).GetString($firstBytes) | ConvertFrom-Json)
    Assert-Contract ($checkpoint.receiver -ceq "REFUNDDESK_CREATE_NEW_V1" -and $checkpoint.source -ceq "OPERATOR_WORKBENCH" -and
        $checkpoint.cliUsed -eq $false -and $checkpoint.duplicate -eq $true -and [int] $checkpoint.httpStatus -eq 200) "checkpoint semantics must be exact"
    $submissionStatus = Invoke-CheckpointSubmit $submitPath $requestPath $checkpointPath $errorPath
    $submissionError = if ([IO.File]::Exists($errorPath)) { [IO.File]::ReadAllText($errorPath).Trim() } else { "missing-stderr" }
    Assert-Contract ($submissionStatus -eq 20) "a second creator must lose the CreateNew race with exit 20 (actual $submissionStatus; $submissionError)"
    $secondBytes = [IO.File]::ReadAllBytes($checkpointPath)
    Assert-Contract ([Convert]::ToBase64String($firstBytes) -ceq [Convert]::ToBase64String($secondBytes)) "the losing creator must not replace checkpoint bytes"

    $expired = [ordered]@{
        deadlineAt = $now.AddMinutes(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")
        eventFingerprintSha256 = $fingerprint
        expectedRevision = $revision
        kind = "refunddesk.operator-workbench-request"
        nonce = $nonce
        openedAt = $now.AddMinutes(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
        schemaVersion = 1
    }
    $expiredRequest = Join-Path $temporary "expired-request.json"
    $expiredCheckpoint = Join-Path $temporary "expired-checkpoint.json"
    [IO.File]::WriteAllText($expiredRequest, (Canonical $expired), [Text.UTF8Encoding]::new($false))
    $submissionStatus = Invoke-CheckpointSubmit $submitPath $expiredRequest $expiredCheckpoint $errorPath
    $submissionError = if ([IO.File]::Exists($errorPath)) { [IO.File]::ReadAllText($errorPath).Trim() } else { "missing-stderr" }
    Assert-Contract ($submissionStatus -eq 20 -and -not [IO.File]::Exists($expiredCheckpoint)) "a post-deadline/backdated checkpoint must fail before creation (actual $submissionStatus; $submissionError)"

    $inheritedParent = Join-Path $temporary "checkpoint-parent-inherited"
    [void] [IO.Directory]::CreateDirectory($inheritedParent)
    $inheritedRequest = Join-Path $inheritedParent "request.json"
    $inheritedCheckpoint = Join-Path $inheritedParent "checkpoint.json"
    [IO.File]::WriteAllText($inheritedRequest, (Canonical $request), [Text.UTF8Encoding]::new($false))
    $inheritedStatus = Invoke-CheckpointSubmit $submitPath $inheritedRequest $inheritedCheckpoint (Join-Path $temporary "inherited.stderr")
    Assert-Contract ($inheritedStatus -eq 20 -and -not [IO.File]::Exists($inheritedCheckpoint)) "a non-protected inherited parent DACL must be rejected"

    $extraAceParent = Join-Path $temporary "checkpoint-parent-extra-ace"
    [void] [IO.Directory]::CreateDirectory($extraAceParent)
    Set-TestAcl $extraAceParent
    $extraAcl = Get-Acl -LiteralPath $extraAceParent
    $extraAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new("S-1-5-32-545"),
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.Directory]::SetAccessControl($extraAceParent, $extraAcl)
    $extraRequest = Join-Path $extraAceParent "request.json"
    $extraCheckpoint = Join-Path $extraAceParent "checkpoint.json"
    [IO.File]::WriteAllText($extraRequest, (Canonical $request), [Text.UTF8Encoding]::new($false))
    $extraStatus = Invoke-CheckpointSubmit $submitPath $extraRequest $extraCheckpoint (Join-Path $temporary "extra-ace.stderr")
    Assert-Contract ($extraStatus -eq 20 -and -not [IO.File]::Exists($extraCheckpoint)) "a parent DACL with one extra ACE must be rejected"

    $junctionTarget = Join-Path $temporary "checkpoint-junction-target"
    $junctionPath = Join-Path $temporary "checkpoint-junction"
    [void] [IO.Directory]::CreateDirectory($junctionTarget)
    Set-TestAcl $junctionTarget
    $junctionRequest = Join-Path $junctionTarget "request.json"
    [IO.File]::WriteAllText($junctionRequest, (Canonical $request), [Text.UTF8Encoding]::new($false))
    [void] (New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget -Force)
    $junctionCheckpoint = Join-Path $junctionPath "checkpoint.json"
    $junctionStatus = Invoke-CheckpointSubmit $submitPath $junctionRequest $junctionCheckpoint (Join-Path $temporary "junction.stderr")
    Assert-Contract ($junctionStatus -eq 20 -and -not [IO.File]::Exists((Join-Path $junctionTarget "checkpoint.json"))) "a reparse-point checkpoint parent must be rejected"

    $fixtureDirectory = Join-Path $temporary "fixture-inputs"
    $fixtureOutput = Join-Path $temporary "fixture-output"
    [void] [IO.Directory]::CreateDirectory($fixtureDirectory)
    [void] [IO.Directory]::CreateDirectory($fixtureOutput)
    Set-TestAcl $fixtureDirectory
    Set-TestAcl $fixtureOutput
    $fixtureGenerator = Join-Path $repository "scripts/validate-lightsail-edge-window.test.mjs"
    & (Get-Command node).Source $fixtureGenerator --write-contract-fixtures $fixtureDirectory | Out-Null
    Assert-Contract ($LASTEXITCODE -eq 0) "the canonical terminal fixture generator must pass"

    $passFixture = Join-Path $fixtureDirectory "pass.json"
    $failFixture = Join-Path $fixtureDirectory "fail.json"
    $incompleteFixture = Join-Path $fixtureDirectory "incomplete.json"
    $ambiguousFixture = Join-Path $fixtureDirectory "effect-ambiguous.json"
    $fixtureRevision = "b" * 40

    # The generated ambiguity inherits the PASS document's released marker
    # fields.  The wrapper contract needs the corresponding current,
    # admissible retained-interlock terminal bytes.
    $ambiguousDocument = Get-Content -LiteralPath $ambiguousFixture -Raw | ConvertFrom-Json
    $ambiguousDocument.watchdog.markerComplete = $false
    $ambiguousDocument.containment.markerComplete = $false
    Write-TestJson $ambiguousFixture $ambiguousDocument

    if (-not $skipShortContract) {
    $noBomOutput = Join-Path $temporary "fixture-no-bom-output"
    [void] [IO.Directory]::CreateDirectory($noBomOutput)
    Set-TestAcl $noBomOutput
    $noBom = Invoke-WrapperFixture $wrapperPath $fixtureRevision $failFixture $noBomOutput (Join-Path $noBomOutput "checkpoint.json") "none" (Join-Path $temporary "no-bom")
    Assert-Contract ($noBom.ExitCode -eq 20 -and -not $noBom.Stderr.Contains("FIXTURE_JSON_INVALID")) "canonical UTF-8 JSON without BOM must be accepted by Windows PowerShell 5"
    $bomFixture = Join-Path $fixtureDirectory "bom-rejected.json"
    $plainFixtureBytes = [IO.File]::ReadAllBytes($failFixture)
    $bomBytes = New-Object byte[] ($plainFixtureBytes.Length + 3)
    $bomBytes[0] = 0xef; $bomBytes[1] = 0xbb; $bomBytes[2] = 0xbf
    [Array]::Copy($plainFixtureBytes, 0, $bomBytes, 3, $plainFixtureBytes.Length)
    [IO.File]::WriteAllBytes($bomFixture, $bomBytes)
    $bomOutput = Join-Path $temporary "fixture-bom-output"
    [void] [IO.Directory]::CreateDirectory($bomOutput)
    Set-TestAcl $bomOutput
    $bom = Invoke-WrapperFixture $wrapperPath $fixtureRevision $bomFixture $bomOutput (Join-Path $bomOutput "checkpoint.json") "none" (Join-Path $temporary "bom")
    Assert-Contract ($bom.ExitCode -eq 21 -and $bom.Stderr.Contains("FIXTURE_JSON_INVALID")) "UTF-8 JSON with BOM must be rejected explicitly by Windows PowerShell 5"

    $passCrash = Invoke-WrapperFixture $wrapperPath $fixtureRevision $passFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-pass.json") "after_evidence" (Join-Path $temporary "pass-crash")
    Assert-Contract ($passCrash.ExitCode -eq 21 -and $passCrash.Stderr.Contains("FIXTURE_CRASH_AFTER_EVIDENCE")) "a crash after durable PASS evidence must stop at exit 21 (exit=$($passCrash.ExitCode), stderr=$($passCrash.Stderr.Trim()))"
    $passEvidence = @(Get-ChildItem -LiteralPath $fixtureOutput -Filter "edge-window-$fixtureRevision-aaaaaaaaaaaa.local.json" -File)
    Assert-Contract ($passEvidence.Count -eq 1) "PASS bytes must exist before the simulated wrapper crash"
    $passBytesBefore = if ($passEvidence.Count -eq 1) { [IO.File]::ReadAllBytes($passEvidence[0].FullName) } else { [byte[]]::new(0) }
    $passResume = Invoke-WrapperFixture $wrapperPath $fixtureRevision $passFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-pass.json") "none" (Join-Path $temporary "pass-resume")
    Assert-Contract ($passResume.ExitCode -eq 0 -and $passResume.Stdout.Trim() -ceq "edge-window-$fixtureRevision-aaaaaaaaaaaa.local.json") "PASS must resume from durable bytes without a new attempt"
    $passConsumed = Invoke-WrapperFixture $wrapperPath $fixtureRevision $passFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-pass.json") "none" (Join-Path $temporary "pass-consumed")
    Assert-Contract ($passConsumed.ExitCode -eq 0 -and $passConsumed.Stdout -ceq $passResume.Stdout) "a completed PASS must be consumed byte-identically"
    if ($passEvidence.Count -eq 1) {
        Assert-Contract ([Convert]::ToBase64String($passBytesBefore) -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($passEvidence[0].FullName))) "PASS recovery must not rewrite terminal evidence"
    }

    $failCrash = Invoke-WrapperFixture $wrapperPath $fixtureRevision $failFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-fail.json") "after_prepared" (Join-Path $temporary "fail-crash")
    Assert-Contract ($failCrash.ExitCode -eq 21 -and $failCrash.Stderr.Contains("FIXTURE_CRASH_AFTER_PREPARED")) "a crash after prepared must remain cleanup/replay-only"
    Assert-Contract (@(Get-ChildItem -LiteralPath $fixtureOutput -Filter "edge-window-$fixtureRevision-dddddddddddd.local.json" -File).Count -eq 0) "prepared crash must not invent terminal bytes"
    $failResume = Invoke-WrapperFixture $wrapperPath $fixtureRevision $failFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-fail.json") "none" (Join-Path $temporary "fail-resume")
    Assert-Contract ($failResume.ExitCode -eq 20 -and $failResume.Stdout.Trim() -ceq "edge-window-$fixtureRevision-dddddddddddd.local.json") "FAIL must resume and preserve exit 20"
    $failConsumed = Invoke-WrapperFixture $wrapperPath $fixtureRevision $failFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-fail.json") "none" (Join-Path $temporary "fail-consumed")
    Assert-Contract ($failConsumed.ExitCode -eq 20 -and $failConsumed.Stdout -ceq $failResume.Stdout) "completed FAIL must be consumed with exit 20"

    $incompleteFirst = Invoke-WrapperFixture $wrapperPath $fixtureRevision $incompleteFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-incomplete.json") "none" (Join-Path $temporary "incomplete-first")
    $incompleteReplay = Invoke-WrapperFixture $wrapperPath $fixtureRevision $incompleteFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-incomplete.json") "none" (Join-Path $temporary "incomplete-replay")
    Assert-Contract ($incompleteFirst.ExitCode -eq 21 -and $incompleteFirst.Stdout.Trim() -ceq "edge-window-$fixtureRevision-eeeeeeeeeeee.local.json") "INCOMPLETE terminal bytes must be emitted with exit 21"
    Assert-Contract ($incompleteReplay.ExitCode -eq 21 -and $incompleteReplay.Stdout -ceq $incompleteFirst.Stdout) "completed INCOMPLETE must be consumed with exit 21"

    $ambiguousFirst = Invoke-WrapperFixture $wrapperPath $fixtureRevision $ambiguousFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-ambiguous.json") "none" (Join-Path $temporary "ambiguous-first")
    $ambiguousMarkerPath = Join-Path $fixtureOutput "edge-window-fixture-attempt-$fixtureRevision-ffffffffffff.json"
    Assert-Contract ([IO.File]::Exists($ambiguousMarkerPath)) "lost-effect ambiguity must create a durable recovery marker (exit=$($ambiguousFirst.ExitCode), stderr=$($ambiguousFirst.Stderr.Trim()))"
    $ambiguousMarker = if ([IO.File]::Exists($ambiguousMarkerPath)) { Get-Content -LiteralPath $ambiguousMarkerPath -Raw | ConvertFrom-Json } else { $null }
    Assert-Contract ($ambiguousFirst.ExitCode -eq 21 -and $null -ne $ambiguousMarker -and $ambiguousMarker.state -ceq "cleanup_required") "lost-effect ambiguity must retain recovery state instead of trusting zero mutation counters"
    $ambiguousReplay = Invoke-WrapperFixture $wrapperPath $fixtureRevision $ambiguousFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-ambiguous.json") "none" (Join-Path $temporary "ambiguous-replay")
    Assert-Contract ($ambiguousReplay.ExitCode -eq 21 -and $ambiguousReplay.Stdout -ceq $ambiguousFirst.Stdout) "cleanup-required ambiguity must replay exact evidence without a second attempt"

    if ($passEvidence.Count -eq 1) {
        $tampered = [IO.File]::ReadAllBytes($passEvidence[0].FullName)
        $tampered[20] = $tampered[20] -bxor 1
        [IO.File]::WriteAllBytes($passEvidence[0].FullName, $tampered)
        $tamperReplay = Invoke-WrapperFixture $wrapperPath $fixtureRevision $passFixture $fixtureOutput (Join-Path $fixtureOutput "checkpoint-pass.json") "none" (Join-Path $temporary "pass-tamper")
        Assert-Contract ($tamperReplay.ExitCode -eq 21 -and $tamperReplay.Stderr.Contains("FIXTURE_EVIDENCE_INVALID")) "a changed consumed evidence file must fail closed"
    }
    }
    if (-not $ShortFixtureOnly) {
    # Extended contract: traverse the real production wrapper path.  Only the
    # external Node/Docker/gh/postflight processes are faked; Git is real and
    # the temporary repository contains exactly the 30 pinned source paths.
    $productionRoot = Join-Path $temporary "production-fixture"
    $productionRepository = Join-Path $productionRoot "repository"
    $productionInputs = Join-Path $productionRoot "inputs"
    foreach ($directory in @($productionRoot, $productionRepository, $productionInputs)) {
        [void] [IO.Directory]::CreateDirectory($directory)
    }
    $fakeToolSource = Join-Path $repository "deploy/lightsail/test-fixtures/edge-window-wrapper-fake-tool.ps1"
    $fakeToolPath = Join-Path $productionRoot "edge-window-wrapper-fake-tool.ps1"
    Copy-Item -LiteralPath $fakeToolSource -Destination $fakeToolPath
    $productionSourcePaths = @(
        ".dockerignore",
        ".github/workflows/sandbox-images.yml",
        "deploy/lightsail/Caddyfile.public",
        "deploy/lightsail/compose.yml",
        "deploy/lightsail/edge-operator.Dockerfile",
        "deploy/lightsail/edge-operator.Dockerfile.dockerignore",
        "deploy/lightsail/scripts/_common.sh",
        "deploy/lightsail/scripts/observe-host-postflight.sh",
        "deploy/lightsail/scripts/prove-bounded-edge-window.sh",
        "deploy/lightsail/scripts/recover-quiesced-runtime.sh",
        "deploy/lightsail/scripts/release.sh",
        "deploy/lightsail/scripts/refunddesk-edge-operator.sh",
        "deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh",
        "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service",
        "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer",
        "docs/adr/0037-bounded-cloudfront-origin-window.md",
        "docs/schemas/refunddesk-edge-operator-image-v1.schema.json",
        "docs/schemas/refunddesk-lightsail-contained-promotion-v1.schema.json",
        "docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json",
        "docs/schemas/refunddesk-lightsail-incident-admission-v1.schema.json",
        "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json",
        "scripts/check-sandbox-images-workflow.mjs",
        "scripts/invoke-lightsail-edge-window.ps1",
        "scripts/invoke-lightsail-postflight.ps1",
        "scripts/submit-lightsail-edge-window-checkpoint.ps1",
        "scripts/validate-edge-operator-image.mjs",
        "scripts/validate-lightsail-contained-promotion.mjs",
        "scripts/validate-lightsail-edge-window.mjs",
        "scripts/validate-lightsail-incident-admission.mjs",
        "scripts/validate-lightsail-postflight.mjs"
    )
    Assert-Contract ($productionSourcePaths.Count -eq 30) "the real-path fixture repository must contain the exact 30 pinned sources"
    foreach ($relativePath in $productionSourcePaths) {
        $destination = Join-Path $productionRepository $relativePath
        [void] [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
        Copy-Item -LiteralPath (Join-Path $repository $relativePath) -Destination $destination
    }
    $gitPath = "C:\Program Files\Git\cmd\git.exe"
    if (-not [IO.File]::Exists($gitPath)) { throw "real Git fixture executable missing" }
    & $gitPath init --initial-branch=main $productionRepository | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "temporary Git init failed" }
    & $gitPath -C $productionRepository config core.autocrlf false
    & $gitPath -C $productionRepository config user.name "RefundDesk Contract"
    & $gitPath -C $productionRepository config user.email "contract@invalid.example"
    & $gitPath -C $productionRepository add --all
    & $gitPath -C $productionRepository commit -m "fixture" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "temporary Git commit failed" }
    foreach ($looseObject in @(Get-ChildItem -LiteralPath (Join-Path $productionRepository ".git/objects") -File -Recurse -Force | Where-Object {
        $_.DirectoryName -notmatch "[\\/]objects[\\/](?:info|pack)$"
    })) { $looseObject.IsReadOnly = $false }
    $productionRevision = (& $gitPath -C $productionRepository rev-parse HEAD).Trim()
    Assert-Contract ($productionRevision -match "^[0-9a-f]{40}$") "the real-path fixture revision must be a real Git commit"
    [void] [IO.Directory]::CreateDirectory((Join-Path $productionRepository "sandbox-evidence.local/aws"))

    $sourceRecords = @($productionSourcePaths | ForEach-Object {
        [ordered]@{ path = $_; sourceSha256 = Test-FileSha256 (Join-Path $productionRepository $_) }
    })
    $imageId = "sha256:" + ("8" * 64)
    $imageReference = "refunddesk-edge-operator:fixture"
    $imageConfig = [ordered]@{
        Cmd = @()
        Entrypoint = @("/usr/local/bin/refunddesk-edge-operator")
        Env = @("PATH=/usr/local/bin:/usr/bin:/bin")
        ExposedPorts = $null
        Healthcheck = $null
        Labels = [ordered]@{ "com.refunddesk.fixture" = "true" }
        User = "10001:10001"
        WorkingDir = "/workspace"
    }
    $imageConfigSha256 = Test-Sha256Bytes ([Text.UTF8Encoding]::new($false).GetBytes((Canonical $imageConfig)) )
    $operatorTools = [ordered]@{
        aws = [ordered]@{ path = "/usr/local/bin/aws"; sha256 = "1" * 64; version = "aws-cli/fixture" }
        bash = [ordered]@{ path = "/usr/bin/bash"; sha256 = "2" * 64; version = "GNU bash fixture" }
        curl = [ordered]@{ path = "/usr/bin/curl"; sha256 = "3" * 64; version = "curl fixture" }
        git = [ordered]@{ path = "/usr/bin/git"; sha256 = "4" * 64; version = "git version fixture" }
        jq = [ordered]@{ path = "/usr/bin/jq"; sha256 = "5" * 64; version = "jq-fixture" }
        node = [ordered]@{ path = "/usr/local/bin/node"; sha256 = "6" * 64; version = "v24.18.0" }
        python3 = [ordered]@{ path = "/usr/bin/python3"; sha256 = "7" * 64; version = "Python fixture" }
        ssh = [ordered]@{ path = "/usr/bin/ssh"; sha256 = "8" * 64; version = "OpenSSH fixture" }
    }

    $nowProduction = [DateTime]::UtcNow
    $incidentCapturedAt = $nowProduction.AddSeconds(-50).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $incidentCompletedAt = $nowProduction.AddSeconds(-45).ToString("yyyy-MM-ddTHH:mm:ssZ")
    # The admitted postflight predates the incident capture, and the incident
    # predates this edge invocation.  Keep explicit multi-second separation so
    # the production harness exercises the real ADR 0036 chronology.
    $preflightCapturedAt = $nowProduction.AddSeconds(-60).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $preflightValidUntil = $nowProduction.AddMinutes(14).ToString("yyyy-MM-ddTHH:mm:ssZ")
    # ADR 0036 clips its outer expiry to the earliest upstream validity.  It
    # therefore has a positive lifetime no greater than 15 minutes, while the
    # embedded ADR 0034 postflight retains its exact 900-second TTL.
    $incidentValidUntil = $preflightValidUntil
    $authorizationFrom = $nowProduction.AddMinutes(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $authorizationUntil = $nowProduction.AddMinutes(110).ToString("yyyy-MM-ddTHH:mm:ssZ")
    Assert-Contract (
        ([DateTime]::Parse($incidentCapturedAt).ToUniversalTime() - [DateTime]::Parse($preflightCapturedAt).ToUniversalTime()).TotalSeconds -gt 1 -and
        ($nowProduction - [DateTime]::Parse($incidentCapturedAt).ToUniversalTime()).TotalSeconds -gt 1 -and
        ([DateTime]::Parse($preflightValidUntil).ToUniversalTime() - [DateTime]::Parse($preflightCapturedAt).ToUniversalTime()).TotalSeconds -eq 900 -and
        ([DateTime]::Parse($incidentValidUntil).ToUniversalTime() - [DateTime]::Parse($incidentCapturedAt).ToUniversalTime()).TotalSeconds -gt 0 -and
        ([DateTime]::Parse($incidentValidUntil).ToUniversalTime() - [DateTime]::Parse($incidentCapturedAt).ToUniversalTime()).TotalSeconds -le 900 -and
        ([DateTime]::Parse($preflightValidUntil).ToUniversalTime() - $nowProduction).TotalSeconds -ge 720 -and
        ([DateTime]::Parse($incidentValidUntil).ToUniversalTime() - $nowProduction).TotalSeconds -ge 720 -and
        [DateTime]::Parse($authorizationFrom).ToUniversalTime() -le $nowProduction -and
        [DateTime]::Parse($authorizationUntil).ToUniversalTime() -gt $nowProduction.AddMinutes(100)
    ) "the fixture chronology must preserve the 15-minute admission TTLs separately from the 35-minute authorization budget"
    $promotionNonce = "9" * 64
    $bundleSha256 = "a" * 64
    $manifestSha256 = "b" * 64
    $promotionProvenanceSha256 = "c" * 64
    $sourceSha256 = "d" * 64
    $containerIds = [ordered]@{
        caddy = "1" * 64
        postgres = "2" * 64
        verifier = "3" * 64
        web = "4" * 64
        worker = "5" * 64
    }
    $systemIdentifier = "7392847561029384756"
    $promotion = [ordered]@{
        database = [ordered]@{ systemIdentifier = $systemIdentifier }
        runtime = [ordered]@{
            caddyContainerId = $containerIds.caddy
            postgresContainerId = $containerIds.postgres
            verifierContainerId = $containerIds.verifier
            webContainerId = $containerIds.web
            workerContainerId = $containerIds.worker
            workerRuntimeMode = "incident_admission"
        }
    }
    $promotionPath = Join-Path $productionInputs "promotion.json"
    Write-TestJson $promotionPath $promotion
    $promotionSha256 = Test-FileSha256 $promotionPath

    $database = [ordered]@{
        activeFinancialJobs = 0
        activeWorkflows = 0
        apiMutationReceipts = 11
        auditEvents = 12
        liveInstallations = 0
        liveTenants = 0
        preparedTransactions = 0
        refundExecutionAttempts = 13
        refundExecutions = 14
        refundRequests = 15
        snapshotAvailable = $true
        systemIdentifier = $systemIdentifier
        unreleasedPaymentGuards = 0
        webhookReceipts = 16
    }
    $containers = @(
        [ordered]@{ containerId = $containerIds.postgres; effectiveWorkerRuntimeMode = $null; service = "postgres" },
        [ordered]@{ containerId = $containerIds.verifier; effectiveWorkerRuntimeMode = $null; service = "verifier" },
        [ordered]@{ containerId = $containerIds.worker; effectiveWorkerRuntimeMode = "INCIDENT_ADMISSION"; service = "worker" },
        [ordered]@{ containerId = $containerIds.web; effectiveWorkerRuntimeMode = $null; service = "web" },
        [ordered]@{ containerId = $containerIds.caddy; effectiveWorkerRuntimeMode = $null; service = "caddy" }
    )
    $identity = [ordered]@{ releaseEnvironmentWorkerRuntimeMode = "INCIDENT_ADMISSION" }
    $capture = [ordered]@{ containers = $containers; database = $database; identity = $identity }
    $preflight = [ordered]@{
        awsControlPlane = [ordered]@{ fixture = $true }
        capturedAt = $preflightCapturedAt
        provenance = [ordered]@{ fixtureOnly = $true }
        remote = [ordered]@{ captures = [ordered]@{ a = $capture; b = $capture } }
        validUntil = $preflightValidUntil
    }
    $preflightPath = Join-Path $productionInputs "preflight.json"
    Write-TestJson $preflightPath $preflight
    $preflightSha256 = Test-FileSha256 $preflightPath
    $postIncidentCounts = [ordered]@{
        activeFinancialJobs = 0
        auditEvents = 12
        mutationReceipts = 11
        refundExecutionAttempts = 13
        refundExecutions = 14
        refundRequests = 15
        unreleasedPaymentGuards = 0
        webhookReceipts = 16
    }
    $postIncidentBaseline = [ordered]@{
        activeFinancialJobs = $postIncidentCounts.activeFinancialJobs
        auditEvents = $postIncidentCounts.auditEvents
        mutationReceipts = $postIncidentCounts.mutationReceipts
        refundExecutionAttempts = $postIncidentCounts.refundExecutionAttempts
        refundExecutions = $postIncidentCounts.refundExecutions
        refundRequests = $postIncidentCounts.refundRequests
        snapshotSha256 = Test-TextSha256 ((Canonical $postIncidentCounts).TrimEnd("`n"))
        unreleasedPaymentGuards = $postIncidentCounts.unreleasedPaymentGuards
        webhookReceipts = $postIncidentCounts.webhookReceipts
    }
    $candidateBinding = [ordered]@{
        caddyContainerIdSha256 = Test-TextSha256 $containerIds.caddy
        postgresContainerIdSha256 = Test-TextSha256 $containerIds.postgres
        systemIdentifierSha256 = Test-TextSha256 $systemIdentifier
        verifierContainerIdSha256 = Test-TextSha256 $containerIds.verifier
        webContainerIdSha256 = Test-TextSha256 $containerIds.web
        workerContainerIdSha256 = Test-TextSha256 $containerIds.worker
    }
    $incident = [ordered]@{
        capturedAt = $incidentCapturedAt
        finalPostflight = [ordered]@{
            awsControlPlane = $preflight.awsControlPlane
            candidateBinding = $candidateBinding
            capturedAt = $preflightCapturedAt
            firewallClosed = $true
            officialValidation = $true
            postIncidentBaselineSha256 = $postIncidentBaseline.snapshotSha256
            posture = "COHERENT_CONTAINED"
            provenance = $preflight.provenance
            revision = $productionRevision
            sha256 = $preflightSha256
            validUntil = $preflightValidUntil
            workerRuntimeMode = "incident_admission"
        }
        postIncidentBaseline = $postIncidentBaseline
        provenance = [ordered]@{ promotionEvidenceSha256 = $promotionSha256 }
        remote = [ordered]@{
            completedAt = $incidentCompletedAt
            postIncidentBaseline = $postIncidentBaseline
            promotion = [ordered]@{
                bundleSha256 = $bundleSha256
                candidateRevision = $productionRevision
                contained = $true
                evidenceSha256 = $promotionSha256
                manifestSha256 = $manifestSha256
                postflightAfterPromotion = $true
                provenanceSha256 = $promotionProvenanceSha256
                sourceSha256 = $sourceSha256
            }
        }
        validUntil = $incidentValidUntil
    }
    $incidentPath = Join-Path $productionInputs "incident.json"
    Write-TestJson $incidentPath $incident
    $incidentSha256 = Test-FileSha256 $incidentPath

    $authorization = [ordered]@{
        awsAccountId = "633229204288"
        awsRegion = "eu-west-3"
        code = "PASS_EDGE_WINDOW_AUTHORIZED"
        distributionId = "E123456789ABC"
        eventFingerprintSha256 = "e" * 64
        expectedRevision = $productionRevision
        expectedSshCidr = "192.0.2.44/32"
        instanceName = "refunddesk-sandbox-paris"
        kind = "refunddesk.edge-window.authorization"
        maxWindowSeconds = 60
        originId = "refunddesk-origin"
        publicBaseUrl = "https://fixture.invalid"
        result = "PASS"
        schemaVersion = 1
        sourceRef = "refs/heads/main"
        sshHost = "fixture.invalid"
        validFrom = $authorizationFrom
        validUntil = $authorizationUntil
    }
    $authorizationPath = Join-Path $productionInputs "authorization.json"
    Write-TestJson $authorizationPath $authorization

    $operatorArchiveName = "refunddesk-edge-operator-$productionRevision.docker.tar.zst"
    $operatorArchivePath = Join-Path $productionInputs $operatorArchiveName
    $operatorArchiveSidecarPath = "$operatorArchivePath.sha256"
    $attestationPath = Join-Path $productionInputs "edge-operator.attestation.jsonl"
    [IO.File]::WriteAllText($operatorArchivePath, "fixture-archive`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($attestationPath, "fixture-attestation`n", [Text.UTF8Encoding]::new($false))
    $operatorArchiveSha256 = Test-FileSha256 $operatorArchivePath
    [IO.File]::WriteAllText(
        $operatorArchiveSidecarPath,
        "$operatorArchiveSha256  $operatorArchiveName`n",
        [Text.UTF8Encoding]::new($false)
    )
    $operatorArchiveSidecarSha256 = Test-FileSha256 $operatorArchiveSidecarPath
    $attestationSha256 = Test-FileSha256 $attestationPath
    $operatorManifest = [ordered]@{
        archive = [ordered]@{
            file = $operatorArchiveName
            sha256 = $operatorArchiveSha256
            sizeBytes = [long] (Get-Item -LiteralPath $operatorArchivePath).Length
        }
        image = [ordered]@{ configSha256 = $imageConfigSha256; id = $imageId; reference = $imageReference }
        schemaVersion = 1
        tools = $operatorTools
    }
    $operatorManifestPath = Join-Path $productionInputs "edge-operator.manifest.json"
    Write-TestJson $operatorManifestPath $operatorManifest
    $operatorProvenance = [ordered]@{
        archiveSha256 = $operatorArchiveSha256
        attestationBundleSha256 = $attestationSha256
        createdAt = $nowProduction.ToString("yyyy-MM-ddTHH:mm:ssZ")
        kind = "refunddesk-edge-operator-input-provenance"
        manifestSha256 = Test-FileSha256 $operatorManifestPath
        rekorEntryIndex = 737
        repository = "selimhehe1/RefundDesk"
        revision = $productionRevision
        schemaVersion = 1
        sourceRef = "refs/heads/main"
        verification = "github-actions-attestation-bundle-issued"
        workflowPath = ".github/workflows/sandbox-images.yml"
        workflowRunAttempt = 1
        workflowRunId = 37001
    }
    $operatorProvenancePath = Join-Path $productionInputs "edge-operator.provenance.json"
    Write-TestJson $operatorProvenancePath $operatorProvenance
    foreach ($authorityPath in @(
        $incidentPath, $preflightPath, $promotionPath, $authorizationPath,
        $operatorManifestPath, $operatorArchivePath, $operatorArchiveSidecarPath,
        $attestationPath, $operatorProvenancePath
    )) { Set-TestFileAcl $authorityPath }

    $gitHubTokenPath = Join-Path $productionRoot "github-token.txt"
    $awsCredentialsPath = Join-Path $productionRoot "aws-credentials"
    $sshIdentityPath = Join-Path $productionRoot "ssh-identity"
    $knownHostsPath = Join-Path $productionRoot "known-hosts"
    [IO.File]::WriteAllText($gitHubTokenPath, ("ghp_" + ("A" * 40) + "`n"), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($awsCredentialsPath, "[default]`naws_access_key_id=fixture`naws_secret_access_key=fixture`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($sshIdentityPath, "fixture-identity`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($knownHostsPath, "fixture.invalid ssh-rsa fixture`n", [Text.UTF8Encoding]::new($false))
    foreach ($sensitivePath in @($gitHubTokenPath, $awsCredentialsPath, $sshIdentityPath, $knownHostsPath)) { Set-TestFileAcl $sensitivePath }

    $realNodePath = (Get-Command node.exe).Source
    Assert-Contract ([IO.File]::Exists($realNodePath)) "the faithful official-validator fixture requires the real pinned Node executable"
    $fixtureConfig = [ordered]@{
        archiveSha256 = $operatorArchiveSha256
        containerIds = $containerIds
        imageConfig = $imageConfig
        imageId = $imageId
        imageReference = $imageReference
        incidentCapturedAt = $incidentCapturedAt
        incidentValidUntil = $incidentValidUntil
        realNodePath = $realNodePath
        realNodeSha256 = Test-FileSha256 $realNodePath
        rekorEntryIndex = 737
        requestBootIdSha256 = "f" * 64
        requestedBoottimeMilliseconds = 123456789
        sourceRecords = $sourceRecords
        systemIdentifier = $systemIdentifier
        tools = $operatorTools
        workflowRunAttempt = 1
        workflowRunId = 37001
    }
    Write-TestJson (Join-Path $productionRoot "fixture-config.json") $fixtureConfig
    $context = [pscustomobject]@{
        AttestationPath = $attestationPath; AttestationSha256 = $attestationSha256
        AuthorizationPath = $authorizationPath; AuthorizationSha256 = Test-FileSha256 $authorizationPath
        AwsCredentialsPath = $awsCredentialsPath; BundleSha256 = $bundleSha256
        FixtureRoot = $productionRoot; GitHubTokenPath = $gitHubTokenPath
        InputRoot = $productionInputs
        IncidentPath = $incidentPath; IncidentSha256 = $incidentSha256
        KnownHostsPath = $knownHostsPath; ManifestSha256 = $manifestSha256
        OperatorArchivePath = $operatorArchivePath; OperatorArchiveSha256 = $operatorArchiveSha256
        OperatorArchiveSidecarPath = $operatorArchiveSidecarPath; OperatorArchiveSidecarSha256 = $operatorArchiveSidecarSha256
        OperatorManifestPath = $operatorManifestPath; OperatorManifestSha256 = Test-FileSha256 $operatorManifestPath
        OperatorProvenancePath = $operatorProvenancePath; OperatorProvenanceSha256 = Test-FileSha256 $operatorProvenancePath
        PreflightPath = $preflightPath; PreflightSha256 = $preflightSha256
        PromotionNonce = $promotionNonce; PromotionPath = $promotionPath; PromotionSha256 = $promotionSha256
        PromotionProvenanceSha256 = $promotionProvenanceSha256; Revision = $productionRevision
        SourceSha256 = $sourceSha256; SshIdentityPath = $sshIdentityPath
        TestRoot = $temporary; WrapperPath = $wrapperPath
    }

    $noStdoutFixture = Join-Path $productionInputs "runner-exit21-no-stdout.json"
    Copy-Item -LiteralPath $incompleteFixture -Destination $noStdoutFixture
    $transportPathEscapeFixture = Join-Path $productionInputs "transport-ssh-path-escape.json"
    $transportDigestDriftFixture = Join-Path $productionInputs "transport-aws-digest-drift.json"
    Copy-Item -LiteralPath $incompleteFixture -Destination $transportPathEscapeFixture
    Copy-Item -LiteralPath $incompleteFixture -Destination $transportDigestDriftFixture
    if ($NoStdoutRecoveryOnly) {
        Invoke-NoStdoutPostCrashScenario $context $noStdoutFixture $submitPath
    }
    elseif ($TransportBindingOnly) {
        Invoke-TransportPreEffectNegativeScenario $context $transportPathEscapeFixture "transport-ssh-path-escape" "TRANSPORT_SSH_CONFIG_PATH_INVALID"
        Invoke-TransportPreEffectNegativeScenario $context $transportDigestDriftFixture "transport-aws-digest-drift" "TRANSPORT_CONFIG_DIGEST_INVALID"
    }
    elseif ($OperatorClockOnly) {
        $operationsPath = Join-Path $productionRoot "operations.jsonl"
        $clockObservationsPath = Join-Path $productionRoot "operator-clock-observations.jsonl"

        $rollbackPass = Invoke-OperatorClockTerminalScenario $context $passFixture "clock-wall-rollback" $submitPath -300 600000 0
        Assert-Contract ($rollbackPass.Result.ExitCode -eq 0 -and
            $rollbackPass.Result.Stdout.Trim() -match "^edge-window-$productionRevision-[0-9a-f]{12}\.local\.json$") "ten monotonic preparation minutes with a five-minute wall rollback must still traverse only the reduced runner grant"
        if ($rollbackPass.Result.ExitCode -eq 0) {
            $rollbackEvidence = Get-Content -LiteralPath (Join-Path $rollbackPass.Output $rollbackPass.Result.Stdout.Trim()) -Raw | ConvertFrom-Json
            Assert-Contract (
                [long] $rollbackEvidence.provenance.operatorDeadlineMonotonicMilliseconds -
                    [long] $rollbackEvidence.provenance.operatorStartedMonotonicMilliseconds -eq 2100000 -and
                [long] $rollbackEvidence.provenance.operatorControlCalculatedMonotonicMilliseconds -
                    [long] $rollbackEvidence.provenance.operatorStartedMonotonicMilliseconds -eq 600000 -and
                [long] $rollbackEvidence.provenance.operationRemainingSecondsAtRunnerStart -eq 1260 -and
                [string] $rollbackEvidence.provenance.operatorBootIdentifierSha256 -cmatch "^[0-9a-f]{64}$"
            ) "wall-clock rollback must not restore any of the 600 monotonic seconds consumed before control sealing"
        }
        $rollbackObservation = Get-Content -LiteralPath $clockObservationsPath -Tail 1 | ConvertFrom-Json
        Assert-Contract ([long] $rollbackObservation.operationRemainingSecondsAtRunnerStart -eq 1260 -and
            [long] $rollbackObservation.operatorControlCalculatedMonotonicMilliseconds -
                [long] $rollbackObservation.operatorStartedMonotonicMilliseconds -eq 600000) "the fake runner must independently observe the exact reduced Windows grant"

        $reserveBoundaryPass = Invoke-OperatorClockTerminalScenario $context $passFixture "clock-reserve-boundary" $submitPath 0 0 210000
        Assert-Contract ($reserveBoundaryPass.Result.ExitCode -eq 0) "the exact t_calc plus 210-second pre-start boundary must remain admissible with the reserved 30-second start timeout"

        $operationsBeforeReserveFailure = @(Get-Content -LiteralPath $operationsPath).Count
        $reserveFailure = Invoke-OperatorClockNoStartScenario $context $passFixture "clock-reserve-exceeded" 0 210001
        $reserveFailureOperations = @(Get-Content -LiteralPath $operationsPath | Select-Object -Skip $operationsBeforeReserveFailure)
        $reserveFailureMarker = @(Get-ChildItem -LiteralPath $reserveFailure.Output -Filter "edge-window-attempt-$productionRevision-*.local.json" -File)[0] | Get-Content -Raw | ConvertFrom-Json
        Assert-Contract ($reserveFailure.Result.ExitCode -eq 21 -and
            $reserveFailure.Result.Stderr.Contains("OPERATOR_CLOCK_CLEANUP_ONLY") -and
            $reserveFailure.Result.Stdout.Length -eq 0 -and $reserveFailureMarker.operatorClockInvalidated -eq $true -and
            $reserveFailureMarker.state -ceq "cleanup_complete") "one millisecond beyond the reserved pre-start boundary must latch and finish cleanup-only 21"
        Assert-Contract ((($reserveFailureOperations -join "`n").Contains('"container","create"')) -and
            -not (($reserveFailureOperations -join "`n").Contains('"container","start"')) -and
            @(Get-ChildItem -LiteralPath $reserveFailure.Output -Filter "edge-window-$productionRevision-*.local.json" -File).Count -eq 0) "reserve exhaustion may clean a never-started container but must never start a runner or publish PASS"

        $operationsBeforeBootDrift = @(Get-Content -LiteralPath $operationsPath).Count
        $bootDrift = Invoke-OperatorClockNoStartScenario $context $passFixture "clock-boot-drift" 0 0 ("0" * 64)
        $bootDriftOperations = @(Get-Content -LiteralPath $operationsPath | Select-Object -Skip $operationsBeforeBootDrift)
        $bootDriftMarker = @(Get-ChildItem -LiteralPath $bootDrift.Output -Filter "edge-window-attempt-$productionRevision-*.local.json" -File)[0] | Get-Content -Raw | ConvertFrom-Json
        $bootDriftOperationText = $bootDriftOperations -join "`n"
        Assert-Contract ($bootDrift.Result.ExitCode -eq 21 -and $bootDriftMarker.operatorClockInvalidated -eq $true -and
            $bootDriftMarker.state -ceq "cleanup_complete" -and $bootDrift.Result.Stdout.Length -eq 0) "a changed Windows boot generation must be durable cleanup-only 21"
        Assert-Contract (-not $bootDriftOperationText.Contains('"image","load"') -and
            -not $bootDriftOperationText.Contains('"volume","create"') -and
            -not $bootDriftOperationText.Contains('"container","create"') -and
            -not $bootDriftOperationText.Contains('"container","start"')) "boot drift immediately after marker creation must perform zero new OCI, volume or runner effect"

        $latchContext = New-OperatorClockAdmissionContext $context "clock-latch-crash"
        $latchOutput = Join-Path $temporary "production-output-clock-latch-crash"
        [void] [IO.Directory]::CreateDirectory($latchOutput); Set-TestAcl $latchOutput
        $latchRunning = Start-ProductionWrapperFixture -Context $latchContext -TerminalPath $incompleteFixture -OutputPath $latchOutput `
            -CheckpointPath (Join-Path $latchOutput "checkpoint.json") -CrashAfter "after_operator_clock_invalidated" `
            -CapturePrefix (Join-Path $temporary "clock-latch-crash") -RunnerMonitorMonotonicAdvanceMilliseconds 2100000
        $latchCrashResult = Complete-ProductionWrapperFixture $latchRunning
        $latchMarkerPath = @(Get-ChildItem -LiteralPath $latchOutput -Filter "edge-window-attempt-$productionRevision-*.local.json" -File)[0].FullName
        $latchMarker = Get-Content -LiteralPath $latchMarkerPath -Raw | ConvertFrom-Json
        Assert-Contract ($latchCrashResult.ExitCode -eq 99 -and $latchMarker.operatorClockInvalidated -eq $true -and
            $latchMarker.state -ceq "prepared" -and
            @(Get-ChildItem -LiteralPath $latchOutput -Filter "edge-window-$productionRevision-*.local.json" -File).Count -eq 0) "a hard crash after the durable clock latch must precede containment and leave no canonical terminal"
        $latchedContainerStatePath = Join-Path (Join-Path (Join-Path $productionRoot "fake-containers") ([string] $latchMarker.containerName)) "state.json"
        Write-TestJson $latchedContainerStatePath ([ordered]@{ ExitCode = 21; Running = $false; Stage = 9; Status = "exited" })
        $latchResume = Start-ProductionWrapperFixture -Context $latchContext -TerminalPath $incompleteFixture -OutputPath $latchOutput `
            -CheckpointPath (Join-Path $latchOutput "checkpoint.json") -CrashAfter "none" `
            -CapturePrefix (Join-Path $temporary "clock-latch-resume")
        $latchResumeResult = Complete-ProductionWrapperFixture $latchResume
        $latchClosedMarker = Get-Content -LiteralPath $latchMarkerPath -Raw | ConvertFrom-Json
        Assert-Contract ($latchResumeResult.ExitCode -eq 21 -and $latchResumeResult.Stdout.Length -eq 0 -and
            $latchClosedMarker.operatorClockInvalidated -eq $true -and $latchClosedMarker.state -ceq "cleanup_complete" -and
            @(Get-ChildItem -LiteralPath $latchOutput -Filter "edge-window-$productionRevision-*.local.json" -File).Count -eq 0) "post-latch replay may consume only safe 20/21 cleanup and can never recover PASS 0"

        $substituteContext = New-OperatorClockAdmissionContext $context "clock-unbound-substitute"
        $substituteOutput = Join-Path $temporary "production-output-clock-unbound-substitute"
        [void] [IO.Directory]::CreateDirectory($substituteOutput); Set-TestAcl $substituteOutput
        $substituteCrash = Start-ProductionWrapperFixture -Context $substituteContext -TerminalPath $passFixture -OutputPath $substituteOutput `
            -CheckpointPath (Join-Path $substituteOutput "checkpoint.json") -CrashAfter "after_attempt_marker" `
            -CapturePrefix (Join-Path $temporary "clock-unbound-substitute-crash")
        $substituteCrashResult = Complete-ProductionWrapperFixture $substituteCrash
        $substituteMarkerPath = @(Get-ChildItem -LiteralPath $substituteOutput -Filter "edge-window-attempt-$productionRevision-*.local.json" -File)[0].FullName
        $substituteMarker = Get-Content -LiteralPath $substituteMarkerPath -Raw | ConvertFrom-Json
        $substitutedEvidencePath = Join-Path $substituteOutput ("edge-window-{0}-{1}.local.json" -f $productionRevision, ([string] $substituteMarker.nonce).Substring(0, 12))
        [IO.File]::WriteAllText($substitutedEvidencePath, "{}`n", [Text.UTF8Encoding]::new($false)); Set-TestFileAcl $substitutedEvidencePath
        $substituteResume = Start-ProductionWrapperFixture -Context $substituteContext -TerminalPath $passFixture -OutputPath $substituteOutput `
            -CheckpointPath (Join-Path $substituteOutput "checkpoint.json") -CrashAfter "none" `
            -CapturePrefix (Join-Path $temporary "clock-unbound-substitute-resume") `
            -PostMarkerMonotonicAdvanceMilliseconds 2100000
        $substituteResumeResult = Complete-ProductionWrapperFixture $substituteResume
        $substituteClosedMarker = Get-Content -LiteralPath $substituteMarkerPath -Raw | ConvertFrom-Json
        Assert-Contract ($substituteCrashResult.ExitCode -eq 99 -and $substituteResumeResult.ExitCode -eq 21 -and
            $substituteResumeResult.Stdout.Length -eq 0 -and $substituteClosedMarker.operatorClockInvalidated -eq $true -and
            $substituteClosedMarker.state -ceq "cleanup_complete" -and [IO.File]::Exists($substitutedEvidencePath)) "an invalid substituted unbound pathname must be preserved forensics but cannot suppress the clock latch or recover PASS"
    }
    elseif ($InputAdmissionOnly) {
        $productionPass = Invoke-ProductionTerminalScenario $context $passFixture "input-admission-pass" $submitPath
        Assert-Contract (
            $productionPass.Result.ExitCode -eq 0 -and
            $productionPass.Result.Stdout.Trim() -match "^edge-window-$productionRevision-[0-9a-f]{12}\.local\.json$"
        ) "the TTL/ACL/sidecar positive must traverse the real wrapper, runner fixture and official edge validator"
        if ($productionPass.Result.ExitCode -ne 0) {
            $realNodeDiagnosticsPath = Join-Path $productionRoot "real-node-results.jsonl"
            $realNodeDiagnostics = if (Test-Path -LiteralPath $realNodeDiagnosticsPath) {
                (Get-Content -LiteralPath $realNodeDiagnosticsPath -Tail 5) -join " | "
            } else { "none" }
            throw "input-admission positive failed: wrapper=$($productionPass.Result.Stderr.Trim()); realNode=$realNodeDiagnostics"
        }
        if ($productionPass.Result.ExitCode -eq 0) {
            $positiveEvidence = Get-Content -LiteralPath (Join-Path $productionPass.Output $productionPass.Result.Stdout.Trim()) -Raw | ConvertFrom-Json
            $positiveStartedAt = [DateTime]::ParseExact([string] $positiveEvidence.startedAt, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
            $positiveOperationStartedAt = [DateTime]::ParseExact([string] $positiveEvidence.operationStartedAt, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
            $positivePostflightValidUntil = [DateTime]::ParseExact([string] $positiveEvidence.admission.postflightValidUntil, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
            $positiveIncidentValidUntil = [DateTime]::ParseExact([string] $positiveEvidence.admission.incidentValidUntil, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
            $positiveAuthorizationUntil = [DateTime]::ParseExact([string] $positiveEvidence.admission.authorizationValidUntil, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
            $derivedPostflightRemaining = [int] [Math]::Floor(($positivePostflightValidUntil - $positiveOperationStartedAt).TotalSeconds)
            $derivedIncidentRemaining = [int] [Math]::Floor(($positiveIncidentValidUntil - $positiveOperationStartedAt).TotalSeconds)
            Assert-Contract (
                $positiveOperationStartedAt -eq $positiveStartedAt -and
                [int] $positiveEvidence.admission.postflightRemainingSecondsAtStart -ge 720 -and
                [int] $positiveEvidence.admission.postflightRemainingSecondsAtStart -le 900 -and
                [int] $positiveEvidence.admission.incidentRemainingSecondsAtStart -eq $derivedIncidentRemaining -and
                $derivedPostflightRemaining -ge 720 -and $derivedPostflightRemaining -le 900 -and
                $derivedIncidentRemaining -ge 720 -and $derivedIncidentRemaining -le 900 -and
                $positiveAuthorizationUntil -ge $positiveOperationStartedAt.AddMinutes(35)
            ) "the runner-visible control must preserve both short admission TTLs while authorization separately covers 35 minutes"
        }

        $operationsPath = Join-Path $productionRoot "operations.jsonl"
        $operationsBeforeAcl = @(Get-Content -LiteralPath $operationsPath | ForEach-Object { $_ | ConvertFrom-Json })
        $aclNegativeRuns = [Collections.Generic.List[object]]::new()
        foreach ($aclCase in @(
            @("incident", "IncidentPath", "IncidentSha256", $incidentPath, "INCIDENT_EVIDENCE_INVALID"),
            @("preflight", "PreflightPath", "PreflightSha256", $preflightPath, "PREFLIGHT_EVIDENCE_INVALID"),
            @("promotion", "PromotionPath", "PromotionSha256", $promotionPath, "PROMOTION_EVIDENCE_INVALID"),
            @("authorization", "AuthorizationPath", "AuthorizationSha256", $authorizationPath, "AUTHORIZATION_INVALID"),
            @("manifest", "OperatorManifestPath", "OperatorManifestSha256", $operatorManifestPath, "OPERATOR_MANIFEST_INVALID"),
            @("archive", "OperatorArchivePath", "OperatorArchiveSha256", $operatorArchivePath, "OPERATOR_ARCHIVE_INVALID"),
            @("attestation", "AttestationPath", "AttestationSha256", $attestationPath, "OPERATOR_ATTESTATION_INVALID"),
            @("provenance", "OperatorProvenancePath", "OperatorProvenanceSha256", $operatorProvenancePath, "OPERATOR_PROVENANCE_INVALID"),
            @("sidecar", "OperatorArchiveSidecarPath", "OperatorArchiveSidecarSha256", $operatorArchiveSidecarPath, "OPERATOR_ARCHIVE_SIDECAR_INVALID")
        )) {
            $leaf = [string] $aclCase[0]
            $unsafeDirectory = Join-Path $productionRoot "unsafe-acl-$leaf"
            [void] [IO.Directory]::CreateDirectory($unsafeDirectory)
            $unsafePath = Join-Path $unsafeDirectory ([IO.Path]::GetFileName([string] $aclCase[3]))
            [IO.File]::WriteAllBytes($unsafePath, [IO.File]::ReadAllBytes([string] $aclCase[3]))
            Assert-Contract (-not (Get-Acl -LiteralPath $unsafePath).AreAccessRulesProtected) "$leaf negative must actually carry an inherited/unrestricted ACL"
            $negativeContext = Copy-TestContext $context
            $negativeContext.([string] $aclCase[1]) = $unsafePath
            $negativeContext.([string] $aclCase[2]) = Test-FileSha256 $unsafePath
            $negativeOutput = Join-Path $temporary "production-input-acl-$leaf"
            [void] [IO.Directory]::CreateDirectory($negativeOutput); Set-TestAcl $negativeOutput
            $negativeRunning = Start-ProductionWrapperFixture $negativeContext $passFixture $negativeOutput (Join-Path $negativeOutput "checkpoint.json") "none" (Join-Path $temporary "input-acl-$leaf")
            $aclNegativeRuns.Add([pscustomobject]@{ Code = [string] $aclCase[4]; Leaf = $leaf; Running = $negativeRunning })
        }
        foreach ($aclNegative in $aclNegativeRuns) {
            $negativeResult = Complete-ProductionWrapperFixture $aclNegative.Running
            Assert-Contract (
                $negativeResult.ExitCode -eq 21 -and $negativeResult.Stderr.Contains([string] $aclNegative.Code)
            ) "$($aclNegative.Leaf) must reject an inherited/unrestricted ACL before any external fixture tool"
        }
        $operationsAfterAcl = @(Get-Content -LiteralPath $operationsPath | ForEach-Object { $_ | ConvertFrom-Json })
        Assert-Contract ($operationsAfterAcl.Count -eq $operationsBeforeAcl.Count) "all authority/artifact ACL failures must precede fake Node, gh and Docker execution"

        $canonicalSidecarBytes = [IO.File]::ReadAllBytes($operatorArchiveSidecarPath)
        $crlfSidecarBytes = [Text.UTF8Encoding]::new($false).GetBytes("$operatorArchiveSha256  $operatorArchiveName`r`n")
        $bomSidecarBytes = New-Object byte[] ($canonicalSidecarBytes.Length + 3)
        $bomSidecarBytes[0] = 0xef; $bomSidecarBytes[1] = 0xbb; $bomSidecarBytes[2] = 0xbf
        [Array]::Copy($canonicalSidecarBytes, 0, $bomSidecarBytes, 3, $canonicalSidecarBytes.Length)
        $extraSidecarBytes = New-Object byte[] ($canonicalSidecarBytes.Length + 1)
        [Array]::Copy($canonicalSidecarBytes, 0, $extraSidecarBytes, 0, $canonicalSidecarBytes.Length)
        $extraSidecarBytes[$extraSidecarBytes.Length - 1] = [byte] 0x20
        $sidecarNegativeRuns = [Collections.Generic.List[object]]::new()
        foreach ($sidecarCase in @(
            @("crlf", $crlfSidecarBytes),
            @("bom", $bomSidecarBytes),
            @("extra", $extraSidecarBytes)
        )) {
            $leaf = [string] $sidecarCase[0]
            $sidecarDirectory = Join-Path $productionRoot "sidecar-$leaf"
            [void] [IO.Directory]::CreateDirectory($sidecarDirectory)
            $sidecarPath = Join-Path $sidecarDirectory ([IO.Path]::GetFileName($operatorArchiveSidecarPath))
            [IO.File]::WriteAllBytes($sidecarPath, [byte[]] $sidecarCase[1]); Set-TestFileAcl $sidecarPath
            $negativeContext = Copy-TestContext $context
            $negativeContext.OperatorArchiveSidecarPath = $sidecarPath
            $negativeContext.OperatorArchiveSidecarSha256 = Test-FileSha256 $sidecarPath
            $negativeOutput = Join-Path $temporary "production-sidecar-$leaf"
            [void] [IO.Directory]::CreateDirectory($negativeOutput); Set-TestAcl $negativeOutput
            $negativeRunning = Start-ProductionWrapperFixture $negativeContext $passFixture $negativeOutput (Join-Path $negativeOutput "checkpoint.json") "none" (Join-Path $temporary "sidecar-$leaf")
            $sidecarNegativeRuns.Add([pscustomobject]@{ Leaf = $leaf; Running = $negativeRunning })
        }

        $renamedDirectory = Join-Path $productionRoot "sidecar-renamed"
        [void] [IO.Directory]::CreateDirectory($renamedDirectory)
        $renamedArchiveName = "renamed-$productionRevision.docker.tar.zst"
        $renamedArchivePath = Join-Path $renamedDirectory $renamedArchiveName
        $renamedSidecarPath = "$renamedArchivePath.sha256"
        [IO.File]::WriteAllBytes($renamedArchivePath, [IO.File]::ReadAllBytes($operatorArchivePath)); Set-TestFileAcl $renamedArchivePath
        [IO.File]::WriteAllText($renamedSidecarPath, "$operatorArchiveSha256  $renamedArchiveName`n", [Text.UTF8Encoding]::new($false)); Set-TestFileAcl $renamedSidecarPath
        $renamedContext = Copy-TestContext $context
        $renamedContext.OperatorArchivePath = $renamedArchivePath
        $renamedContext.OperatorArchiveSha256 = Test-FileSha256 $renamedArchivePath
        $renamedContext.OperatorArchiveSidecarPath = $renamedSidecarPath
        $renamedContext.OperatorArchiveSidecarSha256 = Test-FileSha256 $renamedSidecarPath
        $renamedOutput = Join-Path $temporary "production-sidecar-renamed"
        [void] [IO.Directory]::CreateDirectory($renamedOutput); Set-TestAcl $renamedOutput
        $renamedRunning = Start-ProductionWrapperFixture $renamedContext $passFixture $renamedOutput (Join-Path $renamedOutput "checkpoint.json") "none" (Join-Path $temporary "sidecar-renamed")
        $sidecarNegativeRuns.Add([pscustomobject]@{ Leaf = "renamed"; Running = $renamedRunning })
        foreach ($sidecarNegative in $sidecarNegativeRuns) {
            $negativeResult = Complete-ProductionWrapperFixture $sidecarNegative.Running
            Assert-Contract (
                $negativeResult.ExitCode -eq 21 -and $negativeResult.Stderr.Contains("OPERATOR_ARCHIVE_SIDECAR_INVALID")
            ) "$($sidecarNegative.Leaf) sidecar bytes/basename must fail closed"
        }

        $ttlNow = [DateTime]::UtcNow
        $stalePreflight = Get-Content -LiteralPath $preflightPath -Raw | ConvertFrom-Json
        $stalePreflight.capturedAt = $ttlNow.AddSeconds(-181).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $stalePreflight.validUntil = $ttlNow.AddSeconds(719).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $stalePreflightPath = Join-Path $productionInputs "preflight-719-seconds.json"
        Write-TestJson $stalePreflightPath $stalePreflight; Set-TestFileAcl $stalePreflightPath
        $stalePreflightSha256 = Test-FileSha256 $stalePreflightPath
        $staleIncident = Get-Content -LiteralPath $incidentPath -Raw | ConvertFrom-Json
        $staleIncident.capturedAt = $ttlNow.AddSeconds(-170).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $staleIncident.validUntil = $ttlNow.AddSeconds(719).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $staleIncident.remote.completedAt = $ttlNow.AddSeconds(-165).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $staleIncident.finalPostflight.capturedAt = $stalePreflight.capturedAt
        $staleIncident.finalPostflight.validUntil = $stalePreflight.validUntil
        $staleIncident.finalPostflight.sha256 = $stalePreflightSha256
        $staleIncidentPath = Join-Path $productionInputs "incident-719-seconds.json"
        Write-TestJson $staleIncidentPath $staleIncident; Set-TestFileAcl $staleIncidentPath
        $staleContext = Copy-TestContext $context
        $staleContext.PreflightPath = $stalePreflightPath
        $staleContext.PreflightSha256 = $stalePreflightSha256
        $staleContext.IncidentPath = $staleIncidentPath
        $staleContext.IncidentSha256 = Test-FileSha256 $staleIncidentPath
        $staleOutput = Join-Path $temporary "production-ttl-719"
        [void] [IO.Directory]::CreateDirectory($staleOutput); Set-TestAcl $staleOutput
        $dockerBeforeStale = @((Get-Content -LiteralPath $operationsPath | ForEach-Object { $_ | ConvertFrom-Json }) | Where-Object { $_.tool -ceq "docker" }).Count
        $staleRunning = Start-ProductionWrapperFixture $staleContext $passFixture $staleOutput (Join-Path $staleOutput "checkpoint.json") "none" (Join-Path $temporary "ttl-719")
        $staleResult = Complete-ProductionWrapperFixture $staleRunning
        $dockerAfterStale = @((Get-Content -LiteralPath $operationsPath | ForEach-Object { $_ | ConvertFrom-Json }) | Where-Object { $_.tool -ceq "docker" }).Count
        Assert-Contract (
            $staleResult.ExitCode -eq 21 -and $staleResult.Stderr.Contains("PREFLIGHT_FRESHNESS_INVALID") -and
            $dockerAfterStale -eq $dockerBeforeStale
        ) "719 seconds remaining must fail closed after local admission checks and before Docker"

        Invoke-PreparedBeforeDockerCrashScenario $context $passFixture
        Invoke-AttemptStartedAtTamperScenario $context $passFixture
    }
    else {
    $negativeRuns = [Collections.Generic.List[object]]::new()
    foreach ($negative in @(
        @("schema-version-string", "schemaVersion", "1"),
        @("run-id-string", "workflowRunId", "37001"),
        @("run-attempt-string", "workflowRunAttempt", "1"),
        @("rekor-string", "rekorEntryIndex", "737"),
        @("created-at-nonexact", "createdAt", "2026-8-09T01:02:03Z")
    )) {
        $property = [string] $negative[1]
        $negativeDocument = Get-Content -LiteralPath $operatorProvenancePath -Raw | ConvertFrom-Json
        $negativeDocument.$property = $negative[2]
        $negativePath = Join-Path $productionInputs ("edge-operator.provenance.{0}.json" -f [string] $negative[0])
        Write-TestJson $negativePath $negativeDocument
        Set-TestFileAcl $negativePath
        $negativeContext = Copy-TestContext $context
        $negativeContext.OperatorProvenancePath = $negativePath
        $negativeContext.OperatorProvenanceSha256 = Test-FileSha256 $negativePath
        $negativeContext = New-FreshAdmissionContext $negativeContext ("provenance-" + [string] $negative[0])
        $negativeOutput = Join-Path $temporary ("production-negative-" + [string] $negative[0])
        [void] [IO.Directory]::CreateDirectory($negativeOutput); Set-TestAcl $negativeOutput
        $negativeRun = Start-ProductionWrapperFixture $negativeContext $passFixture $negativeOutput (Join-Path $negativeOutput "checkpoint.json") "none" (Join-Path $temporary ("negative-" + [string] $negative[0]))
        $negativeRuns.Add([pscustomobject]@{ Code = "OPERATOR_PROVENANCE_INVALID"; Leaf = [string] $negative[0]; Running = $negativeRun })
    }

    $candidateDocument = Get-Content -LiteralPath $incidentPath -Raw | ConvertFrom-Json
    $candidateDocument.finalPostflight.candidateBinding.workerContainerIdSha256 = "0" * 64
    $candidatePath = Join-Path $productionInputs "incident.candidate-binding-invalid.json"
    Write-TestJson $candidatePath $candidateDocument
    Set-TestFileAcl $candidatePath
    $candidateContext = Copy-TestContext $context
    $candidateContext.IncidentPath = $candidatePath
    $candidateContext.IncidentSha256 = Test-FileSha256 $candidatePath
    $candidateContext = New-FreshAdmissionContext $candidateContext "candidate-binding"
    $candidateOutput = Join-Path $temporary "production-negative-candidate-binding"
    [void] [IO.Directory]::CreateDirectory($candidateOutput); Set-TestAcl $candidateOutput
    $candidateRun = Start-ProductionWrapperFixture $candidateContext $passFixture $candidateOutput (Join-Path $candidateOutput "checkpoint.json") "none" (Join-Path $temporary "negative-candidate")
    $negativeRuns.Add([pscustomobject]@{ Code = "INCIDENT_CANDIDATE_BINDING_INVALID"; Leaf = "candidate-binding"; Running = $candidateRun })
    foreach ($negativeRun in $negativeRuns) {
        $negativeResult = Complete-ProductionWrapperFixture $negativeRun.Running
        Assert-Contract ($negativeResult.ExitCode -eq 21 -and $negativeResult.Stderr.Contains([string] $negativeRun.Code)) "$($negativeRun.Leaf) must fail closed before Docker mutation (exit=$($negativeResult.ExitCode), stderr=$($negativeResult.Stderr.Trim()))"
    }

    Invoke-UncommittedInputCrashScenario $context $passFixture "after_input_volume_create" "crash-input-volume-created"
    Invoke-UncommittedInputCrashScenario $context $passFixture "after_input_seal_before_marker" "crash-input-sealed-pre-marker"

    $productionPass = Invoke-ProductionTerminalScenario $context $passFixture "pass" $submitPath
    $productionFail = Invoke-ProductionTerminalScenario $context $failFixture "fail" $submitPath
    $productionIncomplete = Invoke-ProductionTerminalScenario $context $incompleteFixture "incomplete" $submitPath
    Assert-Contract ($productionPass.Result.ExitCode -eq 0 -and $productionPass.Result.Stdout.Trim() -match "^edge-window-$productionRevision-[0-9a-f]{12}\.local\.json$") "the real wrapper path must preserve terminal exit 0"
    Assert-Contract ($productionFail.Result.ExitCode -eq 20 -and $productionFail.Result.Stdout.Trim() -match "^edge-window-$productionRevision-[0-9a-f]{12}\.local\.json$") "the real wrapper path must preserve terminal exit 20"
    Assert-Contract ($productionIncomplete.Result.ExitCode -eq 21 -and $productionIncomplete.Result.Stdout.Trim() -match "^edge-window-$productionRevision-[0-9a-f]{12}\.local\.json$") "the real wrapper path must preserve terminal exit 21"
    foreach ($productionScenario in @($productionPass, $productionFail, $productionIncomplete)) {
        $evidencePath = Join-Path $productionScenario.Output $productionScenario.Result.Stdout.Trim()
        $evidenceDocument = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
        Assert-Contract ($evidenceDocument.provenance.fixtureOnly -eq $true) "every real-path terminal fixture must remain fixtureOnly"
        Assert-Contract (
            [int] $evidenceDocument.admission.authorizationMaxWindowSeconds -eq [int] $authorization.maxWindowSeconds -and
            $evidenceDocument.admission.authorizedAwsAccountIdSha256 -ceq (Test-TextSha256 ([string] $authorization.awsAccountId)) -and
            $evidenceDocument.admission.authorizedAwsRegionSha256 -ceq (Test-TextSha256 ([string] $authorization.awsRegion)) -and
            $evidenceDocument.admission.authorizedSshCidrSha256 -ceq (Test-TextSha256 ([string] $authorization.expectedSshCidr)) -and
            $evidenceDocument.topology.awsAccountIdSha256 -ceq $evidenceDocument.admission.authorizedAwsAccountIdSha256 -and
            $evidenceDocument.topology.awsRegionSha256 -ceq $evidenceDocument.admission.authorizedAwsRegionSha256 -and
            $evidenceDocument.topology.sshCidrSha256 -ceq $evidenceDocument.admission.authorizedSshCidrSha256 -and
            [int] $evidenceDocument.window.durationSeconds -eq 60 -and
            [int] $evidenceDocument.window.durationSeconds -le [int] $evidenceDocument.admission.authorizationMaxWindowSeconds
        ) "every real-path terminal fixture must preserve all authorization scope bindings"
    }

    foreach ($postflightNegative in @(
        @("postflight-caddy-running", "a running public Caddy must be rejected by the complete official postflight validator"),
        @("postflight-caddy-image", "Caddy image identity drift must be rejected by the complete official postflight validator"),
        @("postflight-listener", "a reopened public listener must be rejected by the complete official postflight validator"),
        @("postflight-derived-lie", "a false stable/derived summary must be rejected by the complete official postflight validator")
    )) {
        $negativeLeaf = [string] $postflightNegative[0]
        $negativeTerminal = Join-Path $fixtureDirectory "$negativeLeaf.json"
        Copy-Item -LiteralPath $passFixture -Destination $negativeTerminal
        $negativeScenario = Invoke-ProductionTerminalScenario $context $negativeTerminal $negativeLeaf $submitPath
        Assert-Contract (
            $negativeScenario.Result.ExitCode -eq 21 -and
            $negativeScenario.Result.Stderr.Contains("FINAL_POSTFLIGHT_INVALID") -and
            @(Get-ChildItem -LiteralPath $negativeScenario.Output -Filter "edge-window-$productionRevision-*.local.json" -File).Count -eq 0
        ) ([string] $postflightNegative[1])
    }

    $crashOutput = Join-Path $temporary "production-output-crash"
    [void] [IO.Directory]::CreateDirectory($crashOutput); Set-TestAcl $crashOutput
    $crashCheckpoint = Join-Path $crashOutput "checkpoint.json"
    $crashContext = New-FreshAdmissionContext $context "remote-terminal-crash"
    $crashRunning = Start-ProductionWrapperFixture $crashContext $passFixture $crashOutput $crashCheckpoint "after_remote_terminal" (Join-Path $temporary "production-crash")
    $crashRequest = Wait-ProductionRequest $crashOutput $productionRevision $crashRunning
    Assert-Contract ((Invoke-CheckpointSubmit $submitPath $crashRequest $crashCheckpoint (Join-Path $temporary "production-crash-submit.stderr")) -eq 0) "the crash fixture checkpoint must be admitted"
    $crashResult = Complete-ProductionWrapperFixture $crashRunning
    Assert-Contract ($crashResult.ExitCode -eq 99) "the fixture must hard-crash after remote terminal and before local CreateNew"
    Assert-Contract (@(Get-ChildItem -LiteralPath $crashOutput -Filter "edge-window-$productionRevision-*.local.json" -File).Count -eq 0) "the hard crash must precede local terminal evidence creation"
    $crashMarker = @(Get-ChildItem -LiteralPath $crashOutput -Filter "edge-window-attempt-$productionRevision-*.local.json" -File)[0] | Get-Content -Raw | ConvertFrom-Json
    $finalRequestPath = Join-Path $productionRoot ("fake-volumes/{0}/fs/edge-window-operation-{1}/final-postflight-request.json" -f [string] $crashMarker.volume, [string] $crashMarker.nonce)
    $finalRequestText = [IO.File]::ReadAllText($finalRequestPath, [Text.UTF8Encoding]::new($false, $true))
    $finalRequest = $finalRequestText | ConvertFrom-Json
    $actualFinalRequestProperties = @($finalRequest.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $expectedFinalRequestProperties = @("expectedRevision", "kind", "nonce", "requestBootIdSha256", "requestedAt", "requestedBoottimeMilliseconds", "schemaVersion" | Sort-Object -CaseSensitive)
    Assert-Contract (($actualFinalRequestProperties -join "`n") -ceq ($expectedFinalRequestProperties -join "`n") -and
        $finalRequest.requestBootIdSha256 -ceq $fixtureConfig.requestBootIdSha256 -and
        [long] $finalRequest.requestedBoottimeMilliseconds -eq [long] $fixtureConfig.requestedBoottimeMilliseconds -and
        (Canonical $finalRequest) -ceq $finalRequestText) "the persisted final postflight request must preserve the exact boot/boottime anchor bytes"
    $crashResume = Start-ProductionWrapperFixture $crashContext $passFixture $crashOutput $crashCheckpoint "none" (Join-Path $temporary "production-crash-resume")
    $crashResumeResult = Complete-ProductionWrapperFixture $crashResume
    Assert-Contract ($crashResumeResult.ExitCode -eq 0 -and $crashResumeResult.Stdout.Trim() -match "^edge-window-$productionRevision-[0-9a-f]{12}\.local\.json$") "a stopped orphan runner must resume from exact logs without reopening"

    Invoke-NoStdoutPostCrashScenario $context $noStdoutFixture $submitPath
    Invoke-TransportPreEffectNegativeScenario $context $transportPathEscapeFixture "transport-ssh-path-escape" "TRANSPORT_SSH_CONFIG_PATH_INVALID"
    Invoke-TransportPreEffectNegativeScenario $context $transportDigestDriftFixture "transport-aws-digest-drift" "TRANSPORT_CONFIG_DIGEST_INVALID"

    $concurrentOutput = Join-Path $temporary "production-output-concurrent"
    [void] [IO.Directory]::CreateDirectory($concurrentOutput); Set-TestAcl $concurrentOutput
    $concurrentCheckpoint = Join-Path $concurrentOutput "checkpoint.json"
    $concurrentContext = New-FreshAdmissionContext $context "concurrent-runner"
    $firstRunner = Start-ProductionWrapperFixture $concurrentContext $passFixture $concurrentOutput $concurrentCheckpoint "none" (Join-Path $temporary "production-concurrent-first")
    $concurrentRequest = Wait-ProductionRequest $concurrentOutput $productionRevision $firstRunner
    $concurrentMarker = @(Get-ChildItem -LiteralPath $concurrentOutput -Filter "edge-window-attempt-$productionRevision-*.local.json" -File)[0] | Get-Content -Raw | ConvertFrom-Json
    $immutableRoot = Join-Path (Join-Path (Join-Path $productionRoot "fake-volumes") ([string] $concurrentMarker.inputVolume)) "fs"
    $immutableRacePaths = @(
        (Join-Path $immutableRoot ("transport-{0}.json" -f [string] $concurrentMarker.nonce)),
        (Join-Path $immutableRoot ("control-{0}.json" -f [string] $concurrentMarker.nonce))
    )
    $immutableRaceDigests = @($immutableRacePaths | ForEach-Object { Test-FileSha256 $_ })
    foreach ($immutableRacePath in $immutableRacePaths) {
        $writeBlocked = $false
        try {
            $probe = [IO.FileStream]::new($immutableRacePath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $probe.Dispose()
        }
        catch {
            $probeError = $_.Exception
            while ($null -ne $probeError.InnerException) { $probeError = $probeError.InnerException }
            if ($probeError -is [IO.IOException] -or $probeError -is [UnauthorizedAccessException]) { $writeBlocked = $true }
            else { throw }
        }
        Assert-Contract $writeBlocked "same-SID control/transport pathname mutation must be denied after admission and before final evidence"
    }
    Assert-Contract (
        (Test-FileSha256 $immutableRacePaths[0]) -ceq $immutableRaceDigests[0] -and
        (Test-FileSha256 $immutableRacePaths[1]) -ceq $immutableRaceDigests[1]
    ) "the denied same-SID race must leave both immutable inputs byte-identical"
    $looseObject = @(Get-ChildItem -LiteralPath (Join-Path $productionRepository ".git/objects") -File -Recurse | Where-Object { $_.DirectoryName -notmatch "[\\/]objects[\\/](?:info|pack)$" })[0]
    foreach ($lockedPath in @((Join-Path $productionRepository ".git/config"), $looseObject.FullName)) {
        $writeBlocked = $false
        try {
            $probe = [IO.FileStream]::new($lockedPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $probe.Dispose()
        }
        catch {
            $probeError = $_.Exception
            while ($null -ne $probeError.InnerException) { $probeError = $probeError.InnerException }
            if ($probeError -is [IO.IOException] -or $probeError -is [UnauthorizedAccessException]) { $writeBlocked = $true }
            else { throw }
        }
        Assert-Contract $writeBlocked "the running wrapper must hold Git config and every loose object against mutation"
    }
    $secondRunner = Start-ProductionWrapperFixture $concurrentContext $passFixture $concurrentOutput $concurrentCheckpoint "none" (Join-Path $temporary "production-concurrent-second")
    $secondResult = Complete-ProductionWrapperFixture $secondRunner
    Assert-Contract ($secondResult.ExitCode -eq 21 -and $secondResult.Stderr.Contains("ATTEMPT_BUSY")) "a second concurrent wrapper must fail on the deterministic attempt lease"
    Assert-Contract ((Invoke-CheckpointSubmit $submitPath $concurrentRequest $concurrentCheckpoint (Join-Path $temporary "production-concurrent-submit.stderr")) -eq 0) "the serialized first runner checkpoint must pass"
    $firstResult = Complete-ProductionWrapperFixture $firstRunner
    Assert-Contract ($firstResult.ExitCode -eq 0) "the serialized first runner must finish after the competitor is rejected"

    $unsafeDocument = Get-Content -LiteralPath $ambiguousFixture -Raw | ConvertFrom-Json
    $unsafeDocument.code = "CONTROL_PLANE_UNAVAILABLE"
    $unsafeDocument.diagnostics = @("CONTROL_PLANE_UNAVAILABLE")
    $unsafeDocument.origin.bound = $true
    $unsafeDocument.mutations.originUpdates = 0
    $unsafeFixture = Join-Path $productionInputs "effect-before-journal-unbind-failed.json"
    Write-TestJson $unsafeFixture $unsafeDocument
    $unsafeOutput = Join-Path $temporary "production-output-unsafe"
    [void] [IO.Directory]::CreateDirectory($unsafeOutput); Set-TestAcl $unsafeOutput
    $unsafeCheckpoint = Join-Path $unsafeOutput "checkpoint.json"
    $unsafeContext = New-FreshAdmissionContext $context "unsafe-cleanup"
    $unsafeRunning = Start-ProductionWrapperFixture $unsafeContext $unsafeFixture $unsafeOutput $unsafeCheckpoint "none" (Join-Path $temporary "production-unsafe")
    $unsafeRequest = Wait-ProductionRequest $unsafeOutput $productionRevision $unsafeRunning
    Assert-Contract ((Invoke-CheckpointSubmit $submitPath $unsafeRequest $unsafeCheckpoint (Join-Path $temporary "production-unsafe-submit.stderr")) -eq 0) "the unsafe fixture checkpoint must pass before simulated ambiguity"
    $unsafeResult = Complete-ProductionWrapperFixture $unsafeRunning
    $unsafeMarkerPath = @(Get-ChildItem -LiteralPath $unsafeOutput -Filter "edge-window-attempt-$productionRevision-*.local.json" -File)[0].FullName
    $unsafeMarker = Get-Content -LiteralPath $unsafeMarkerPath -Raw | ConvertFrom-Json
    $unsafeVolumePath = Join-Path (Join-Path $productionRoot "fake-volumes") ([string] $unsafeMarker.volume)
    $unsafeInputVolumePath = Join-Path (Join-Path $productionRoot "fake-volumes") ([string] $unsafeMarker.inputVolume)
    Assert-Contract ($unsafeResult.ExitCode -eq 21 -and $unsafeMarker.state -ceq "cleanup_required" -and
        [IO.Directory]::Exists($unsafeVolumePath) -and [IO.Directory]::Exists($unsafeInputVolumePath)) "an effect-before-journal/unbind ambiguity must retain both private volumes"
    $unsafeControl = Get-Content -LiteralPath (Join-Path $unsafeInputVolumePath ("fs/control-{0}.json" -f [string] $unsafeMarker.nonce)) -Raw | ConvertFrom-Json
    Assert-Contract ($unsafeControl.provenance.fixtureOnly -eq $true) "retained ambiguous state must remain unmistakably fixtureOnly"
    $unsafeCleanup = Start-ProductionWrapperFixture $unsafeContext $unsafeFixture $unsafeOutput $unsafeCheckpoint "none" (Join-Path $temporary "production-unsafe-cleanup")
    $unsafeCleanupResult = Complete-ProductionWrapperFixture $unsafeCleanup
    Assert-Contract ($unsafeCleanupResult.ExitCode -eq 21 -and [IO.Directory]::Exists($unsafeVolumePath) -and
        [IO.Directory]::Exists($unsafeInputVolumePath)) "an unsafe cleanup/unbind result must preserve the exact recovery volumes"

    $operations = [IO.File]::ReadAllText((Join-Path $productionRoot "operations.jsonl"))
    Assert-Contract ($operations.Contains('"tool":"node"') -and $operations.Contains('"tool":"docker"') -and $operations.Contains('"tool":"gh"') -and $operations.Contains('"tool":"postflight"')) "the real-path harness must execute every external fake through bounded child processes"
    Assert-Contract ($operations.Contains('"image","load"') -and $operations.Contains('"volume","create"') -and $operations.Contains('"container","create"') -and $operations.Contains('"container","start"') -and $operations.Contains('"container","logs"')) "the real-path harness must traverse OCI, volume, container and runner terminal stages"
    Assert-Contract ($operations.Contains('target=/var/lib/refunddesk/input,readonly') -and
        -not $operations.Contains('/var/lib/refunddesk/control/control-') -and
        -not $operations.Contains('/var/lib/refunddesk/control/transport-')) "every runner and cleanup process must consume control/transport only from the separate read-only input mount"
    Assert-Contract (-not $operations.Contains('target=/workspace') -and -not $operations.Contains("type=bind,source=$productionRepository")) "no fake Docker invocation may bind-mount the caller repository"
    $operationDocuments = @(Get-Content -LiteralPath (Join-Path $productionRoot "operations.jsonl") | ForEach-Object { $_ | ConvertFrom-Json })
    $officialPostflightOperations = @($operationDocuments | Where-Object {
        $_.tool -ceq "node" -and @($_.arguments).Count -gt 0 -and
        [IO.Path]::GetFileName([string] $_.arguments[0]) -ceq "validate-lightsail-postflight.mjs"
    })
    $incidentFinalPostflightOperations = @($operationDocuments | Where-Object {
        $_.tool -ceq "node" -and @($_.arguments).Count -gt 0 -and
        [IO.Path]::GetFileName([string] $_.arguments[0]) -ceq "validate-lightsail-incident-admission.mjs" -and
        @($_.arguments) -contains "--fixture-only" -and @($_.arguments) -contains "true"
    })
    Assert-Contract ($officialPostflightOperations.Count -ge 7 -and
        @($officialPostflightOperations | Where-Object { @($_.arguments) -notcontains "--fixture-only" }).Count -eq 0) "the exact ADR 0034 validator must consume every positive and negative final fixture through its explicit fixture-only boundary"
    Assert-Contract ($incidentFinalPostflightOperations.Count -eq $officialPostflightOperations.Count) "each immutable final capture must traverse the exact incident projection and the independent complete ADR 0034 validator exactly once"
    $postflightCaptures = @(Get-ChildItem -LiteralPath (Join-Path $productionRepository "sandbox-evidence.local/aws") -Filter "host-postflight-fixture-*.local.json" -File)
    Assert-Contract ($postflightCaptures.Count -ge 7) "the bounded postflight producer must leave independently inspectable outer fixture captures"
    foreach ($postflightCapturePath in $postflightCaptures) {
        $postflightCapture = Get-Content -LiteralPath $postflightCapturePath.FullName -Raw | ConvertFrom-Json
        $embeddedText = (ConvertTo-Json -InputObject $postflightCapture.remote -Compress -Depth 100) + "`n"
        $embeddedBytes = [Text.UTF8Encoding]::new($false).GetBytes($embeddedText)
        $outerSha256 = Test-FileSha256 $postflightCapturePath.FullName
        $embeddedSha256 = Test-Sha256Bytes $embeddedBytes
        Assert-Contract ($postflightCapture.provenance.fixtureOnly -eq $true -and
            $postflightCapture.admission -ceq "FIXTURE_ONLY" -and
            $embeddedSha256 -ceq [string] $postflightCapture.provenance.remoteDocumentSha256) "each final fixture must be unmistakably fixtureOnly and bind the official validator's remote bytes"
        $outerConsumers = @($incidentFinalPostflightOperations | Where-Object { $_.stdinSha256 -ceq $outerSha256 })
        $remoteConsumers = @($officialPostflightOperations | Where-Object { $_.stdinSha256 -ceq $embeddedSha256 })
        Assert-Contract ($outerConsumers.Count -eq 1 -and $remoteConsumers.Count -eq 1) "the two validators must consume the exact immutable outer and digest-bound remote byte sequences once each"
    }
    }
    }
}
catch {
    $failures.Add("dynamic Workbench contract threw: $($_.Exception.Message)")
}
finally {
    foreach ($runningFixture in @($runningProductionFixtures)) {
        try { Stop-ProductionWrapperFixture $runningFixture } catch {}
        try { $runningFixture.Process.Dispose() } catch {}
    }
    $runningProductionFixtures.Clear()
    if ([IO.Directory]::Exists($temporary) -and $temporary.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
        $junction = Join-Path $temporary "checkpoint-junction"
        $junctionItem = Get-Item -LiteralPath $junction -Force -ErrorAction SilentlyContinue
        if ($null -ne $junctionItem -and ($junctionItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            try { [IO.Directory]::Delete($junction, $false) } catch {}
        }
        foreach ($temporaryFile in @(Get-ChildItem -LiteralPath $temporary -File -Recurse -Force -ErrorAction SilentlyContinue)) {
            if ($temporaryFile.IsReadOnly) { try { $temporaryFile.IsReadOnly = $false } catch {} }
        }
        for ($cleanupAttempt = 0; $cleanupAttempt -lt 30 -and [IO.Directory]::Exists($temporary); $cleanupAttempt += 1) {
            try { [IO.Directory]::Delete($temporary, $true) }
            catch { Start-Sleep -Milliseconds 100 }
        }
        if ([IO.Directory]::Exists($temporary)) { $failures.Add("temporary contract directory cleanup failed") }
    }
}

if ($failures.Count -ne 0) {
    foreach ($failure in $failures) { [Console]::Error.WriteLine("edge-window-contract-failure:$failure") }
    exit 1
}
[Console]::Out.WriteLine($(if ($NoStdoutRecoveryOnly) {
    "PASS_EDGE_WINDOW_NO_STDOUT_RECOVERY_CONTRACT"
} elseif ($TransportBindingOnly) {
    "PASS_EDGE_WINDOW_TRANSPORT_BINDING_CONTRACT"
} elseif ($InputAdmissionOnly) {
    "PASS_EDGE_WINDOW_INPUT_ADMISSION_CONTRACT"
} elseif ($OperatorClockOnly) {
    "PASS_EDGE_WINDOW_OPERATOR_CLOCK_CONTRACT"
} elseif ($ShortFixtureOnly) {
    "PASS_EDGE_WINDOW_SHORT_FIXTURE_CONTRACT"
} else {
    "PASS_EDGE_WINDOW_POWERSHELL_CONTRACT"
}))
exit 0
