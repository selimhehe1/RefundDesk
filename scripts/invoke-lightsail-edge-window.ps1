[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{40}$")][string] $ExpectedRevision,
    [Parameter(Mandatory = $true)][string] $IncidentEvidencePath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedIncidentEvidenceSha256,
    [Parameter(Mandatory = $true)][string] $PreflightEvidencePath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedPreflightEvidenceSha256,
    [Parameter(Mandatory = $true)][string] $PromotionEvidencePath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedPromotionEvidenceSha256,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $PromotionNonce,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedBundleSha256,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedManifestSha256,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedPromotionProvenanceSha256,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedSourceSha256,
    [Parameter(Mandatory = $true)][string] $AuthorizationPath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedAuthorizationSha256,
    [Parameter(Mandatory = $true)][string] $OperatorArchivePath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedOperatorArchiveSha256,
    [Parameter(Mandatory = $true)][string] $OperatorArchiveSidecarPath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedOperatorArchiveSidecarSha256,
    [Parameter(Mandatory = $true)][string] $OperatorManifestPath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedOperatorManifestSha256,
    [Parameter(Mandatory = $true)][string] $OperatorAttestationBundlePath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedOperatorAttestationBundleSha256,
    [Parameter(Mandatory = $true)][string] $OperatorProvenancePath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedOperatorProvenanceSha256,
    [Parameter(Mandatory = $true)][string] $GitHubTokenPath,
    [Parameter(Mandatory = $true)][string] $AwsCredentialsPath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[A-Za-z0-9_-]{1,64}$")][string] $AwsProfile,
    [Parameter(Mandatory = $true)][string] $SshIdentityPath,
    [Parameter(Mandatory = $true)][string] $SshKnownHostsPath,
    [Parameter(Mandatory = $true)][ValidatePattern("^(?:[0-9]{1,3}\.){3}[0-9]{1,3}/32$")][string] $ExpectedSshCidr,
    [Parameter(Mandatory = $true)][string] $WorkbenchCheckpointPath,
    [Parameter(Mandatory = $true)][string] $OutputDirectory,
    [Parameter()][ValidateRange(60, 300)][int] $WindowSeconds = 300,
    [Parameter()][switch] $ContractFixture,
    [Parameter()][string] $FixtureToolDirectory,
    [Parameter()][string] $FixtureFinalEvidencePath,
    [Parameter()][ValidateRange(0, 7200)][int] $FixtureClockAdvanceSeconds = 0,
    [Parameter()][ValidateRange(-7200, 7200)][int] $FixturePostMarkerWallClockOffsetSeconds = 0,
    [Parameter()][ValidateRange(0, 86400000)][long] $FixturePostMarkerMonotonicAdvanceMilliseconds = 0,
    [Parameter()][ValidateRange(0, 86400000)][long] $FixturePreRunnerStartMonotonicAdvanceMilliseconds = 0,
    [Parameter()][ValidateRange(0, 86400000)][long] $FixtureRunnerMonitorMonotonicAdvanceMilliseconds = 0,
    [Parameter()][ValidatePattern("^(?:|[0-9a-f]{64})$")][string] $FixturePostMarkerBootIdentifierSha256 = "",
    [Parameter()][ValidateSet(
        "none", "after_prepared", "after_evidence", "after_input_volume_create",
        "after_attempt_marker", "after_input_seal_before_marker", "after_operator_clock_invalidated",
        "after_remote_terminal"
    )][string] $FixtureCrashAfter = "none"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$MaximumInputBytes = 16MB
$MaximumEvidenceBytes = 256KB
$MaximumProcessOutputBytes = 2MB
$MaximumDiagnosticBytes = 32KB
$SuccessfulExecutionSeconds = 35 * 60
$FinalPostflightSeconds = 300
$RunnerStartTimeoutSeconds = 30
$RunnerLaunchReserveSeconds = 240
$MaximumJsonSafeInteger = [long] 9007199254740991
$RepositoryName = "selimhehe1/RefundDesk"
$PinnedNodePath = "C:\Program Files\nodejs\node.exe"
$PinnedNodeSha256 = "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de"
$PinnedGitPath = "C:\Program Files\Git\cmd\git.exe"
$PinnedGitSha256 = "5385ff9ae361ca41e7a31b335fc0d81f2de9c35fc62a165c5e34850d837b59cc"
$PinnedDockerPath = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
$PinnedDockerSha256 = "83541df5bb9fdba4be1b36e63f7282cc3bebf04a60b147ef95e32a0cff3b45d6"
$PinnedGhPath = "C:\Program Files\GitHub CLI\gh.exe"
$PinnedGhSha256 = "fdc88cd790510c1367ebd87f57de4d929b409d3483b6f8c6916653fc77d6621a"
$PinnedPowerShellPath = "$PSHOME\powershell.exe"
$PinnedPowerShellSha256 = "7600ffe12da441fe89d035b13801e8e91d064bc544a27b19a5cf49f6ab8b18f5"
$PinnedTaskkillPath = "$env:SystemRoot\System32\taskkill.exe"
$PinnedTaskkillSha256 = "1249717315fc8f4d2df17d5db9da0444795fdb9fb83dfb1f763c3f39282244f7"
$ExpectedDockerEndpoint = "npipe:////./pipe/docker_engine"
$ExpectedIdentitySha256 = "59686a4e392a5c279ab0d71fae083a1907ef952d03acc286c5a90288dc122f5b"
$ExpectedKnownHostsSha256 = "3d15ffcd3aaedc3505648f86c565da70679253fc51e34679c2651dcbe10eb854"
$PinnedSourcePaths = @(
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

# The extended contract harness is reachable only behind the explicit
# ContractFixture switch and a caller-supplied fixture tool directory.  It
# exercises the production orchestration path with bounded local fake
# processes; evidence created in that mode is always marked fixtureOnly.
$script:ProductionContractFixture = [bool] ($ContractFixture -and -not [string]::IsNullOrWhiteSpace($FixtureToolDirectory))
$script:FixtureToolRoot = $null
$script:FixtureToolPath = $null
$script:FixtureTerminalPath = $null
$script:GitToolSha256 = $null
$script:AttemptMarkerCommitted = $false
$script:FixtureMarkerMonotonicMilliseconds = $null
$script:FixtureRunnerStartRecheck = $false
$script:FixtureRunnerMonitoring = $false

if ($null -eq ("RefundDesk.BoundedProcessStreams" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading.Tasks;
namespace RefundDesk {
  public static class BoundedProcessStreams {
    public static async Task<byte[]> ReadAsync(Stream source, int maximum) {
      using (var output = new MemoryStream()) {
        var buffer = new byte[8192];
        while (true) {
          var count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
          if (count == 0) break;
          if (output.Length + count > maximum) throw new InvalidDataException("bounded process output exceeded");
          output.Write(buffer, 0, count);
        }
        return output.ToArray();
      }
    }
    public static async Task WriteAndCloseAsync(Stream target, byte[] value) {
      try {
        if (value != null && value.Length != 0) await target.WriteAsync(value, 0, value.Length).ConfigureAwait(false);
        await target.FlushAsync().ConfigureAwait(false);
      } finally { target.Close(); }
    }
  }
}
'@
}

if ($null -eq ("RefundDesk.WindowsOperatorClock" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace RefundDesk {
  [StructLayout(LayoutKind.Sequential)]
  public struct SystemBootEnvironmentInformation {
    public Guid BootIdentifier;
    public int FirmwareType;
    public ulong BootFlags;
  }
  public static class WindowsOperatorClock {
    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(
      int informationClass,
      ref SystemBootEnvironmentInformation information,
      int informationLength,
      out int returnLength);
    [DllImport("kernel32.dll")]
    private static extern ulong GetTickCount64();
    public static Guid ReadBootIdentifier() {
      var value = new SystemBootEnvironmentInformation();
      int returned;
      int status = NtQuerySystemInformation(
        90,
        ref value,
        Marshal.SizeOf(typeof(SystemBootEnvironmentInformation)),
        out returned);
      if (status != 0 || returned < 16 || value.BootIdentifier == Guid.Empty) {
        throw new InvalidOperationException("Windows boot identifier unavailable");
      }
      return value.BootIdentifier;
    }
    public static ulong ReadMonotonicMilliseconds() { return GetTickCount64(); }
  }
}
'@
}

function Throw-SafeError {
    param([Parameter(Mandatory = $true)][ValidatePattern("^[A-Z][A-Z0-9_]{0,63}$")][string] $Code)
    throw [InvalidOperationException]::new("REFUNDDESK_$Code")
}

function Get-UtcTimestamp {
    return [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
}

function Get-AdmissionUtcTimestamp {
    $value = Get-AdmissionUtcNow
    return $value.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
}

function Get-AdmissionUtcNow {
    $value = [DateTime]::UtcNow
    if ($script:ProductionContractFixture) {
        if ($FixtureClockAdvanceSeconds -ne 0) { $value = $value.AddSeconds($FixtureClockAdvanceSeconds) }
        if ($script:AttemptMarkerCommitted -and $FixturePostMarkerWallClockOffsetSeconds -ne 0) {
            $value = $value.AddSeconds($FixturePostMarkerWallClockOffsetSeconds)
        }
    }
    return $value
}

function Get-OperatorBootIdentifierSha256 {
    if ($script:ProductionContractFixture -and $script:AttemptMarkerCommitted -and
        -not [string]::IsNullOrWhiteSpace($FixturePostMarkerBootIdentifierSha256)) {
        return $FixturePostMarkerBootIdentifierSha256
    }
    try {
        $identifier = [RefundDesk.WindowsOperatorClock]::ReadBootIdentifier().ToString("D").ToLowerInvariant()
    }
    catch { Throw-SafeError "OPERATOR_CLOCK_INVALID" }
    if ($identifier -cnotmatch "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$") {
        Throw-SafeError "OPERATOR_CLOCK_INVALID"
    }
    return Get-TextSha256 $identifier
}

function Get-OperatorMonotonicMilliseconds {
    try {
        $raw = [RefundDesk.WindowsOperatorClock]::ReadMonotonicMilliseconds()
        if ($raw -gt [UInt64] $MaximumJsonSafeInteger) { Throw-SafeError "OPERATOR_CLOCK_INVALID" }
        $value = [long] $raw
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError "OPERATOR_CLOCK_INVALID"
    }
    if ($script:ProductionContractFixture -and $script:AttemptMarkerCommitted) {
        if ($null -ne $script:FixtureMarkerMonotonicMilliseconds) {
            $value = [long] $script:FixtureMarkerMonotonicMilliseconds
        }
        $advance = [long] $FixturePostMarkerMonotonicAdvanceMilliseconds
        if ($script:FixtureRunnerStartRecheck -or $script:FixtureRunnerMonitoring) {
            if ($advance -gt [long]::MaxValue - $FixturePreRunnerStartMonotonicAdvanceMilliseconds) {
                Throw-SafeError "OPERATOR_CLOCK_INVALID"
            }
            $advance += [long] $FixturePreRunnerStartMonotonicAdvanceMilliseconds
        }
        if ($script:FixtureRunnerMonitoring) {
            if ($advance -gt [long]::MaxValue - $FixtureRunnerMonitorMonotonicAdvanceMilliseconds) {
                Throw-SafeError "OPERATOR_CLOCK_INVALID"
            }
            $advance += [long] $FixtureRunnerMonitorMonotonicAdvanceMilliseconds
        }
        if ($value -gt $MaximumJsonSafeInteger - $advance) { Throw-SafeError "OPERATOR_CLOCK_INVALID" }
        $value += $advance
    }
    return $value
}

function Get-OperatorClockSnapshot {
    $bootBefore = Get-OperatorBootIdentifierSha256
    $monotonic = Get-OperatorMonotonicMilliseconds
    $bootAfter = Get-OperatorBootIdentifierSha256
    if ($bootBefore -cne $bootAfter) { Throw-SafeError "OPERATOR_CLOCK_INVALID" }
    return [pscustomobject]@{
        BootIdentifierSha256 = $bootBefore
        MonotonicMilliseconds = [long] $monotonic
    }
}

function Get-OperatorBudgetSnapshot {
    param(
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedBootIdentifierSha256,
        [Parameter(Mandatory = $true)][long] $DeadlineMonotonicMilliseconds
    )
    $clock = Get-OperatorClockSnapshot
    $sameBoot = [string] $clock.BootIdentifierSha256 -ceq $ExpectedBootIdentifierSha256
    $remaining = if ($sameBoot -and [long] $clock.MonotonicMilliseconds -lt $DeadlineMonotonicMilliseconds) {
        [long] ($DeadlineMonotonicMilliseconds - [long] $clock.MonotonicMilliseconds)
    }
    else { [long] 0 }
    return [pscustomobject]@{
        CurrentMonotonicMilliseconds = [long] $clock.MonotonicMilliseconds
        RemainingMilliseconds = $remaining
        SameBoot = $sameBoot
    }
}

function Set-OperatorClockInvalidated {
    param(
        [Parameter(Mandatory = $true)] $Attempt,
        [Parameter(Mandatory = $true)][string] $MarkerPath
    )
    if ($Attempt.operatorClockInvalidated -isnot [bool]) { Throw-SafeError "ATTEMPT_MARKER_INVALID" }
    if ($Attempt.operatorClockInvalidated) { return }
    if ($Attempt.state -ceq "prepared" -and $null -eq $Attempt.evidenceFile -and $null -eq $Attempt.evidenceSha256) {
        $markerParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($MarkerPath))
        foreach ($unboundName in @(
            "edge-window-candidate-$([string] $Attempt.nonce).local.json",
            "edge-window-$ExpectedRevision-$(([string] $Attempt.nonce).Substring(0, 12)).local.json"
        )) {
            $unboundPath = Join-Path $markerParent $unboundName
            if (Test-Path -LiteralPath $unboundPath) {
                try {
                    $unboundLock = Open-SensitiveLock $unboundPath "ATTEMPT_EVIDENCE_INVALID"
                    try {
                        $unboundBytes = Read-LockedStreamBytes $unboundLock.Stream $MaximumEvidenceBytes "ATTEMPT_EVIDENCE_INVALID"
                        $unboundDocument = ConvertFrom-BoundedJson $unboundBytes "ATTEMPT_EVIDENCE_INVALID" -RequireCanonical
                        if (($unboundDocument.exitCode -isnot [int] -and $unboundDocument.exitCode -isnot [long]) -or
                            [int] $unboundDocument.exitCode -notin @(0, 20, 21)) { Throw-SafeError "ATTEMPT_EVIDENCE_INVALID" }
                        Assert-EdgeTerminalIdentity $unboundDocument ([int] $unboundDocument.exitCode) ([string] $Attempt.nonce) "ATTEMPT_EVIDENCE_INVALID"
                    }
                    finally { $unboundLock.Stream.Dispose() }
                    [IO.File]::Delete($unboundPath)
                }
                catch {
                    # A substituted/unreadable unbound pathname is forensic
                    # residue, never authority.  Preserve it, but never let it
                    # suppress the monotone clock-invalidated safety latch.
                }
            }
        }
    }
    $Attempt.operatorClockInvalidated = $true
    Write-RestrictedReplace $MarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $Attempt -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
    if ($script:ProductionContractFixture -and $FixtureCrashAfter -ceq "after_operator_clock_invalidated") {
        [Environment]::Exit(99)
    }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string] $Path)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function ConvertTo-NativeArgument {
    param([AllowEmptyString()][string] $Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object Text.StringBuilder
    [void] $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $backslashes += 1; continue }
        if ($character -eq '"') {
            [void] $builder.Append(('\' * (($backslashes * 2) + 1)))
            [void] $builder.Append('"'); $backslashes = 0; continue
        }
        if ($backslashes -gt 0) { [void] $builder.Append(('\' * $backslashes)); $backslashes = 0 }
        [void] $builder.Append($character)
    }
    if ($backslashes -gt 0) { [void] $builder.Append(('\' * ($backslashes * 2))) }
    [void] $builder.Append('"')
    return $builder.ToString()
}

function ConvertTo-SortedObject {
    param([AllowNull()] $Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        [string[]] $keys = @($Value.Keys | ForEach-Object { [string] $_ })
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        foreach ($key in $keys) {
            $ordered[$key] = ConvertTo-SortedObject $Value[$key]
        }
        return $ordered
    }
    if ($Value -is [Management.Automation.PSCustomObject]) {
        $ordered = [ordered]@{}
        [string[]] $properties = @($Value.PSObject.Properties.Name)
        [Array]::Sort($properties, [StringComparer]::Ordinal)
        foreach ($property in $properties) {
            $ordered[$property] = ConvertTo-SortedObject $Value.$property
        }
        return $ordered
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
        # A PowerShell function otherwise enumerates (and therefore erases) an
        # empty array on return.  Emit the array as one pipeline object so
        # canonical JSON preserves [] rather than rewriting it to null.
        $items = @($Value | ForEach-Object { ConvertTo-SortedObject $_ })
        return ,$items
    }
    return $Value
}

function ConvertTo-CanonicalJson {
    param([Parameter(Mandatory = $true)] $Value, [switch] $Newline)
    $sorted = ConvertTo-SortedObject $Value
    $text = ConvertTo-Json -InputObject $sorted -Compress -Depth 100
    if ($Newline) { return "$text`n" }
    return $text
}

function Assert-ExactProperties {
    param([Parameter(Mandatory = $true)] $Value, [Parameter(Mandatory = $true)][string[]] $Properties, [string] $Code)
    if ($null -eq $Value) { Throw-SafeError $Code }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $expected = @($Properties | Sort-Object -CaseSensitive)
    if (($actual -join "`n") -cne ($expected -join "`n")) { Throw-SafeError $Code }
}

function Assert-FinalPostflightRequestValues {
    param([Parameter(Mandatory = $true)] $Request, [Parameter(Mandatory = $true)][string] $ExpectedNonce)
    foreach ($stringField in @("expectedRevision", "kind", "nonce", "requestBootIdSha256", "requestedAt")) {
        if ($Request.$stringField -isnot [string]) { Throw-SafeError "FINAL_POSTFLIGHT_REQUEST_INVALID" }
    }
    if (($Request.schemaVersion -isnot [int] -and $Request.schemaVersion -isnot [long]) -or
        ($Request.requestedBoottimeMilliseconds -isnot [int] -and $Request.requestedBoottimeMilliseconds -isnot [long]) -or
        [long] $Request.schemaVersion -ne 1 -or [long] $Request.requestedBoottimeMilliseconds -lt 0 -or
        $Request.kind -cne "refunddesk.edge-window-final-postflight-request" -or
        $Request.nonce -cne $ExpectedNonce -or $Request.expectedRevision -cne $ExpectedRevision -or
        $Request.requestBootIdSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        $Request.requestedAt -cnotmatch "^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") {
        Throw-SafeError "FINAL_POSTFLIGHT_REQUEST_INVALID"
    }
    try {
        [void] [DateTime]::ParseExact($Request.requestedAt, "yyyy-MM-ddTHH:mm:ssZ",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    }
    catch { Throw-SafeError "FINAL_POSTFLIGHT_REQUEST_INVALID" }
}

function Assert-NoReparsePath {
    param([string] $Path, [string] $Code)
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    $current = $root
    foreach ($component in $full.Substring($root.Length).Split(@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar), [StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $component
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Throw-SafeError $Code }
        }
    }
}

function Get-CanonicalFile {
    param([string] $Path, [string] $Code)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        Assert-NoReparsePath $full $Code
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Throw-SafeError $Code }
        return $full
    }
    catch { if ($_.Exception.Message -match "^REFUNDDESK_") { throw }; Throw-SafeError $Code }
}

function Get-CanonicalDirectory {
    param([string] $Path, [string] $Code)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        Assert-NoReparsePath $full $Code
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Throw-SafeError $Code }
        return $full
    }
    catch { if ($_.Exception.Message -match "^REFUNDDESK_") { throw }; Throw-SafeError $Code }
}

function Assert-RestrictedAcl {
    param([string] $Path, [string] $Code)
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $required = @($currentSid, "S-1-5-18", "S-1-5-32-544")
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $currentSid) { Throw-SafeError $Code }
    $item = Get-Item -LiteralPath $Path -Force
    $inheritance = if ($item.PSIsContainer) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else { [Security.AccessControl.InheritanceFlags]::None }
    $rules = @($acl.Access)
    if ($rules.Count -ne 3) { Throw-SafeError $Code }
    $seen = @()
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
            $required -notcontains $sid -or $seen -contains $sid) { Throw-SafeError $Code }
        $seen += $sid
    }
    foreach ($sid in $required) { if ($seen -notcontains $sid) { Throw-SafeError $Code } }
}

function Set-RestrictedFileAcl {
    param([string] $Path)
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($current)
    foreach ($sid in @($current, [Security.Principal.SecurityIdentifier]::new("S-1-5-18"), [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    }
    [IO.File]::SetAccessControl($Path, $acl)
}

function Set-RestrictedDirectoryAcl {
    param([string] $Path)
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($current)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($current, [Security.Principal.SecurityIdentifier]::new("S-1-5-18"), [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        ))
    }
    [IO.Directory]::SetAccessControl($Path, $acl)
}

function New-RestrictedDirectory {
    param([string] $Parent, [string] $Leaf, [string] $Code)
    if ($Leaf -notmatch "^[A-Za-z0-9._-]{1,96}$") { Throw-SafeError $Code }
    $path = [IO.Path]::GetFullPath((Join-Path $Parent $Leaf))
    if ((Test-Path -LiteralPath $path) -or [IO.Path]::GetDirectoryName($path) -cne [IO.Path]::GetFullPath($Parent).TrimEnd('\')) {
        Throw-SafeError $Code
    }
    try {
        [void] [IO.Directory]::CreateDirectory($path)
        Set-RestrictedDirectoryAcl $path
        Assert-RestrictedAcl $path $Code
        return $path
    }
    catch {
        try { if ([IO.Directory]::Exists($path)) { [IO.Directory]::Delete($path, $false) } } catch {}
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $Code
    }
}

function Write-CreateNew {
    param([string] $Path, [byte[]] $Bytes)
    $stream = $null
    $created = $false
    try {
        $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        $created = $true
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose(); $stream = $null }
        if ($created) { try { [IO.File]::Delete($Path) } catch {} }
        Throw-SafeError "CREATE_NEW_FAILED"
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    Set-RestrictedFileAcl $Path
    Assert-RestrictedAcl $Path "CREATE_NEW_ACL_INVALID"
}

function Open-AttemptLease {
    param([string] $Path, [string] $BindingSha256)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes("refunddesk-edge-window-attempt-lock:$BindingSha256`n")
    $stream = $null
    try {
        try {
            $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
            Set-RestrictedFileAcl $Path
        }
        catch [IO.IOException] {
            if ($null -ne $stream) { $stream.Dispose(); $stream = $null }
            $canonical = Get-CanonicalFile $Path "ATTEMPT_BUSY"
            Assert-RestrictedAcl $canonical "ATTEMPT_LOCK_INVALID"
            $stream = [IO.FileStream]::new($canonical, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        }
        if ($stream.Length -ne $bytes.Length) { Throw-SafeError "ATTEMPT_LOCK_INVALID" }
        $stream.Position = 0
        $actual = New-Object byte[] $bytes.Length
        if ($stream.Read($actual, 0, $actual.Length) -ne $actual.Length) { Throw-SafeError "ATTEMPT_LOCK_INVALID" }
        for ($index = 0; $index -lt $bytes.Length; $index += 1) {
            if ($actual[$index] -ne $bytes[$index]) { Throw-SafeError "ATTEMPT_LOCK_INVALID" }
        }
        if ((Get-CanonicalFile $Path "ATTEMPT_LOCK_INVALID") -cne [IO.Path]::GetFullPath($Path)) { Throw-SafeError "ATTEMPT_LOCK_INVALID" }
        Assert-RestrictedAcl $Path "ATTEMPT_LOCK_INVALID"
        return $stream
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError "ATTEMPT_BUSY"
    }
}

function Read-LockedStreamBytes {
    param([Parameter(Mandatory = $true)][IO.FileStream] $Stream, [int] $MaximumBytes, [string] $Code)
    try {
        if ($Stream.Length -le 0 -or $Stream.Length -gt $MaximumBytes) { Throw-SafeError $Code }
        $Stream.Position = 0
        $bytes = New-Object byte[] ([int] $Stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $Stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($count -le 0) { Throw-SafeError $Code }
            $offset += $count
        }
        $Stream.Position = 0
        return $bytes
    }
    catch { if ($_.Exception.Message -match "^REFUNDDESK_") { throw }; Throw-SafeError $Code }
}

function Write-RestrictedReplace {
    param([string] $Path, [byte[]] $Bytes, [string] $Code)
    $parent = Get-CanonicalDirectory ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))) $Code
    $replaceNonce = (New-Nonce).Substring(0, 12)
    $temporary = Join-Path $parent (".{0}.{1}.tmp" -f [IO.Path]::GetFileName($Path), $replaceNonce)
    $backup = Join-Path $parent (".{0}.{1}.bak" -f [IO.Path]::GetFileName($Path), $replaceNonce)
    Write-CreateNew $temporary $Bytes
    try {
        # Windows PowerShell 5/.NET Framework does not reliably select the
        # File.Replace overload when the backup argument is null.  A unique,
        # restricted backup also gives recovery-safe replace semantics.
        [IO.File]::Replace($temporary, $Path, $backup)
        Assert-RestrictedAcl $Path $Code
        $actual = [IO.File]::ReadAllBytes($Path)
        if ($actual.Length -ne $Bytes.Length) { Throw-SafeError $Code }
        for ($index = 0; $index -lt $Bytes.Length; $index += 1) {
            if ($actual[$index] -ne $Bytes[$index]) { Throw-SafeError $Code }
        }
        if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
    }
    catch {
        try { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } } catch {}
        # Preserve the backup on ambiguity; the caller must fail closed rather
        # than erase the only prior durable marker bytes.
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $Code
    }
}

function New-Nonce {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RNGCryptoServiceProvider]::new()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function New-IsolatedEnvironment {
    param([switch] $IncludeUserProfile)
    $environment = @{
        COMSPEC = "$env:SystemRoot\System32\cmd.exe"
        LC_ALL = "C"
        SYSTEMROOT = $env:SystemRoot
        TEMP = [IO.Path]::GetTempPath().TrimEnd('\')
        TMP = [IO.Path]::GetTempPath().TrimEnd('\')
        WINDIR = $env:SystemRoot
    }
    if ($IncludeUserProfile) {
        $environment.HOME = $env:USERPROFILE
        $environment.USERPROFILE = $env:USERPROFILE
        $environment.PROGRAMDATA = $env:PROGRAMDATA
    }
    else {
        $environment.HOME = [IO.Path]::GetTempPath().TrimEnd('\')
        $environment.USERPROFILE = [IO.Path]::GetTempPath().TrimEnd('\')
        $environment.PROGRAMDATA = $env:PROGRAMDATA
    }
    return $environment
}

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][Diagnostics.Process] $Process)
    if ($Process.HasExited) { return }
    $taskkill = $script:TaskkillPath
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $taskkill
    $start.Arguments = "/PID $($Process.Id) /T /F"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $killer = [Diagnostics.Process]::new()
    $killer.StartInfo = $start
    try {
        if ($killer.Start()) {
            [void] $killer.StandardOutput.ReadToEndAsync()
            [void] $killer.StandardError.ReadToEndAsync()
            [void] $killer.WaitForExit(10000)
        }
    }
    finally { $killer.Dispose() }
    if (-not $Process.HasExited) {
        try { $Process.Kill() } catch {}
    }
    [void] $Process.WaitForExit(10000)
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)][string] $Executable,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][hashtable] $Environment,
        [byte[]] $InputBytes,
        [Parameter(Mandatory = $true)][int] $TimeoutSeconds,
        [int] $MaximumStdoutBytes = $MaximumProcessOutputBytes,
        [int[]] $AllowedExitCodes = @(0)
    )
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardInput = $true
    [void] $start.EnvironmentVariables.Clear()
    foreach ($entry in $Environment.GetEnumerator()) {
        if ($entry.Key -notmatch "^[A-Za-z_][A-Za-z0-9_]{0,63}$" -or $entry.Value -isnot [string] -or $entry.Value.Contains([char] 0)) {
            Throw-SafeError "PROCESS_ENVIRONMENT_INVALID"
        }
        $start.EnvironmentVariables[[string] $entry.Key] = [string] $entry.Value
    }
    $start.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument ([string] $_) }) -join " ")
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { Throw-SafeError "PROCESS_START_FAILED" }
        $stdoutTask = [RefundDesk.BoundedProcessStreams]::ReadAsync($process.StandardOutput.BaseStream, $MaximumStdoutBytes)
        $stderrTask = [RefundDesk.BoundedProcessStreams]::ReadAsync($process.StandardError.BaseStream, $MaximumDiagnosticBytes)
        $inputTask = [RefundDesk.BoundedProcessStreams]::WriteAndCloseAsync($process.StandardInput.BaseStream, $InputBytes)
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        while (-not $process.HasExited) {
            if ($stdoutTask.IsFaulted -or $stderrTask.IsFaulted) {
                Stop-ProcessTree $process
                Throw-SafeError "PROCESS_OUTPUT_BOUNDS"
            }
            if ($inputTask.IsFaulted) {
                Stop-ProcessTree $process
                Throw-SafeError "PROCESS_INPUT_FAILED"
            }
            if ($stopwatch.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
                Stop-ProcessTree $process
                Throw-SafeError "PROCESS_TIMEOUT"
            }
            [void] $process.WaitForExit(50)
        }
        $streamTasks = [Threading.Tasks.Task[]] @($stdoutTask, $stderrTask, $inputTask)
        if (-not [Threading.Tasks.Task]::WaitAll($streamTasks, 10000)) {
            Stop-ProcessTree $process
            Throw-SafeError "PROCESS_DRAIN_TIMEOUT"
        }
        if ($stdoutTask.IsFaulted -or $stderrTask.IsFaulted) { Throw-SafeError "PROCESS_OUTPUT_BOUNDS" }
        if ($inputTask.IsFaulted) { Throw-SafeError "PROCESS_INPUT_FAILED" }
        $stdoutBytes = $stdoutTask.Result
        $stderrBytes = $stderrTask.Result
        if ($AllowedExitCodes -notcontains $process.ExitCode) { Throw-SafeError "PROCESS_EXIT_INVALID" }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdoutBytes; Stderr = $stderrBytes }
    }
    finally { $process.Dispose() }
}

function Invoke-ContractFixtureTool {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("node", "docker", "gh", "postflight")][string] $Tool,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [byte[]] $InputBytes,
        [Parameter(Mandatory = $true)][int] $TimeoutSeconds,
        [int] $MaximumStdoutBytes = $MaximumProcessOutputBytes,
        [int[]] $AllowedExitCodes = @(0)
    )
    if (-not $script:ProductionContractFixture -or [string]::IsNullOrWhiteSpace($script:FixtureToolPath) -or
        [string]::IsNullOrWhiteSpace($script:FixtureToolRoot) -or [string]::IsNullOrWhiteSpace($script:PowerShellPath)) {
        Throw-SafeError "FIXTURE_TOOL_INVALID"
    }
    $environment = New-IsolatedEnvironment
    # -InputObject is required here: piping a PowerShell array would enumerate
    # it and lose the top-level argv boundary under Windows PowerShell 5.
    $argumentJson = ConvertTo-Json -InputObject ([object[]] $Arguments) -Compress -Depth 8
    $environment.REFUNDDESK_FIXTURE_TOOL = $Tool
    $environment.REFUNDDESK_FIXTURE_ROOT = $script:FixtureToolRoot
    $environment.REFUNDDESK_FIXTURE_ARGUMENTS_BASE64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($argumentJson))
    $environment.REFUNDDESK_FIXTURE_EXPECTED_REVISION = $ExpectedRevision
    $environment.REFUNDDESK_FIXTURE_TERMINAL_PATH = $script:FixtureTerminalPath
    return Invoke-BoundedProcess $script:PowerShellPath @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $script:FixtureToolPath
    ) $environment $InputBytes $TimeoutSeconds $MaximumStdoutBytes $AllowedExitCodes
}

function Get-Utf8Text {
    param([byte[]] $Bytes, [string] $Code)
    try { return [Text.UTF8Encoding]::new($false, $true).GetString($Bytes) }
    catch { Throw-SafeError $Code }
}

function Open-InputLock {
    param([string] $Path, [string] $ExpectedSha256, [string] $Code, [long] $MaximumBytes = $MaximumInputBytes, [switch] $RequireRestrictedAcl, [switch] $NoBytes)
    $canonical = Get-CanonicalFile $Path $Code
    if ($RequireRestrictedAcl) { Assert-RestrictedAcl $canonical $Code }
    $stream = [IO.FileStream]::new($canonical, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 65536, [IO.FileOptions]::SequentialScan)
    try {
        if ($stream.Length -le 0 -or $stream.Length -gt $MaximumBytes) { Throw-SafeError $Code }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { $actualSha256 = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $algorithm.Dispose() }
        if ($actualSha256 -cne $ExpectedSha256) { Throw-SafeError $Code }
        $stream.Position = 0
        $bytes = $null
        if (-not $NoBytes) {
            $bytes = New-Object byte[] ([int] $stream.Length)
            $offset = 0
            while ($offset -lt $bytes.Length) {
                $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
                if ($count -le 0) { Throw-SafeError $Code }
                $offset += $count
            }
        }
        $stream.Position = 0
        return [pscustomobject]@{ Bytes = $bytes; Path = $canonical; Sha256 = $ExpectedSha256; Stream = $stream }
    }
    catch {
        $stream.Dispose()
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $Code
    }
}

function ConvertFrom-BoundedJson {
    param([byte[]] $Bytes, [string] $Code, [switch] $RequireCanonical)
    $text = Get-Utf8Text $Bytes $Code
    if ($text.Contains([char] 0) -or ($text.Length -gt 0 -and $text[0] -eq [char] 0xfeff)) { Throw-SafeError $Code }
    try { $value = $text | ConvertFrom-Json }
    catch { Throw-SafeError $Code }
    if ($RequireCanonical) {
        if (-not $text.EndsWith("`n") -or $text.Contains("`r") -or
            $text.Substring(0, $text.Length - 1).Contains("`n") -or
            (ConvertTo-CanonicalJson $value -Newline) -cne $text) { Throw-SafeError $Code }
    }
    return $value
}

function Assert-PinnedTool {
    param([string] $Path, [string] $Sha256, [string] $Code)
    $canonical = Get-CanonicalFile $Path $Code
    if ((Get-FileSha256 $canonical) -cne $Sha256) { Throw-SafeError $Code }
    return $canonical
}

function Invoke-Node {
    param([string[]] $Arguments, [byte[]] $InputBytes, [int[]] $AllowedExitCodes = @(0), [int] $TimeoutSeconds = 30)
    if ($script:ProductionContractFixture) {
        return Invoke-ContractFixtureTool "node" $Arguments $InputBytes $TimeoutSeconds 2MB $AllowedExitCodes
    }
    return Invoke-BoundedProcess $script:NodePath $Arguments (New-IsolatedEnvironment) $InputBytes $TimeoutSeconds 2MB $AllowedExitCodes
}

function New-GitEnvironment {
    $environment = New-IsolatedEnvironment
    $environment.GIT_CONFIG_GLOBAL = "NUL"
    $environment.GIT_CONFIG_NOSYSTEM = "1"
    $environment.GIT_NO_REPLACE_OBJECTS = "1"
    $environment.GIT_OPTIONAL_LOCKS = "0"
    return $environment
}

function Invoke-Git {
    param([string[]] $Arguments, [int[]] $AllowedExitCodes = @(0))
    if ($script:ProductionContractFixture) {
        $allExitCodes = [int[]] (0..255)
        $fixtureResult = Invoke-BoundedProcess $script:GitPath (@("--no-replace-objects") + $Arguments) (New-GitEnvironment) $null 30 1MB $allExitCodes
        if ($AllowedExitCodes -notcontains $fixtureResult.ExitCode) { Throw-SafeError "GIT_PROCESS_EXIT_INVALID" }
        return $fixtureResult
    }
    return Invoke-BoundedProcess $script:GitPath (@("--no-replace-objects") + $Arguments) (New-GitEnvironment) $null 30 1MB $AllowedExitCodes
}

function Assert-DockerIsolation {
    if ([string]::IsNullOrWhiteSpace($script:DockerConfigDirectory) -or
        [string]::IsNullOrWhiteSpace($script:DockerEndpoint)) { Throw-SafeError "DOCKER_ISOLATION_INVALID" }
    $canonical = Get-CanonicalDirectory $script:DockerConfigDirectory "DOCKER_ISOLATION_INVALID"
    if ($canonical -cne $script:DockerConfigDirectory) { Throw-SafeError "DOCKER_ISOLATION_INVALID" }
    Assert-RestrictedAcl $canonical "DOCKER_ISOLATION_INVALID"
    if (@(Get-ChildItem -LiteralPath $canonical -Force -ErrorAction Stop).Count -ne 0) {
        Throw-SafeError "DOCKER_CONFIG_NOT_EMPTY"
    }
}

function Invoke-Docker {
    param([string[]] $Arguments, [byte[]] $InputBytes, [int[]] $AllowedExitCodes = @(0), [int] $TimeoutSeconds = 60, [int] $MaximumBytes = 2MB)
    Assert-DockerIsolation
    if ($script:ProductionContractFixture) {
        $fixtureResult = Invoke-ContractFixtureTool "docker" (@("--host", $script:DockerEndpoint) + $Arguments) $InputBytes $TimeoutSeconds $MaximumBytes $AllowedExitCodes
        Assert-DockerIsolation
        return $fixtureResult
    }
    $environment = New-IsolatedEnvironment
    $environment.DOCKER_CONFIG = $script:DockerConfigDirectory
    $environment.HOME = $script:DockerConfigDirectory
    $environment.USERPROFILE = $script:DockerConfigDirectory
    $result = Invoke-BoundedProcess $script:DockerPath (@("--host", $script:DockerEndpoint) + $Arguments) $environment $InputBytes $TimeoutSeconds $MaximumBytes $AllowedExitCodes
    Assert-DockerIsolation
    return $result
}

function Invoke-Gh {
    param([string[]] $Arguments, [int] $TimeoutSeconds = 60)
    $canonical = Get-CanonicalDirectory $script:GhConfigDirectory "GH_ISOLATION_INVALID"
    Assert-RestrictedAcl $canonical "GH_ISOLATION_INVALID"
    if (@(Get-ChildItem -LiteralPath $canonical -Force -ErrorAction Stop).Count -ne 0) { Throw-SafeError "GH_CONFIG_NOT_EMPTY" }
    $environment = New-IsolatedEnvironment
    $environment.GH_CONFIG_DIR = $canonical
    $environment.HOME = $canonical
    $environment.USERPROFILE = $canonical
    if ([string]::IsNullOrWhiteSpace($script:GitHubToken)) { Throw-SafeError "GH_TOKEN_INVALID" }
    $environment.GH_TOKEN = $script:GitHubToken
    $result = if ($script:ProductionContractFixture) {
        Invoke-ContractFixtureTool "gh" $Arguments $null $TimeoutSeconds 2MB @(0)
    }
    else {
        Invoke-BoundedProcess $script:GhPath $Arguments $environment $null $TimeoutSeconds 2MB @(0)
    }
    if (@(Get-ChildItem -LiteralPath $canonical -Force -ErrorAction Stop).Count -ne 0) { Throw-SafeError "GH_CONFIG_NOT_EMPTY" }
    return $result
}

function Get-ProcessText {
    param($Result, [string] $Code)
    $text = Get-Utf8Text $Result.Stdout $Code
    if ($text.Contains([char] 0)) { Throw-SafeError $Code }
    return $text
}

function Get-TextSha256 {
    param([string] $Text)
    return Get-Sha256Hex ([Text.UTF8Encoding]::new($false).GetBytes($Text))
}

function Get-StreamSha256 {
    param([Parameter(Mandatory = $true)][IO.FileStream] $Stream, [string] $Code)
    try {
        $Stream.Position = 0
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { $sha256 = ([BitConverter]::ToString($algorithm.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant() }
        finally { $algorithm.Dispose() }
        $Stream.Position = 0
        return $sha256
    }
    catch { Throw-SafeError $Code }
}

function Get-GitBlobRecord {
    param([string] $Repository, [string] $CommitOid, [string] $RelativePath)
    $commitObject = (Get-ProcessText (Invoke-Git @("-C", $Repository, "rev-parse", "$CommitOid`:$RelativePath")) "SOURCE_INVALID").Trim()
    $indexObject = (Get-ProcessText (Invoke-Git @("-C", $Repository, "rev-parse", "`:$RelativePath")) "SOURCE_INVALID").Trim()
    if ($commitObject -notmatch "^[0-9a-f]{40}$" -or $indexObject -cne $commitObject) { Throw-SafeError "SOURCE_INVALID" }
    $commitBytes = (Invoke-Git @("-C", $Repository, "cat-file", "blob", $commitObject)).Stdout
    $indexBytes = (Invoke-Git @("-C", $Repository, "cat-file", "blob", $indexObject)).Stdout
    $commitSha256 = Get-Sha256Hex $commitBytes
    $indexSha256 = Get-Sha256Hex $indexBytes
    if ($commitBytes.Length -ne $indexBytes.Length -or $commitSha256 -cne $indexSha256) { Throw-SafeError "SOURCE_INVALID" }
    return [pscustomobject]@{
        CommitBytes = $commitBytes
        CommitObject = $commitObject
        CommitSha256 = $commitSha256
        IndexBytes = $indexBytes
        IndexObject = $indexObject
        IndexSha256 = $indexSha256
    }
}

function Open-RepositoryControlBinding {
    param([string] $Path, [string] $Code)
    $canonical = Get-CanonicalFile $Path $Code
    $stream = [IO.FileStream]::new($canonical, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 65536, [IO.FileOptions]::SequentialScan)
    try {
        if ($stream.Length -le 0 -or $stream.Length -gt 1GB) { Throw-SafeError $Code }
        return [pscustomobject]@{
            Length = $stream.Length
            Path = $canonical
            Sha256 = Get-StreamSha256 $stream $Code
            Stream = $stream
        }
    }
    catch {
        $stream.Dispose()
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $Code
    }
}

function Assert-RepositoryTrackedClean {
    param([string] $Repository, [string] $Code)
    $status = Invoke-Git @("-C", $Repository, "status", "--porcelain=v1", "--untracked-files=no")
    if ($status.Stdout.Length -ne 0 -or $status.Stderr.Length -ne 0) { Throw-SafeError $Code }
    foreach ($arguments in @(
        @("-C", $Repository, "diff", "--quiet", "HEAD", "--"),
        @("-C", $Repository, "diff", "--cached", "--quiet", "HEAD", "--")
    )) {
        $result = Invoke-Git $arguments @(0, 1)
        if ($result.ExitCode -ne 0 -or $result.Stdout.Length -ne 0 -or $result.Stderr.Length -ne 0) { Throw-SafeError $Code }
    }
}

function Get-SourceProvenance {
    param([string] $Repository)
    $head = (Get-ProcessText (Invoke-Git @("-C", $Repository, "rev-parse", "HEAD")) "SOURCE_INVALID").Trim()
    if ($head -cne $ExpectedRevision) { Throw-SafeError "SOURCE_INVALID" }
    $gitDirectory = (Get-ProcessText (Invoke-Git @("-C", $Repository, "rev-parse", "--path-format=absolute", "--git-dir")) "SOURCE_INVALID").Trim()
    $gitDirectory = Get-CanonicalDirectory $gitDirectory "SOURCE_INVALID"
    $symbolicResult = Invoke-Git @("-C", $Repository, "symbolic-ref", "--quiet", "HEAD") @(0, 1)
    if ($symbolicResult.ExitCode -ne 0) { Throw-SafeError "SOURCE_INVALID" }
    $symbolicRef = (Get-ProcessText $symbolicResult "SOURCE_INVALID").Trim()
    if ($symbolicRef -notmatch "^refs/heads/[A-Za-z0-9._/-]+$") { Throw-SafeError "SOURCE_INVALID" }
    $records = @()
    $bindings = @()
    $controlBindings = @()
    try {
        $requiredControlPaths = @(
            (Join-Path $gitDirectory "HEAD"),
            (Join-Path $gitDirectory "index"),
            (Join-Path $gitDirectory "config")
        )
        $looseRefPath = Join-Path $gitDirectory $symbolicRef
        $packedRefsPath = Join-Path $gitDirectory "packed-refs"
        if (Test-Path -LiteralPath $looseRefPath -PathType Leaf) { $requiredControlPaths += $looseRefPath }
        elseif (Test-Path -LiteralPath $packedRefsPath -PathType Leaf) { $requiredControlPaths += $packedRefsPath }
        else { Throw-SafeError "SOURCE_INVALID" }
        $alternatesPath = Join-Path $gitDirectory "objects/info/alternates"
        if (Test-Path -LiteralPath $alternatesPath) { Throw-SafeError "SOURCE_INVALID" }
        foreach ($optionalPath in @(
            $packedRefsPath,
            (Join-Path $gitDirectory "config.worktree"),
            (Join-Path $gitDirectory "shallow")
        )) {
            if ((Test-Path -LiteralPath $optionalPath -PathType Leaf) -and $requiredControlPaths -notcontains $optionalPath) {
                $requiredControlPaths += $optionalPath
            }
        }
        $packDirectory = Join-Path $gitDirectory "objects/pack"
        $packPaths = if (Test-Path -LiteralPath $packDirectory -PathType Container) {
            @(Get-ChildItem -LiteralPath $packDirectory -File -Force | Sort-Object -Property Name | ForEach-Object { $_.FullName })
        } else { @() }
        $objectsDirectory = Join-Path $gitDirectory "objects"
        $packPrefix = [IO.Path]::GetFullPath($packDirectory).TrimEnd('\') + '\'
        $infoPrefix = [IO.Path]::GetFullPath((Join-Path $objectsDirectory "info")).TrimEnd('\') + '\'
        $looseObjectPaths = if (Test-Path -LiteralPath $objectsDirectory -PathType Container) {
            @(Get-ChildItem -LiteralPath $objectsDirectory -File -Force -Recurse | Where-Object {
                -not $_.FullName.StartsWith($packPrefix, [StringComparison]::OrdinalIgnoreCase) -and
                -not $_.FullName.StartsWith($infoPrefix, [StringComparison]::OrdinalIgnoreCase)
            } | Sort-Object -Property FullName | ForEach-Object { $_.FullName })
        } else { @() }
        if ($looseObjectPaths.Count -eq 0 -and $packPaths.Count -eq 0) { Throw-SafeError "SOURCE_INVALID" }
        foreach ($controlPath in @($requiredControlPaths + $packPaths + $looseObjectPaths)) {
            $controlBindings += Open-RepositoryControlBinding $controlPath "SOURCE_INVALID"
        }
        $headLocked = (Get-ProcessText (Invoke-Git @("-C", $Repository, "rev-parse", "--verify", "HEAD")) "SOURCE_INVALID").Trim()
        if ($headLocked -cne $head) { Throw-SafeError "SOURCE_INVALID" }
        Assert-RepositoryTrackedClean $Repository "SOURCE_INVALID"
        foreach ($relative in $PinnedSourcePaths) {
            $path = Get-CanonicalFile (Join-Path $Repository $relative) "SOURCE_INVALID"
            [void] (Invoke-Git @("-C", $Repository, "ls-files", "--error-unmatch", "--", $relative))
            $stream = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 65536, [IO.FileOptions]::SequentialScan)
            if ($stream.Length -le 0 -or $stream.Length -gt 1MB) { $stream.Dispose(); Throw-SafeError "SOURCE_INVALID" }
            $worktreeSha256 = Get-StreamSha256 $stream "SOURCE_INVALID"
            $blob = Get-GitBlobRecord $Repository $head $relative
            if ($stream.Length -ne $blob.CommitBytes.Length -or $worktreeSha256 -cne $blob.CommitSha256) {
                $stream.Dispose()
                Throw-SafeError "SOURCE_INVALID"
            }
            $record = [ordered]@{
                headSha256 = $blob.CommitSha256
                indexSha256 = $blob.IndexSha256
                path = $relative
                sourceSha256 = $worktreeSha256
            }
            $records += $record
            $bindings += [pscustomobject]@{
                CommitObject = $blob.CommitObject
                Path = $path
                Record = $record
                RelativePath = $relative
                Stream = $stream
            }
        }
        $headAfter = (Get-ProcessText (Invoke-Git @("-C", $Repository, "rev-parse", "HEAD")) "SOURCE_INVALID").Trim()
        if ($headAfter -cne $head) { Throw-SafeError "SOURCE_INVALID" }
        Assert-RepositoryTrackedClean $Repository "SOURCE_INVALID"
    }
    catch {
        foreach ($binding in $bindings) { try { $binding.Stream.Dispose() } catch {} }
        foreach ($binding in $controlBindings) { try { $binding.Stream.Dispose() } catch {} }
        throw
    }
    $indexProjection = @($records | ForEach-Object { [ordered]@{ indexSha256 = $_.indexSha256; path = $_.path } })
    return [ordered]@{
        bindings = $bindings
        controlBindings = $controlBindings
        gitDirectory = $gitDirectory
        looseRefPath = $looseRefPath
        looseRefPresent = [bool] (Test-Path -LiteralPath $looseRefPath -PathType Leaf)
        looseObjectPaths = @($looseObjectPaths)
        packPaths = @($packPaths)
        records = $records
        repositoryHead = $head
        repositoryIndexSha256 = Get-TextSha256 (ConvertTo-CanonicalJson $indexProjection)
        sourceBundleSha256 = Get-TextSha256 (ConvertTo-CanonicalJson $records)
        symbolicRef = $symbolicRef
    }
}

function Assert-SourceProvenance {
    param([string] $Repository, $Source)
    Assert-RepositoryTrackedClean $Repository "SOURCE_CHANGED"
    foreach ($control in @($Source.controlBindings)) {
        $current = Get-CanonicalFile $control.Path "SOURCE_CHANGED"
        if ($current -cne $control.Path -or $control.Stream.Length -ne $control.Length -or
            (Get-StreamSha256 $control.Stream "SOURCE_CHANGED") -cne $control.Sha256 -or
            (Get-FileSha256 $current) -cne $control.Sha256) { Throw-SafeError "SOURCE_CHANGED" }
    }
    $currentPackPaths = if (Test-Path -LiteralPath (Join-Path $Source.gitDirectory "objects/pack") -PathType Container) {
        @(Get-ChildItem -LiteralPath (Join-Path $Source.gitDirectory "objects/pack") -File -Force | Sort-Object -Property Name | ForEach-Object { $_.FullName })
    } else { @() }
    if ((ConvertTo-CanonicalJson @($currentPackPaths)) -cne (ConvertTo-CanonicalJson @($Source.packPaths))) { Throw-SafeError "SOURCE_CHANGED" }
    if (Test-Path -LiteralPath (Join-Path $Source.gitDirectory "objects/info/alternates")) { Throw-SafeError "SOURCE_CHANGED" }
    $objectsDirectory = Join-Path $Source.gitDirectory "objects"
    $packPrefix = [IO.Path]::GetFullPath((Join-Path $objectsDirectory "pack")).TrimEnd('\') + '\'
    $infoPrefix = [IO.Path]::GetFullPath((Join-Path $objectsDirectory "info")).TrimEnd('\') + '\'
    $currentLooseObjectPaths = if (Test-Path -LiteralPath $objectsDirectory -PathType Container) {
        @(Get-ChildItem -LiteralPath $objectsDirectory -File -Force -Recurse | Where-Object {
            -not $_.FullName.StartsWith($packPrefix, [StringComparison]::OrdinalIgnoreCase) -and
            -not $_.FullName.StartsWith($infoPrefix, [StringComparison]::OrdinalIgnoreCase)
        } | Sort-Object -Property FullName | ForEach-Object { $_.FullName })
    } else { @() }
    if ((ConvertTo-CanonicalJson @($currentLooseObjectPaths)) -cne (ConvertTo-CanonicalJson @($Source.looseObjectPaths))) {
        Throw-SafeError "SOURCE_CHANGED"
    }
    if ([bool] (Test-Path -LiteralPath $Source.looseRefPath -PathType Leaf) -ne [bool] $Source.looseRefPresent) { Throw-SafeError "SOURCE_CHANGED" }
    $headBefore = (Get-ProcessText (Invoke-Git @("-C", $Repository, "rev-parse", "HEAD")) "SOURCE_CHANGED").Trim()
    if ($headBefore -cne $Source.repositoryHead -or $headBefore -cne $ExpectedRevision) { Throw-SafeError "SOURCE_CHANGED" }
    foreach ($binding in @($Source.bindings)) {
        $currentPath = Get-CanonicalFile (Join-Path $Repository $binding.RelativePath) "SOURCE_CHANGED"
        if ($currentPath -cne $binding.Path) { Throw-SafeError "SOURCE_CHANGED" }
        $worktreeSha256 = Get-StreamSha256 $binding.Stream "SOURCE_CHANGED"
        if ($worktreeSha256 -cne $binding.Record.sourceSha256 -or (Get-FileSha256 $currentPath) -cne $worktreeSha256) {
            Throw-SafeError "SOURCE_CHANGED"
        }
        try { $blob = Get-GitBlobRecord $Repository $Source.repositoryHead $binding.RelativePath }
        catch { Throw-SafeError "SOURCE_CHANGED" }
        if ($blob.CommitObject -cne $binding.CommitObject -or
            $blob.CommitSha256 -cne $binding.Record.headSha256 -or
            $blob.IndexSha256 -cne $binding.Record.indexSha256 -or
            $blob.CommitSha256 -cne $worktreeSha256) { Throw-SafeError "SOURCE_CHANGED" }
    }
    $headAfter = (Get-ProcessText (Invoke-Git @("-C", $Repository, "rev-parse", "HEAD")) "SOURCE_CHANGED").Trim()
    if ($headAfter -cne $headBefore) { Throw-SafeError "SOURCE_CHANGED" }
    Assert-RepositoryTrackedClean $Repository "SOURCE_CHANGED"
}

function New-VolumeFile {
    param([string] $Volume, [string] $ImageId, [string] $RelativePath, [byte[]] $Bytes)
    if ($RelativePath -notmatch "^[A-Za-z0-9._/-]{1,200}$" -or $RelativePath.Contains("..")) { Throw-SafeError "VOLUME_PATH_INVALID" }
    $program = 'import os,sys;p="/control/"+sys.argv[1];os.makedirs(os.path.dirname(p),mode=0o700,exist_ok=True);d=sys.stdin.buffer.read();f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(f,d);os.fsync(f);os.close(f);q=os.open(os.path.dirname(p),os.O_RDONLY);os.fsync(q);os.close(q)'
    [void] (Invoke-Docker @(
        "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "10001:10001",
        "--mount", "type=volume,source=$Volume,target=/control",
        "--entrypoint", "/usr/bin/python3", $ImageId, "-c", $program, $RelativePath
    ) $Bytes @(0) 30 4096)
}

function New-SealedInputVolume {
    param(
        [Parameter(Mandatory = $true)][string] $InputVolume,
        [Parameter(Mandatory = $true)][string] $ImageId,
        [Parameter(Mandatory = $true)][string] $Nonce,
        [Parameter(Mandatory = $true)][Collections.IDictionary] $Files
    )
    $expectedNames = @("aws-config", "control-$Nonce.json", "ssh-config", "transport-$Nonce.json") | Sort-Object -CaseSensitive
    $actualNames = @($Files.Keys | ForEach-Object { [string] $_ } | Sort-Object -CaseSensitive)
    if (($actualNames -join "`n") -cne ($expectedNames -join "`n")) { Throw-SafeError "IMMUTABLE_INPUT_INVALID" }
    $payload = [ordered]@{}
    foreach ($name in $expectedNames) {
        if ($Files[$name] -isnot [byte[]] -or $Files[$name].Length -le 0 -or $Files[$name].Length -gt 1MB) {
            Throw-SafeError "IMMUTABLE_INPUT_INVALID"
        }
        $payload[$name] = [Convert]::ToBase64String([byte[]] $Files[$name])
    }
    $payloadBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $payload -Newline))
    $program = 'import base64,json,os,stat,sys;marker="REFUNDDESK_IMMUTABLE_INPUT_BUNDLE_V1";root="/input";expected=["aws-config","control-"+sys.argv[1]+".json","ssh-config","transport-"+sys.argv[1]+".json"];doc=json.load(sys.stdin);(set(doc)==set(expected) and len(doc)==len(expected) and not os.listdir(root)) or sys.exit(64);files=[]
for name in sorted(expected):
 data=base64.b64decode(doc[name],validate=True);p=os.path.join(root,name);fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400);offset=0
 while offset<len(data): offset+=os.write(fd,data[offset:])
 os.fsync(fd);os.fchmod(fd,0o444);os.fchown(fd,0,0);os.close(fd);files.append(p)
os.chown(root,0,0);os.chmod(root,0o555);d=os.open(root,os.O_RDONLY);os.fsync(d);os.close(d)'
    [void] (Invoke-Docker @(
        "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "0:0",
        "--mount", "type=volume,source=$InputVolume,target=/input",
        "--entrypoint", "/usr/bin/python3", $ImageId, "-c", $program, $Nonce
    ) $payloadBytes @(0) 30 4096)
}

function Assert-SealedInputVolume {
    param(
        [Parameter(Mandatory = $true)][string] $InputVolume,
        [Parameter(Mandatory = $true)][string] $ImageId,
        [Parameter(Mandatory = $true)][string] $Nonce,
        [Parameter(Mandatory = $true)] $ExpectedDigests
    )
    Assert-ExactProperties $ExpectedDigests @("awsConfigSha256", "controlSha256", "sshConfigSha256", "transportSha256") "IMMUTABLE_INPUT_INVALID"
    foreach ($property in $ExpectedDigests.PSObject.Properties) {
        if ($property.Value -isnot [string] -or [string] $property.Value -cnotmatch "^[0-9a-f]{64}$") {
            Throw-SafeError "IMMUTABLE_INPUT_INVALID"
        }
    }
    $expected = [ordered]@{
        "aws-config" = [string] $ExpectedDigests.awsConfigSha256
        "control-$Nonce.json" = [string] $ExpectedDigests.controlSha256
        "ssh-config" = [string] $ExpectedDigests.sshConfigSha256
        "transport-$Nonce.json" = [string] $ExpectedDigests.transportSha256
    }
    $expectedBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $expected -Newline))
    $program = 'import hashlib,json,os,stat,sys;marker="REFUNDDESK_IMMUTABLE_INPUT_ASSERT_V1";root="/input";expected=json.load(sys.stdin);s=os.lstat(root);(stat.S_ISDIR(s.st_mode) and s.st_nlink==2 and s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o555 and sorted(os.listdir(root))==sorted(expected)) or sys.exit(64)
for name,digest in expected.items():
 p=os.path.join(root,name);s=os.lstat(p);(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o444 and hashlib.sha256(open(p,"rb").read()).hexdigest()==digest) or sys.exit(65)'
    [void] (Invoke-Docker @(
        "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "10001:10001",
        "--mount", "type=volume,source=$InputVolume,target=/input,readonly",
        "--entrypoint", "/usr/bin/python3", $ImageId, "-c", $program
    ) $expectedBytes @(0) 30 4096)
}

function Get-VolumeFile {
    param([string] $Volume, [string] $ImageId, [string] $RelativePath)
    $program = 'import os,sys;p="/control/"+sys.argv[1];sys.exit(3) if not os.path.isfile(p) else None;sys.stdout.buffer.write(open(p,"rb").read())'
    $result = Invoke-Docker @(
        "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "10001:10001",
        "--mount", "type=volume,source=$Volume,target=/control,readonly",
        "--entrypoint", "/usr/bin/python3", $ImageId, "-c", $program, $RelativePath
    ) $null @(0, 3) 30 $MaximumEvidenceBytes
    if ($result.ExitCode -eq 3) { return $null }
    return $result.Stdout
}

function Open-SensitiveLock {
    param([string] $Path, [string] $Code)
    $canonical = Get-CanonicalFile $Path $Code
    Assert-RestrictedAcl $canonical $Code
    try {
        $stream = [IO.FileStream]::new($canonical, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        return [pscustomobject]@{ Path = $canonical; Stream = $stream }
    }
    catch { Throw-SafeError $Code }
}

function Read-AttemptMarkerDiscovery {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedBindingSha256,
        [Parameter(Mandatory = $true)] $ExpectedInputs
    )
    $attemptLock = Open-SensitiveLock $Path "ATTEMPT_MARKER_INVALID"
    try { $bytes = Read-LockedStreamBytes $attemptLock.Stream 32768 "ATTEMPT_MARKER_INVALID" }
    finally { $attemptLock.Stream.Dispose() }
    $attempt = ConvertFrom-BoundedJson $bytes "ATTEMPT_MARKER_INVALID" -RequireCanonical
    Assert-ExactProperties $attempt @(
        "bindingSha256", "completedAt", "containerName", "evidenceFile", "evidenceSha256",
        "imageCreatedByAttempt", "imageId", "imageLoadAttempted", "imagePreexisting", "immutableInputs", "inputVolume", "inputs", "kind",
        "localCleanupComplete", "nonce", "operatorBootIdentifierSha256", "operatorClockInvalidated",
        "operatorDeadlineMonotonicMilliseconds", "operatorStartedMonotonicMilliseconds", "schemaVersion", "startedAt", "state", "volume"
    ) "ATTEMPT_MARKER_INVALID"
    Assert-ExactProperties $attempt.immutableInputs @("awsConfigSha256", "controlSha256", "sshConfigSha256", "transportSha256") "ATTEMPT_MARKER_INVALID"
    $immutableDigestValues = @(
        $attempt.immutableInputs.awsConfigSha256,
        $attempt.immutableInputs.controlSha256,
        $attempt.immutableInputs.sshConfigSha256,
        $attempt.immutableInputs.transportSha256
    )
    $immutableInputsCommitted = @($immutableDigestValues | Where-Object { $_ -is [string] -and $_ -cmatch "^[0-9a-f]{64}$" }).Count -eq 4
    $immutableInputsEmpty = @($immutableDigestValues | Where-Object { $null -eq $_ }).Count -eq 4
    $operatorStartedIsInteger = $attempt.operatorStartedMonotonicMilliseconds -is [int] -or $attempt.operatorStartedMonotonicMilliseconds -is [long]
    $operatorDeadlineIsInteger = $attempt.operatorDeadlineMonotonicMilliseconds -is [int] -or $attempt.operatorDeadlineMonotonicMilliseconds -is [long]
    if (($attempt.schemaVersion -isnot [int] -and $attempt.schemaVersion -isnot [long]) -or
        [long] $attempt.schemaVersion -ne 1 -or $attempt.bindingSha256 -isnot [string] -or
        $attempt.bindingSha256 -cne $ExpectedBindingSha256 -or $attempt.kind -isnot [string] -or
        $attempt.kind -cne "refunddesk.edge-window-local-attempt" -or
        (ConvertTo-CanonicalJson $attempt.inputs) -cne (ConvertTo-CanonicalJson $ExpectedInputs) -or
        $attempt.startedAt -isnot [string] -or $attempt.startedAt -cnotmatch "^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" -or
        $attempt.nonce -isnot [string] -or $attempt.nonce -cnotmatch "^[0-9a-f]{64}$" -or
        $attempt.imageId -isnot [string] -or $attempt.imageId -cnotmatch "^sha256:[0-9a-f]{64}$" -or
        $attempt.volume -isnot [string] -or $attempt.volume -cne ("refunddesk-edge-window-{0}" -f ([string] $attempt.nonce).Substring(0, 12)) -or
        $attempt.inputVolume -isnot [string] -or $attempt.inputVolume -cne ("refunddesk-edge-input-{0}" -f ([string] $attempt.nonce).Substring(0, 12)) -or
        $attempt.containerName -isnot [string] -or $attempt.containerName -cne ("refunddesk-edge-window-{0}" -f ([string] $attempt.nonce).Substring(0, 12)) -or
        $attempt.imageCreatedByAttempt -isnot [bool] -or $attempt.imageLoadAttempted -isnot [bool] -or
        ($null -ne $attempt.imagePreexisting -and $attempt.imagePreexisting -isnot [bool]) -or
        $attempt.localCleanupComplete -isnot [bool] -or (-not $immutableInputsCommitted -and -not $immutableInputsEmpty) -or
        $attempt.operatorBootIdentifierSha256 -isnot [string] -or
        $attempt.operatorBootIdentifierSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        $attempt.operatorClockInvalidated -isnot [bool] -or
        -not $operatorStartedIsInteger -or [long] $attempt.operatorStartedMonotonicMilliseconds -lt 0 -or
        -not $operatorDeadlineIsInteger -or [long] $attempt.operatorDeadlineMonotonicMilliseconds -lt 0 -or
        [long] $attempt.operatorStartedMonotonicMilliseconds -gt ($MaximumJsonSafeInteger - $SuccessfulExecutionSeconds * 1000) -or
        [long] $attempt.operatorDeadlineMonotonicMilliseconds -gt $MaximumJsonSafeInteger -or
        [long] $attempt.operatorDeadlineMonotonicMilliseconds -ne
            ([long] $attempt.operatorStartedMonotonicMilliseconds + $SuccessfulExecutionSeconds * 1000) -or
        ($attempt.operatorClockInvalidated -and $attempt.state -notin @("prepared", "cleanup_complete")) -or
        ($attempt.state -ne "prepared" -and -not $immutableInputsCommitted) -or
        $attempt.state -isnot [string] -or
        $attempt.state -notin @("prepared", "finalizing", "cleanup_required", "cleanup_complete", "complete")) {
        Throw-SafeError "ATTEMPT_MARKER_INVALID"
    }
    try {
        $startedAtValue = [DateTime]::ParseExact(
            [string] $attempt.startedAt,
            "yyyy-MM-ddTHH:mm:ssZ",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        )
    }
    catch { Throw-SafeError "ATTEMPT_MARKER_INVALID" }
    if ($startedAtValue.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture) -cne [string] $attempt.startedAt) {
        Throw-SafeError "ATTEMPT_MARKER_INVALID"
    }
    return [pscustomobject]@{
        Document = $attempt
        Sha256 = Get-Sha256Hex $bytes
        StartedAt = [string] $attempt.startedAt
        OperatorBootIdentifierSha256 = [string] $attempt.operatorBootIdentifierSha256
        OperatorDeadlineMonotonicMilliseconds = [long] $attempt.operatorDeadlineMonotonicMilliseconds
        OperatorStartedMonotonicMilliseconds = [long] $attempt.operatorStartedMonotonicMilliseconds
    }
}

function Assert-AttemptAdmissionWindow {
    param(
        [Parameter(Mandatory = $true)][string] $StartedAt,
        [Parameter(Mandatory = $true)][DateTime] $PostflightValidUntil,
        [Parameter(Mandatory = $true)][DateTime] $IncidentCapturedAt,
        [Parameter(Mandatory = $true)][DateTime] $IncidentValidUntil,
        [Parameter(Mandatory = $true)][DateTime] $AuthorizationValidFrom,
        [Parameter(Mandatory = $true)][DateTime] $AuthorizationValidUntil
    )
    try {
        $startedAtValue = [DateTime]::ParseExact(
            $StartedAt,
            "yyyy-MM-ddTHH:mm:ssZ",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        )
    }
    catch { Throw-SafeError "ATTEMPT_MARKER_INVALID" }
    $attemptDeadlineValue = $startedAtValue.AddSeconds($SuccessfulExecutionSeconds)
    if ($IncidentCapturedAt -gt $startedAtValue) { Throw-SafeError "INCIDENT_POSTFLIGHT_CHRONOLOGY_INVALID" }
    $postflightRemaining = [int] [Math]::Floor(($PostflightValidUntil - $startedAtValue).TotalSeconds)
    $incidentRemaining = [int] [Math]::Floor(($IncidentValidUntil - $startedAtValue).TotalSeconds)
    if ($postflightRemaining -lt 720 -or $postflightRemaining -gt 900) { Throw-SafeError "PREFLIGHT_FRESHNESS_INVALID" }
    if ($incidentRemaining -lt 720 -or $incidentRemaining -gt 900) { Throw-SafeError "INCIDENT_FRESHNESS_INVALID" }
    if ($AuthorizationValidFrom -gt $startedAtValue -or $AuthorizationValidUntil -lt $attemptDeadlineValue) {
        Throw-SafeError "AUTHORIZATION_WINDOW_INVALID"
    }
    return [pscustomobject]@{
        Deadline = $attemptDeadlineValue
        IncidentRemaining = $incidentRemaining
        PostflightRemaining = $postflightRemaining
        StartedAt = $startedAtValue
    }
}

function Assert-SensitiveLockUnchanged {
    param($Binding, [int64] $MaximumBytes, [string] $Code)
    if ($null -eq $Binding -or $null -eq $Binding.Stream -or
        (Get-CanonicalFile $Binding.Path $Code) -cne $Binding.Path) { Throw-SafeError $Code }
    Assert-RestrictedAcl $Binding.Path $Code
    if ($Binding.Stream.Length -le 0 -or $Binding.Stream.Length -gt $MaximumBytes) { Throw-SafeError $Code }
    try { $Binding.Stream.Position = 0 } catch { Throw-SafeError $Code }
}

function Assert-AllSensitiveLocks {
    Assert-SensitiveLockUnchanged $script:CredentialsLock 65536 "AWS_CREDENTIALS_CHANGED"
    Assert-SensitiveLockUnchanged $script:GitHubTokenLock 512 "GH_TOKEN_CHANGED"
    Assert-SensitiveLockUnchanged $script:IdentityLock 65536 "SSH_IDENTITY_CHANGED"
    Assert-SensitiveLockUnchanged $script:KnownHostsLock 65536 "SSH_KNOWN_HOSTS_CHANGED"
}

function Assert-ValidatorPass {
    param($Result, [string] $ExpectedCode, [string] $Code)
    $value = ConvertFrom-BoundedJson $Result.Stdout $Code
    Assert-ExactProperties $value @("code", "result") $Code
    if ($value.code -cne $ExpectedCode -or $value.result -cne "PASS") { Throw-SafeError $Code }
}

function Assert-EdgeTerminalIdentity {
    param($Evidence, [int] $ExpectedExitCode, [string] $ExpectedNonce, [string] $Code)
    if ($ExpectedExitCode -notin @(0, 20, 21) -or [int] $Evidence.exitCode -ne $ExpectedExitCode -or
        [string] $Evidence.nonce -cne $ExpectedNonce -or [string] $Evidence.expectedRevision -cne $ExpectedRevision) {
        Throw-SafeError $Code
    }
    if (($ExpectedExitCode -eq 0 -and ($Evidence.result -cne "PASS" -or $Evidence.code -cne "PASS_EDGE_WINDOW_RECONTAINED")) -or
        ($ExpectedExitCode -eq 20 -and $Evidence.result -cne "FAIL") -or
        ($ExpectedExitCode -eq 21 -and $Evidence.result -cne "INCOMPLETE")) {
        Throw-SafeError $Code
    }
}

function Test-EdgeTerminalIsSafelyContained {
    param($Evidence)
    try {
        # A process can die after an external effect but before its mutation
        # counter/fact merge.  Local cleanup must therefore require positive
        # provider/host restoration evidence for every terminal artifact; a
        # zero counter is never proof that the effect did not happen.
        $firewallSafe = ($Evidence.firewall.finalClosed -eq $true -and
            $Evidence.firewall.closeAmbiguous -eq $false -and $Evidence.containment.awsIngressClosed -eq $true)
        $originSafe = ($Evidence.containment.originHeaderRemoved -eq $true -and
            $Evidence.containment.tokenRemoved -eq $true -and $Evidence.origin.headerRemoved -eq $true -and
            $Evidence.origin.tokenFileRemoved -eq $true)
        $watchdogSafe = ($Evidence.containment.watchdogDisarmed -eq $true -and
            $Evidence.watchdog.disarmed -eq $true)
        $financialSafe = ($Evidence.counts.unchanged -eq $true -and $Evidence.counts.quiescent -eq $true -and
            $Evidence.database.stable -eq $true -and $Evidence.database.quiescent -eq $true)
        return (
            $firewallSafe -and $originSafe -and $watchdogSafe -and $financialSafe -and
            $Evidence.containment.caddyStopped -eq $true -and $Evidence.containment.workerStopped -eq $true -and
            $Evidence.containment.maintenanceStopped -eq $true -and $Evidence.containment.publicListenersClosed -eq $true -and
            $Evidence.containment.finalPostflightPass -eq $true -and $Evidence.containment.finalPostflightContained -eq $true -and
            $Evidence.containment.financialStable -eq $true -and $Evidence.containment.financialQuiescent -eq $true -and
            $Evidence.containment.liveDisabled -eq $true
        )
    }
    catch { return $false }
}

function Save-ValidatedEdgeTerminalEvidence {
    param(
        [byte[]] $Bytes,
        [int] $ProcessExitCode,
        [string] $Nonce,
        [string] $Repository,
        [string] $OutputDirectory,
        [string] $Code,
        [AllowNull()][scriptblock] $BeforePublish = $null
    )
    $document = ConvertFrom-BoundedJson $Bytes $Code -RequireCanonical
    Assert-EdgeTerminalIdentity $document $ProcessExitCode $Nonce $Code
    $candidatePath = Join-Path $OutputDirectory "edge-window-candidate-$Nonce.local.json"
    $evidenceName = "edge-window-$ExpectedRevision-$($Nonce.Substring(0, 12)).local.json"
    $evidencePath = Join-Path $OutputDirectory $evidenceName
    if (Test-Path -LiteralPath $candidatePath) {
        $candidateLock = Open-SensitiveLock $candidatePath $Code
        try {
            $existingBytes = Read-LockedStreamBytes $candidateLock.Stream $MaximumEvidenceBytes $Code
            if ((Get-Sha256Hex $existingBytes) -cne (Get-Sha256Hex $Bytes)) { Throw-SafeError $Code }
        }
        finally { $candidateLock.Stream.Dispose() }
    }
    else { Write-CreateNew $candidatePath $Bytes }
    $validationArguments = @(
        (Join-Path $Repository "scripts/validate-lightsail-edge-window.mjs"),
        $candidatePath, (Join-Path $Repository "docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json"),
        $Nonce, $ExpectedRevision, ([string] $ProcessExitCode),
        [string] $document.startedAt, [string] $document.completedAt
    )
    if ($script:ProductionContractFixture) { $validationArguments += "fixture" }
    $validation = Invoke-Node $validationArguments $null @(0) 30
    if ((Get-ProcessText $validation $Code).Trim() -cne "PASS_EDGE_WINDOW_RECONTAINED") { Throw-SafeError $Code }
    if ($null -ne $BeforePublish) {
        try { & $BeforePublish }
        catch {
            if (Test-Path -LiteralPath $candidatePath) { [IO.File]::Delete($candidatePath) }
            throw
        }
    }
    if (Test-Path -LiteralPath $evidencePath) {
        $existingLock = Open-SensitiveLock $evidencePath $Code
        try {
            $existingBytes = Read-LockedStreamBytes $existingLock.Stream $MaximumEvidenceBytes $Code
            if ((Get-Sha256Hex $existingBytes) -cne (Get-Sha256Hex $Bytes)) { Throw-SafeError $Code }
        }
        finally { $existingLock.Stream.Dispose() }
        [IO.File]::Delete($candidatePath)
    }
    else { [IO.File]::Move($candidatePath, $evidencePath) }
    Assert-RestrictedAcl $evidencePath $Code
    return [pscustomobject]@{
        Document = $document
        ExitCode = $ProcessExitCode
        Name = $evidenceName
        Path = $evidencePath
        Sha256 = Get-FileSha256 $evidencePath
    }
}

function Get-DockerContainerState {
    param([string] $Name)
    $result = Invoke-Docker @("container", "inspect", "--format", "{{json .State}}", $Name) $null @(0, 1) 30 65536
    if ($result.ExitCode -eq 1) { return $null }
    return (Get-ProcessText $result "CONTAINER_STATE_INVALID").Trim() | ConvertFrom-Json
}

function Assert-OfficialFinalPostflightBytes {
    param([byte[]] $Bytes, [string] $Repository, [string] $ExpectedNonce)
    # The incident-admission projection and the complete ADR 0034 validator
    # must consume one immutable outer capture.  Reconstruct the canonical
    # embedded remote document only when its digest proves it is exactly the
    # observer byte sequence recorded by that outer capture.
    $document = ConvertFrom-BoundedJson $Bytes "FINAL_POSTFLIGHT_INVALID"
    $incidentArguments = @(
        (Join-Path $Repository "scripts/validate-lightsail-incident-admission.mjs"),
        "--kind", "postflight", "--expected-revision", $ExpectedRevision, "--now", (Get-UtcTimestamp)
    )
    if ($script:ProductionContractFixture) { $incidentArguments += @("--fixture-only", "true") }
    $incidentValidation = Invoke-Node $incidentArguments $Bytes @(0, 1) 30
    if ($incidentValidation.ExitCode -ne 0 -or $incidentValidation.Stderr.Length -ne 0) {
        Throw-SafeError "FINAL_POSTFLIGHT_INVALID"
    }
    Assert-ValidatorPass $incidentValidation "PASS_POSTFLIGHT_VALID" "FINAL_POSTFLIGHT_INVALID"

    if ($null -eq $document.remote -or $null -eq $document.provenance -or
        $document.provenance.remoteDocumentSha256 -isnot [string] -or
        [string] $document.provenance.remoteDocumentSha256 -cnotmatch "^[0-9a-f]{64}$") {
        Throw-SafeError "FINAL_POSTFLIGHT_INVALID"
    }
    # The official validator compares derived objects using the observer's
    # stable JSON property order.  Preserve that order from the locked outer
    # capture; sorting keys would create different bytes and could never match
    # the observer digest recorded by invoke-lightsail-postflight.ps1.
    $remoteText = (ConvertTo-Json -InputObject $document.remote -Compress -Depth 100) + "`n"
    $remoteBytes = [Text.UTF8Encoding]::new($false).GetBytes($remoteText)
    if ((Get-Sha256Hex $remoteBytes) -cne [string] $document.provenance.remoteDocumentSha256) {
        Throw-SafeError "FINAL_POSTFLIGHT_REMOTE_BYTES_INVALID"
    }
    if ($document.remote.nonce -isnot [string] -or [string] $document.remote.nonce -cnotmatch "^[0-9a-f]{64}$" -or
        [string] $document.remote.nonce -cne $ExpectedNonce -or
        ($document.remote.exitCode -isnot [int] -and $document.remote.exitCode -isnot [long]) -or
        [long] $document.remote.exitCode -ne 0 -or $document.remote.startedAt -isnot [string] -or
        $document.remote.completedAt -isnot [string] -or [string]::IsNullOrWhiteSpace($script:GitToolSha256)) {
        Throw-SafeError "FINAL_POSTFLIGHT_INVALID"
    }
    $officialArguments = @(
        (Join-Path $Repository "scripts/validate-lightsail-postflight.mjs"),
        "--expected-nonce", [string] $document.remote.nonce,
        "--process-exit-code", "0",
        "--not-before", [string] $document.remote.startedAt,
        "--not-after", [string] $document.remote.completedAt,
        "--repository", $Repository,
        "--git-executable", $script:GitPath,
        "--expected-git-sha256", $script:GitToolSha256
    )
    if ($script:ProductionContractFixture) { $officialArguments += "--fixture-only" }
    $officialValidation = Invoke-Node $officialArguments $remoteBytes @(0, 1) 30
    if ($officialValidation.ExitCode -ne 0 -or $officialValidation.Stderr.Length -ne 0 -or
        $officialValidation.Stdout.Length -le 0) {
        Throw-SafeError "FINAL_POSTFLIGHT_INVALID"
    }
    $official = ConvertFrom-BoundedJson $officialValidation.Stdout "FINAL_POSTFLIGHT_INVALID"
    Assert-ExactProperties $official @(
        "kind", "posture", "provenance", "redaction", "remote", "result", "schemaVersion"
    ) "FINAL_POSTFLIGHT_INVALID"
    Assert-ExactProperties $official.provenance @(
        "observer", "repositoryHead", "revisionComposeVerified", "schema", "validator", "wrapper"
    ) "FINAL_POSTFLIGHT_INVALID"
    Assert-ExactProperties $official.redaction @("arbitraryPathPresent", "rawSecretPresent", "stderrPresent") "FINAL_POSTFLIGHT_INVALID"
    $officialRemoteBytes = [Text.UTF8Encoding]::new($false).GetBytes(
        (ConvertTo-Json -InputObject $official.remote -Compress -Depth 100) + "`n"
    )
    if (($official.schemaVersion -isnot [int] -and $official.schemaVersion -isnot [long]) -or
        [long] $official.schemaVersion -ne 1 -or
        $official.kind -cne "refunddesk.lightsail.host-postflight.validation" -or
        $official.result -cne "PASS" -or $official.posture -cne "COHERENT_CONTAINED" -or
        $official.provenance.revisionComposeVerified -isnot [bool] -or
        $official.provenance.revisionComposeVerified -ne $true -or
        $official.redaction.rawSecretPresent -isnot [bool] -or
        $official.redaction.arbitraryPathPresent -isnot [bool] -or $official.redaction.stderrPresent -isnot [bool] -or
        $official.redaction.rawSecretPresent -ne $false -or
        $official.redaction.arbitraryPathPresent -ne $false -or $official.redaction.stderrPresent -ne $false -or
        (Get-Sha256Hex $officialRemoteBytes) -cne [string] $document.provenance.remoteDocumentSha256 -or
        (ConvertTo-CanonicalJson $official.remote) -cne (ConvertTo-CanonicalJson $document.remote) -or
        $official.provenance.repositoryHead -cne $document.provenance.repositoryHead) {
        Throw-SafeError "FINAL_POSTFLIGHT_INVALID"
    }
    if ($script:ProductionContractFixture) {
        if ($null -ne $official.provenance.repositoryHead) { Throw-SafeError "FINAL_POSTFLIGHT_PROVENANCE_INVALID" }
    }
    elseif ($official.provenance.repositoryHead -isnot [string] -or
        [string] $official.provenance.repositoryHead -cnotmatch "^(?:[0-9a-f]{40}|[0-9a-f]{64})$") {
        Throw-SafeError "FINAL_POSTFLIGHT_PROVENANCE_INVALID"
    }
    foreach ($sourceName in @("observer", "schema", "validator", "wrapper")) {
        $officialSource = $official.provenance.$sourceName
        Assert-ExactProperties $officialSource @("gitObject", "sha256") "FINAL_POSTFLIGHT_PROVENANCE_INVALID"
        if ($officialSource.sha256 -isnot [string] -or [string] $officialSource.sha256 -cnotmatch "^[0-9a-f]{64}$" -or
            ($script:ProductionContractFixture -and $null -ne $officialSource.gitObject) -or
            (-not $script:ProductionContractFixture -and ($officialSource.gitObject -isnot [string] -or
                [string] $officialSource.gitObject -cnotmatch "^(?:[0-9a-f]{40}|[0-9a-f]{64})$")) -or
            (ConvertTo-CanonicalJson $officialSource) -cne
            (ConvertTo-CanonicalJson $document.provenance.$sourceName)) {
            Throw-SafeError "FINAL_POSTFLIGHT_PROVENANCE_INVALID"
        }
    }
}

function Invoke-OfficialFinalPostflight {
    param([string] $Repository, [string] $EvidenceDirectory, [int] $TimeoutSeconds)
    if ($script:ProductionContractFixture) {
        $fixtureResult = Invoke-ContractFixtureTool "postflight" @($ExpectedRevision, $nonce) $null $TimeoutSeconds 128KB @(0)
        if ($fixtureResult.Stderr.Length -ne 0 -or $fixtureResult.Stdout.Length -le 0) {
            Throw-SafeError "FINAL_POSTFLIGHT_INVALID"
        }
        $fixtureName = "host-postflight-fixture-$ExpectedRevision-$($nonce.Substring(0, 12)).local.json"
        $fixturePath = Join-Path $EvidenceDirectory $fixtureName
        if (Test-Path -LiteralPath $fixturePath) { Throw-SafeError "FINAL_POSTFLIGHT_INVALID" }
        Write-CreateNew $fixturePath $fixtureResult.Stdout
        $fixtureLock = Open-SensitiveLock $fixturePath "FINAL_POSTFLIGHT_ACL_INVALID"
        try {
            $fixtureBytes = Read-LockedStreamBytes $fixtureLock.Stream 128KB "FINAL_POSTFLIGHT_INVALID"
            Assert-OfficialFinalPostflightBytes $fixtureBytes $Repository $nonce
        }
        catch { $fixtureLock.Stream.Dispose(); throw }
        return [pscustomobject]@{ Bytes = $fixtureBytes; Path = $fixtureLock.Path; Stream = $fixtureLock.Stream }
    }
    $before = @{}
    foreach ($item in @(Get-ChildItem -LiteralPath $EvidenceDirectory -Filter "host-postflight-*.local.json" -File -Force -ErrorAction SilentlyContinue)) {
        $before[$item.FullName] = $true
    }
    $scriptPath = Join-Path $Repository "scripts/invoke-lightsail-postflight.ps1"
    $result = Invoke-BoundedProcess $script:PowerShellPath @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $scriptPath, "-ExpectedSshCidr", $ExpectedSshCidr
    ) (New-IsolatedEnvironment -IncludeUserProfile) $null $TimeoutSeconds 4096 @(0)
    if ((Get-ProcessText $result "FINAL_POSTFLIGHT_INVALID").Trim() -notmatch "^POSTFLIGHT_CAPTURE_COMPLETE_PASS$") {
        Throw-SafeError "FINAL_POSTFLIGHT_INVALID"
    }
    $created = @(
        Get-ChildItem -LiteralPath $EvidenceDirectory -Filter "host-postflight-*.local.json" -File -Force |
            Where-Object { -not $before.ContainsKey($_.FullName) }
    )
    if ($created.Count -ne 1) { Throw-SafeError "FINAL_POSTFLIGHT_INVALID" }
    $captureLock = Open-SensitiveLock $created[0].FullName "FINAL_POSTFLIGHT_ACL_INVALID"
    try {
        $bytes = Read-LockedStreamBytes $captureLock.Stream 128KB "FINAL_POSTFLIGHT_INVALID"
        Assert-OfficialFinalPostflightBytes $bytes $Repository $nonce
    }
    catch { $captureLock.Stream.Dispose(); throw }
    if ((Get-CanonicalFile $created[0].FullName "FINAL_POSTFLIGHT_INVALID") -cne $captureLock.Path -or
        (Get-StreamSha256 $captureLock.Stream "FINAL_POSTFLIGHT_INVALID") -cne (Get-Sha256Hex $bytes)) {
        $captureLock.Stream.Dispose()
        Throw-SafeError "FINAL_POSTFLIGHT_CHANGED"
    }
    Assert-RestrictedAcl $captureLock.Path "FINAL_POSTFLIGHT_ACL_INVALID"
    return [pscustomobject]@{ Bytes = $bytes; Path = $captureLock.Path; Stream = $captureLock.Stream }
}

function Assert-OperatorImageRuntime {
    param([string] $ImageId, $Manifest, $Source)
    $inspectResult = Invoke-Docker @("image", "inspect", $ImageId) $null @(0) 30 2MB
    $inspectText = Get-ProcessText $inspectResult "OPERATOR_IMAGE_INVALID"
    $inspection = $inspectText | ConvertFrom-Json
    if (@($inspection).Count -ne 1) { Throw-SafeError "OPERATOR_IMAGE_INVALID" }
    $image = @($inspection)[0]
    if ($image.Id -cne $ImageId -or $image.Os -cne "linux" -or $image.Architecture -cne "amd64" -or
        $image.Config.User -cne "10001:10001" -or $image.Config.WorkingDir -cne "/workspace" -or
        @($image.Config.Entrypoint).Count -ne 1 -or $image.Config.Entrypoint[0] -cne "/usr/local/bin/refunddesk-edge-operator" -or
        @($image.Config.Cmd).Count -ne 0 -or
        $null -ne $image.Config.ExposedPorts -or $null -ne $image.Config.Healthcheck) {
        Throw-SafeError "OPERATOR_IMAGE_INVALID"
    }
    $configBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $image.Config -Newline))
    if ((Get-Sha256Hex $configBytes) -cne $Manifest.image.configSha256) { Throw-SafeError "OPERATOR_IMAGE_INVALID" }
    $program = 'import hashlib,json,pathlib,shutil,subprocess;cmds={"aws":["aws","--version"],"bash":["bash","--version"],"curl":["curl","--version"],"git":["git","--version"],"jq":["jq","--version"],"node":["node","--version"],"python3":["python3","--version"],"ssh":["ssh","-V"]};r={};[(r.__setitem__(n,{"path":shutil.which(n),"sha256":hashlib.sha256(pathlib.Path(shutil.which(n)).read_bytes()).hexdigest(),"version":subprocess.run(c,check=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=10).stdout.splitlines()[0].strip()})) for n,c in cmds.items()];print(json.dumps(r,separators=(",",":"),sort_keys=True))'
    $toolResult = Invoke-Docker @(
        "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "10001:10001",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--entrypoint", "/usr/bin/python3", $ImageId, "-c", $program
    ) $null @(0) 30 65536
    $tools = (Get-ProcessText $toolResult "OPERATOR_TOOLS_INVALID").Trim() | ConvertFrom-Json
    if ((ConvertTo-CanonicalJson $tools) -cne (ConvertTo-CanonicalJson $Manifest.tools)) { Throw-SafeError "OPERATOR_TOOLS_INVALID" }
    $sourceProgram = 'import hashlib,json,pathlib,sys;root=pathlib.Path("/workspace");found=[];[(sys.exit(64) if p.is_symlink() else found.append({"path":p.relative_to(root).as_posix(),"sourceSha256":hashlib.sha256(p.read_bytes()).hexdigest()})) for p in sorted(root.rglob("*")) if p.is_file() or p.is_symlink()];print(json.dumps(found,ensure_ascii=True,separators=(",",":"),sort_keys=True))'
    $sourceResult = Invoke-Docker @(
        "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "10001:10001",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--entrypoint", "/usr/bin/python3", $ImageId, "-c", $sourceProgram
    ) $null @(0) 30 131072
    $imageSources = (Get-ProcessText $sourceResult "OPERATOR_SOURCES_INVALID").Trim() | ConvertFrom-Json
    $expectedSources = @($Source.records | ForEach-Object {
        [ordered]@{ path = [string] $_.path; sourceSha256 = [string] $_.sourceSha256 }
    })
    if ((ConvertTo-CanonicalJson @($imageSources)) -cne (ConvertTo-CanonicalJson $expectedSources)) {
        Throw-SafeError "OPERATOR_SOURCES_INVALID"
    }
    return $image
}

function Get-RunnerCommand {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("run", "cleanup")][string] $Mode,
        [Parameter(Mandatory = $true)][string] $Nonce,
        [Parameter(Mandatory = $true)][string] $ControlRelative,
        [Parameter(Mandatory = $true)][string] $TransportRelative
    )
    $command = @(
        "--mode", $Mode, "--nonce", $Nonce, "--expected-revision", $ExpectedRevision,
        "--control-file", "/var/lib/refunddesk/input/$ControlRelative",
        "--workbench-checkpoint", "/var/lib/refunddesk/control/workbench-$Nonce.json",
        "--checkpoint-request", "/var/lib/refunddesk/control/workbench-request-$Nonce.json",
        "--transport-file", "/var/lib/refunddesk/input/$TransportRelative",
        "--control-root", "/var/lib/refunddesk/control", "--runtime-root", "/run/refunddesk"
    )
    return ,$command
}

function Assert-RunnerContainerContract {
    param(
        [Parameter(Mandatory = $true)] $Container,
        [Parameter(Mandatory = $true)] $Image,
        [Parameter(Mandatory = $true)][string] $ExpectedName,
        [Parameter(Mandatory = $true)][string] $ImageId,
        [Parameter(Mandatory = $true)][string] $Volume,
        [Parameter(Mandatory = $true)][string] $InputVolume,
        [Parameter(Mandatory = $true)][string] $Nonce,
        [Parameter(Mandatory = $true)][object[]] $ExpectedCommand,
        [Parameter(Mandatory = $true)][string] $Code
    )
    $expectedEnvironment = [ordered]@{}
    foreach ($entry in @($Image.Config.Env)) {
        $parts = ([string] $entry).Split([char[]] @('='), 2, [StringSplitOptions]::None)
        if ($parts.Count -ne 2 -or $expectedEnvironment.Contains($parts[0])) { Throw-SafeError $Code }
        $expectedEnvironment[$parts[0]] = $parts[1]
    }
    foreach ($entry in @(
        "AWS_SHARED_CREDENTIALS_FILE=/operator/aws/credentials",
        "AWS_CONFIG_FILE=/var/lib/refunddesk/input/aws-config", "AWS_PROFILE=default",
        "AWS_REGION=$($script:Authorization.awsRegion)", "AWS_DEFAULT_REGION=$($script:Authorization.awsRegion)",
        "AWS_EC2_METADATA_DISABLED=true", "AWS_PAGER=", "REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR=1"
    )) {
        $parts = $entry.Split([char[]] @('='), 2, [StringSplitOptions]::None)
        $expectedEnvironment[$parts[0]] = $parts[1]
    }
    $actualEnvironment = [ordered]@{}
    foreach ($entry in @($Container.Config.Env)) {
        $parts = ([string] $entry).Split([char[]] @('='), 2, [StringSplitOptions]::None)
        if ($parts.Count -ne 2 -or $actualEnvironment.Contains($parts[0])) { Throw-SafeError $Code }
        $actualEnvironment[$parts[0]] = $parts[1]
    }
    $expectedLabels = [ordered]@{}
    if ($null -ne $Image.Config.Labels) {
        foreach ($property in $Image.Config.Labels.PSObject.Properties) {
            if ($expectedLabels.Contains($property.Name)) { Throw-SafeError $Code }
            $expectedLabels[$property.Name] = [string] $property.Value
        }
    }
    $expectedLabels["com.refunddesk.edge-window-nonce"] = $Nonce
    $expectedLabels["com.refunddesk.revision"] = $ExpectedRevision
    $mounts = @($Container.Mounts)
    $tmpfs = $Container.HostConfig.Tmpfs
    $tmpfsCount = if ($null -eq $tmpfs) { 0 } else { @($tmpfs.PSObject.Properties).Count }
    $portBindingCount = if ($null -eq $Container.HostConfig.PortBindings) { 0 } else { @($Container.HostConfig.PortBindings.PSObject.Properties).Count }
    $controlMount = @($mounts | Where-Object { $_.Destination -ceq "/var/lib/refunddesk/control" -and $_.Type -ceq "volume" -and $_.Name -ceq $Volume -and $_.Driver -ceq "local" -and $_.Mode -ceq "z" -and $_.Propagation -ceq "" -and $_.RW -eq $true })
    $inputMount = @($mounts | Where-Object { $_.Destination -ceq "/var/lib/refunddesk/input" -and $_.Type -ceq "volume" -and $_.Name -ceq $InputVolume -and $_.Driver -ceq "local" -and $_.Mode -ceq "z" -and $_.Propagation -ceq "" -and $_.RW -eq $false })
    $credentialMount = @($mounts | Where-Object { $_.Destination -ceq "/operator/aws/credentials" -and $_.Type -ceq "bind" -and [string]::Equals([string] $_.Source, $script:CredentialsLock.Path, [StringComparison]::OrdinalIgnoreCase) -and $_.Mode -ceq "" -and $_.Propagation -ceq "rprivate" -and $_.RW -eq $false })
    $identityMount = @($mounts | Where-Object { $_.Destination -ceq "/operator/ssh/id" -and $_.Type -ceq "bind" -and [string]::Equals([string] $_.Source, $script:IdentityLock.Path, [StringComparison]::OrdinalIgnoreCase) -and $_.Mode -ceq "" -and $_.Propagation -ceq "rprivate" -and $_.RW -eq $false })
    $knownHostsMount = @($mounts | Where-Object { $_.Destination -ceq "/operator/ssh/known_hosts" -and $_.Type -ceq "bind" -and [string]::Equals([string] $_.Source, $script:KnownHostsLock.Path, [StringComparison]::OrdinalIgnoreCase) -and $_.Mode -ceq "" -and $_.Propagation -ceq "rprivate" -and $_.RW -eq $false })
    if ($Container.Name -cne "/$ExpectedName" -or $Container.Image -cne $ImageId -or $Container.Config.Image -cne $ImageId -or
        $Container.Config.User -cne "10001:10001" -or
        (ConvertTo-CanonicalJson @($Container.Config.Entrypoint)) -cne (ConvertTo-CanonicalJson @($Image.Config.Entrypoint)) -or
        (ConvertTo-CanonicalJson @($Container.Config.Cmd)) -cne (ConvertTo-CanonicalJson @($ExpectedCommand)) -or
        (ConvertTo-CanonicalJson $actualEnvironment) -cne (ConvertTo-CanonicalJson $expectedEnvironment) -or
        (ConvertTo-CanonicalJson $Container.Config.Labels) -cne (ConvertTo-CanonicalJson $expectedLabels) -or
        $Container.Config.ExposedPorts -ne $null -or $Container.HostConfig.ReadonlyRootfs -ne $true -or
        $Container.HostConfig.Privileged -ne $false -or @($Container.HostConfig.CapAdd).Count -ne 0 -or
        @($Container.HostConfig.CapDrop).Count -ne 1 -or $Container.HostConfig.CapDrop[0] -cne "ALL" -or
        @($Container.HostConfig.SecurityOpt).Count -ne 1 -or $Container.HostConfig.SecurityOpt[0] -notmatch "^no-new-privileges(?::true)?$" -or
        $Container.HostConfig.NetworkMode -cne "bridge" -or $Container.HostConfig.RestartPolicy.Name -cne "no" -or
        $Container.HostConfig.IpcMode -cne "private" -or $Container.HostConfig.PidMode -cne "private" -or
        $Container.HostConfig.UTSMode -cne "private" -or $Container.HostConfig.UsernsMode -cne "" -or
        $Container.HostConfig.PublishAllPorts -ne $false -or $portBindingCount -ne 0 -or
        [long] $Container.HostConfig.Memory -ne 536870912 -or [long] $Container.HostConfig.NanoCpus -ne 1000000000 -or
        [long] $Container.HostConfig.PidsLimit -ne 256 -or $mounts.Count -ne 5 -or $controlMount.Count -ne 1 -or $inputMount.Count -ne 1 -or
        $credentialMount.Count -ne 1 -or $identityMount.Count -ne 1 -or $knownHostsMount.Count -ne 1 -or
        $tmpfsCount -ne 2 -or $tmpfs."/tmp" -cne "rw,noexec,nosuid,nodev,size=32m" -or
        $tmpfs."/run/refunddesk" -cne "rw,noexec,nosuid,nodev,size=8m" -or
        @($mounts | Where-Object { $_.Destination -in @("/var/run/docker.sock", "/run/docker.sock", "/workspace") }).Count -ne 0 -or
        (@($Container.Config.Env) -join "`n") -match "(?i)(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|STRIPE|REFUNDDESK_EDGE_ORIGIN_TOKEN)=") {
        Throw-SafeError $Code
    }
}

function Invoke-RunnerCleanup {
    param([string] $ImageId, [string] $Volume, [string] $InputVolume, [string] $Repository, [string] $TransportRelative, [string] $ControlRelative, [string] $Nonce, $ImmutableInputs)
    $cleanupName = "refunddesk-edge-cleanup-$($Nonce.Substring(0, 12))"
    $expectedCleanupCommand = Get-RunnerCommand "cleanup" $Nonce $ControlRelative $TransportRelative
    $arguments = @(
        "container", "create", "--name", $cleanupName, "--pull", "never", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--network", "bridge", "--restart", "no",
        "--ipc", "private", "--pid", "private", "--uts", "private", "--user", "10001:10001",
        "--pids-limit", "256", "--memory", "512m", "--cpus", "1.0",
        "--label", "com.refunddesk.edge-window-nonce=$Nonce", "--label", "com.refunddesk.revision=$ExpectedRevision",
        "--mount", "type=volume,source=$Volume,target=/var/lib/refunddesk/control",
        "--mount", "type=volume,source=$InputVolume,target=/var/lib/refunddesk/input,readonly",
        "--mount", "type=bind,source=$($script:CredentialsLock.Path),target=/operator/aws/credentials,readonly",
        "--mount", "type=bind,source=$($script:IdentityLock.Path),target=/operator/ssh/id,readonly",
        "--mount", "type=bind,source=$($script:KnownHostsLock.Path),target=/operator/ssh/known_hosts,readonly",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m", "--tmpfs", "/run/refunddesk:rw,noexec,nosuid,nodev,size=8m",
        "--env", "AWS_SHARED_CREDENTIALS_FILE=/operator/aws/credentials",
        "--env", "AWS_CONFIG_FILE=/var/lib/refunddesk/input/aws-config", "--env", "AWS_PROFILE=default",
        "--env", "AWS_REGION=$($script:Authorization.awsRegion)", "--env", "AWS_DEFAULT_REGION=$($script:Authorization.awsRegion)",
        "--env", "AWS_EC2_METADATA_DISABLED=true", "--env", "AWS_PAGER=",
        "--env", "REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR=1",
        $ImageId
    )
    $arguments += $expectedCleanupCommand
    $captureStreams = [Collections.Generic.List[IDisposable]]::new()
    $cleanupCreatedHere = $false
    $cleanupStartAttempted = $false
    $cleanupTerminalObserved = $false
    try {
        $preexisting = Invoke-Docker @("container", "inspect", $cleanupName) $null @(0, 1) 30 2MB
        if ($preexisting.ExitCode -eq 1) {
            [void] (Invoke-Docker $arguments $null @(0) 60 4096)
            $cleanupCreatedHere = $true
            $cleanupInspectResult = Invoke-Docker @("container", "inspect", $cleanupName) $null @(0) 30 2MB
        }
        else { $cleanupInspectResult = $preexisting }
        $cleanupInspect = @((Get-ProcessText $cleanupInspectResult "CLEANUP_CONTAINER_CONTRACT_INVALID") | ConvertFrom-Json)
        $cleanupImageInspect = @((Get-ProcessText (Invoke-Docker @("image", "inspect", $ImageId) $null @(0) 30 2MB) "CLEANUP_CONTAINER_CONTRACT_INVALID") | ConvertFrom-Json)
        if ($cleanupInspect.Count -ne 1 -or $cleanupImageInspect.Count -ne 1) { Throw-SafeError "CLEANUP_CONTAINER_CONTRACT_INVALID" }
        Assert-SealedInputVolume $InputVolume $ImageId $Nonce ([pscustomobject] $ImmutableInputs)
        Assert-RunnerContainerContract $cleanupInspect[0] $cleanupImageInspect[0] $cleanupName $ImageId $Volume $InputVolume $Nonce $expectedCleanupCommand "CLEANUP_CONTAINER_CONTRACT_INVALID"
        $initialCleanupState = $cleanupInspect[0].State
        if ($initialCleanupState.Running -isnot [bool] -or $initialCleanupState.Status -isnot [string] -or
            ($initialCleanupState.ExitCode -isnot [int] -and $initialCleanupState.ExitCode -isnot [long])) {
            Throw-SafeError "CLEANUP_CONTAINER_STATE_INVALID"
        }
        if ($initialCleanupState.Running -eq $true) {
            if ($initialCleanupState.Status -cne "running") { Throw-SafeError "CLEANUP_CONTAINER_STATE_INVALID" }
            $cleanupStartAttempted = $true
        }
        elseif ($initialCleanupState.Running -eq $false -and $initialCleanupState.Status -ceq "created" -and
            [int] $initialCleanupState.ExitCode -eq 0) {
            $cleanupStartAttempted = $true
            [void] (Invoke-Docker @("container", "start", $cleanupName) $null @(0) 30 4096)
        }
        elseif ($initialCleanupState.Running -ne $false -or $initialCleanupState.Status -cne "exited" -or
            [int] $initialCleanupState.ExitCode -notin @(0, 20, 21)) {
            Throw-SafeError "CLEANUP_CONTAINER_STATE_INVALID"
        }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $postflightInjected = $false
        $evidenceDirectory = Join-Path $Repository "sandbox-evidence.local/aws"
        while ($true) {
            $state = Get-DockerContainerState $cleanupName
            if ($null -eq $state) { Throw-SafeError "CLEANUP_CONTAINER_STATE_INVALID" }
            if (-not $state.Running) { break }
            if ($timer.Elapsed.TotalSeconds -gt 720) {
                # A cleanup runner may be between AWS close and its durable
                # read-back.  Preserve the unique exact container and both
                # volumes for a later bounded resume; never signal or force-
                # remove it merely because this workstation observation ended.
                Throw-SafeError "CLEANUP_RUNNER_CONVERGENCE_AMBIGUOUS"
            }
            if (-not $postflightInjected) {
                $resultRelative = "edge-window-operation-$Nonce/final-postflight-capture.json"
                $existingResult = Get-VolumeFile $Volume $ImageId $resultRelative
                if ($null -ne $existingResult) {
                    # A capture injected before the wrapper crash is replayed by
                    # the runner.  Never create a competing second capture.
                    $postflightInjected = $true
                }
                else {
                    $requestBytes = Get-VolumeFile $Volume $ImageId "edge-window-operation-$Nonce/final-postflight-request.json"
                    if ($null -ne $requestBytes) {
                        $request = ConvertFrom-BoundedJson $requestBytes "FINAL_POSTFLIGHT_REQUEST_INVALID" -RequireCanonical
                        Assert-ExactProperties $request @("expectedRevision", "kind", "nonce", "requestBootIdSha256", "requestedAt", "requestedBoottimeMilliseconds", "schemaVersion") "FINAL_POSTFLIGHT_REQUEST_INVALID"
                        Assert-FinalPostflightRequestValues $request $Nonce
                        $remaining = [int] [Math]::Floor(720 - $timer.Elapsed.TotalSeconds)
                        if ($remaining -le 0) { Throw-SafeError "CLEANUP_RUNNER_TIMEOUT" }
                        $capture = Invoke-OfficialFinalPostflight $Repository $evidenceDirectory ([Math]::Min($FinalPostflightSeconds, $remaining))
                        $captureStreams.Add($capture.Stream)
                        New-VolumeFile $Volume $ImageId $resultRelative $capture.Bytes
                        $postflightInjected = $true
                    }
                }
            }
            Start-Sleep -Milliseconds 500
        }
        $finalState = Get-DockerContainerState $cleanupName
        if ($null -eq $finalState -or $finalState.Running -ne $false -or $finalState.Status -cne "exited" -or
            [int] $finalState.ExitCode -notin @(0, 20, 21)) {
            Throw-SafeError "CLEANUP_RUNNER_EXIT_INVALID"
        }
        $logs = Invoke-Docker @("container", "logs", $cleanupName) $null @(0) 30 $MaximumEvidenceBytes
        if ($logs.Stderr.Length -ne 0 -or $logs.Stdout.Length -le 0) { Throw-SafeError "CLEANUP_RUNNER_OUTPUT_INVALID" }
        $cleanupTerminalObserved = $true
        return [pscustomobject]@{ ExitCode = [int] $finalState.ExitCode; Stdout = $logs.Stdout; Stderr = $logs.Stderr }
    }
    finally {
        foreach ($stream in $captureStreams) { try { $stream.Dispose() } catch {} }
        if ($cleanupTerminalObserved -or ($cleanupCreatedHere -and -not $cleanupStartAttempted)) {
            try {
                $removableState = Get-DockerContainerState $cleanupName
                if ($null -ne $removableState -and $removableState.Running -eq $false) {
                    [void] (Invoke-Docker @("container", "rm", $cleanupName) $null @(0, 1) 30 4096)
                }
            }
            catch {
                # Preserve the deterministic helper on any state ambiguity.
            }
        }
    }
}

function Stop-RunnerContainerBounded {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $ImageId,
        [Parameter(Mandatory = $true)][string] $Volume,
        [Parameter(Mandatory = $true)][string] $Repository,
        [Parameter(Mandatory = $true)][string] $Nonce
    )
    # Never TERM/KILL an effect-capable runner merely because the workstation
    # path failed.  It may be between AWS close and its durable read-back.  Let
    # the unique runner/watchdog finish its AWS-first containment path, inject
    # the official postflight if requested, and preserve the container/volume
    # if that bounded convergence cannot be observed.
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $postflightInjected = $false
    $evidenceDirectory = Join-Path $Repository "sandbox-evidence.local/aws"
    while ($timer.Elapsed.TotalSeconds -le 720) {
        $state = Get-DockerContainerState $Name
        if ($null -eq $state -or -not $state.Running) { return }
        if (-not $postflightInjected) {
            $resultRelative = "edge-window-operation-$Nonce/final-postflight-capture.json"
            if ($null -ne (Get-VolumeFile $Volume $ImageId $resultRelative)) {
                $postflightInjected = $true
            }
            else {
                $requestBytes = Get-VolumeFile $Volume $ImageId "edge-window-operation-$Nonce/final-postflight-request.json"
                if ($null -ne $requestBytes) {
                    $request = ConvertFrom-BoundedJson $requestBytes "FINAL_POSTFLIGHT_REQUEST_INVALID" -RequireCanonical
                    Assert-ExactProperties $request @("expectedRevision", "kind", "nonce", "requestBootIdSha256", "requestedAt", "requestedBoottimeMilliseconds", "schemaVersion") "FINAL_POSTFLIGHT_REQUEST_INVALID"
                    Assert-FinalPostflightRequestValues $request $Nonce
                    $remaining = [int] [Math]::Floor(720 - $timer.Elapsed.TotalSeconds)
                    if ($remaining -le 0) { break }
                    $capture = Invoke-OfficialFinalPostflight $Repository $evidenceDirectory ([Math]::Min($FinalPostflightSeconds, $remaining))
                    try { New-VolumeFile $Volume $ImageId $resultRelative $capture.Bytes }
                    finally { $capture.Stream.Dispose() }
                    $postflightInjected = $true
                }
            }
        }
        Start-Sleep -Milliseconds 500
    }
    Throw-SafeError "RUNNER_CONTAINER_CONVERGENCE_AMBIGUOUS"
}

function Complete-PreRunnerClockCleanup {
    param(
        [Parameter(Mandatory = $true)] $Attempt,
        [Parameter(Mandatory = $true)][string] $MarkerPath,
        [Parameter(Mandatory = $true)][string] $ContainerName,
        [Parameter(Mandatory = $true)][string] $Volume,
        [Parameter(Mandatory = $true)][string] $InputVolume,
        [Parameter(Mandatory = $true)][string] $ImageId,
        [AllowNull()] $OperatorImage,
        [AllowNull()] $ExpectedRunnerCommand,
        [AllowNull()] $ImmutableInputs
    )
    if ($Attempt.operatorClockInvalidated -ne $true) { Throw-SafeError "ATTEMPT_MARKER_INVALID" }
    $containerResult = Invoke-Docker @("container", "inspect", $ContainerName) $null @(0, 1) 30 2MB
    if ($containerResult.ExitCode -eq 0) {
        $containers = @((Get-ProcessText $containerResult "ATTEMPT_CONTAINER_INVALID") | ConvertFrom-Json)
        if ($containers.Count -ne 1 -or $containers[0].State.Running -ne $false -or
            $null -eq $OperatorImage -or $null -eq $ExpectedRunnerCommand) {
            Throw-SafeError "ATTEMPT_CONTAINER_INVALID"
        }
        Assert-RunnerContainerContract $containers[0] $OperatorImage $ContainerName $ImageId $Volume $InputVolume ([string] $Attempt.nonce) $ExpectedRunnerCommand "ATTEMPT_CONTAINER_INVALID"
        [void] (Invoke-Docker @("container", "rm", $ContainerName) $null @(0) 30 4096)
    }
    $stateVolumeResult = Invoke-Docker @("volume", "inspect", $Volume) $null @(0, 1) 30 65536
    $inputVolumeResult = Invoke-Docker @("volume", "inspect", $InputVolume) $null @(0, 1) 30 65536
    if ($stateVolumeResult.ExitCode -eq 0) {
        $stateVolume = @((Get-ProcessText $stateVolumeResult "ATTEMPT_VOLUME_INVALID") | ConvertFrom-Json)
        if ($stateVolume.Count -ne 1 -or $stateVolume[0].Name -cne $Volume -or
            $stateVolume[0].Driver -cne "local" -or $stateVolume[0].Scope -cne "local") {
            Throw-SafeError "ATTEMPT_VOLUME_INVALID"
        }
        Assert-ExactProperties $stateVolume[0].Labels @(
            "com.refunddesk.edge-window-nonce", "com.refunddesk.revision"
        ) "ATTEMPT_VOLUME_INVALID"
        if ($stateVolume[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
            $stateVolume[0].Labels."com.refunddesk.edge-window-nonce" -cne [string] $Attempt.nonce) {
            Throw-SafeError "ATTEMPT_VOLUME_INVALID"
        }
    }
    if ($inputVolumeResult.ExitCode -eq 0) {
        $inputVolumeDocument = @((Get-ProcessText $inputVolumeResult "ATTEMPT_INPUT_VOLUME_INVALID") | ConvertFrom-Json)
        if ($inputVolumeDocument.Count -ne 1 -or $inputVolumeDocument[0].Name -cne $InputVolume -or
            $inputVolumeDocument[0].Driver -cne "local" -or $inputVolumeDocument[0].Scope -cne "local") {
            Throw-SafeError "ATTEMPT_INPUT_VOLUME_INVALID"
        }
        Assert-ExactProperties $inputVolumeDocument[0].Labels @(
            "com.refunddesk.edge-window-input", "com.refunddesk.edge-window-nonce", "com.refunddesk.revision"
        ) "ATTEMPT_INPUT_VOLUME_INVALID"
        if ($inputVolumeDocument[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
            $inputVolumeDocument[0].Labels."com.refunddesk.edge-window-nonce" -cne [string] $Attempt.nonce -or
            $inputVolumeDocument[0].Labels."com.refunddesk.edge-window-input" -cne "true") {
            Throw-SafeError "ATTEMPT_INPUT_VOLUME_INVALID"
        }
        if ($null -ne $ImmutableInputs) {
            Assert-SealedInputVolume $InputVolume $ImageId ([string] $Attempt.nonce) ([pscustomobject] $ImmutableInputs)
        }
    }
    if ($containerResult.ExitCode -eq 0 -and
        (Invoke-Docker @("container", "inspect", $ContainerName) $null @(0, 1) 30 4096).ExitCode -ne 1) {
        Throw-SafeError "ATTEMPT_CLOCK_CLEANUP_AMBIGUOUS"
    }
    if ($stateVolumeResult.ExitCode -eq 0) { [void] (Invoke-Docker @("volume", "rm", $Volume) $null @(0) 30 4096) }
    if ($inputVolumeResult.ExitCode -eq 0) { [void] (Invoke-Docker @("volume", "rm", $InputVolume) $null @(0) 30 4096) }
    if (([bool] $Attempt.imageCreatedByAttempt -or
            ($Attempt.imagePreexisting -eq $false -and [bool] $Attempt.imageLoadAttempted)) -and
        (Invoke-Docker @("image", "inspect", $ImageId) $null @(0, 1) 30 4096).ExitCode -eq 0) {
        [void] (Invoke-Docker @("image", "rm", $ImageId) $null @(0) 60 4096)
    }
    if ((Invoke-Docker @("container", "inspect", $ContainerName) $null @(0, 1) 30 4096).ExitCode -ne 1 -or
        (Invoke-Docker @("volume", "inspect", $Volume) $null @(0, 1) 30 4096).ExitCode -ne 1 -or
        (Invoke-Docker @("volume", "inspect", $InputVolume) $null @(0, 1) 30 4096).ExitCode -ne 1) {
        Throw-SafeError "ATTEMPT_CLOCK_CLEANUP_AMBIGUOUS"
    }
    $Attempt.completedAt = Get-UtcTimestamp
    $Attempt.localCleanupComplete = $true
    $Attempt.state = "cleanup_complete"
    Write-RestrictedReplace $MarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $Attempt -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
}

function Exit-PreRunnerClockCleanup {
    param(
        [Parameter(Mandatory = $true)] $Attempt,
        [Parameter(Mandatory = $true)][string] $MarkerPath,
        [Parameter(Mandatory = $true)][string] $ContainerName,
        [Parameter(Mandatory = $true)][string] $Volume,
        [Parameter(Mandatory = $true)][string] $InputVolume,
        [Parameter(Mandatory = $true)][string] $ImageId,
        [AllowNull()] $OperatorImage,
        [AllowNull()] $ExpectedRunnerCommand,
        [AllowNull()] $ImmutableInputs,
        [Parameter(Mandatory = $true)][string] $Repository,
        [Parameter(Mandatory = $true)] $Source
    )
    Set-OperatorClockInvalidated $Attempt $MarkerPath
    Complete-PreRunnerClockCleanup $Attempt $MarkerPath $ContainerName $Volume $InputVolume $ImageId $OperatorImage $ExpectedRunnerCommand $ImmutableInputs
    Assert-SourceProvenance $Repository $Source
    $script:containerCreatedByAttempt = $false
    $script:volumeCreatedByAttempt = $false
    $script:inputVolumeCreatedByAttempt = $false
    $script:imageLoadedByAttempt = $false
    $script:containerName = $null
    $script:volume = $null
    $script:inputVolume = $null
    $script:operationSucceeded = $true
    $script:exitCode = 21
    [Console]::Error.WriteLine("edge-window-wrapper-error:OPERATOR_CLOCK_CLEANUP_ONLY")
    exit 21
}

$locks = [Collections.Generic.List[IDisposable]]::new()
$volume = $null
$inputVolume = $null
$containerName = $null
$imageLoadedByAttempt = $false
$operationSucceeded = $false
$runnerStarted = $false
$containerCreatedByAttempt = $false
$volumeCreatedByAttempt = $false
$inputVolumeCreatedByAttempt = $false
$controlRelative = $null
$transportRelative = $null
$nonce = $null
$imageId = $null
$dockerConfigDirectory = $null
$ghConfigDirectory = $null
$attemptMarkerPath = $null
$attemptStartedAt = $null
$operatorBootIdentifierSha256 = $null
$operatorStartedMonotonicMilliseconds = $null
$operatorDeadlineMonotonicMilliseconds = $null
$operatorControlCalculatedMonotonicMilliseconds = $null
$operationRemainingSecondsAtRunnerStart = $null
$attemptRecord = $null
$immutableInputs = $null
$attemptMarkerInitiallyPresent = $false
$attemptDiscoverySha256 = $null
$admissionValidationTimestamp = $null
$resumingPrepared = $false
$resumingUncommittedPrepared = $false
$resumingFinalizing = $false
$exitCode = 21

try {
    if (-not [Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -lt 5) {
        Throw-SafeError "POWERSHELL_RUNTIME_INVALID"
    }
    if (-not $ContractFixture -and
        (-not [string]::IsNullOrWhiteSpace($FixtureToolDirectory) -or
            -not [string]::IsNullOrWhiteSpace($FixtureFinalEvidencePath) -or
            $FixtureCrashAfter -cne "none" -or $FixtureClockAdvanceSeconds -ne 0 -or
            $FixturePostMarkerWallClockOffsetSeconds -ne 0 -or
            $FixturePostMarkerMonotonicAdvanceMilliseconds -ne 0 -or
            $FixturePreRunnerStartMonotonicAdvanceMilliseconds -ne 0 -or
            $FixtureRunnerMonitorMonotonicAdvanceMilliseconds -ne 0 -or
            -not [string]::IsNullOrWhiteSpace($FixturePostMarkerBootIdentifierSha256))) {
        Throw-SafeError "FIXTURE_MODE_INVALID"
    }
    if (($FixtureClockAdvanceSeconds -ne 0 -or $FixturePostMarkerWallClockOffsetSeconds -ne 0 -or
            $FixturePostMarkerMonotonicAdvanceMilliseconds -ne 0 -or
            $FixturePreRunnerStartMonotonicAdvanceMilliseconds -ne 0 -or
            $FixtureRunnerMonitorMonotonicAdvanceMilliseconds -ne 0 -or
            -not [string]::IsNullOrWhiteSpace($FixturePostMarkerBootIdentifierSha256)) -and
        -not $script:ProductionContractFixture) { Throw-SafeError "FIXTURE_MODE_INVALID" }
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    if ($script:ProductionContractFixture) {
        $script:FixtureToolRoot = Get-CanonicalDirectory $FixtureToolDirectory "FIXTURE_TOOL_DIRECTORY_INVALID"
        $script:FixtureToolPath = Get-CanonicalFile (Join-Path $script:FixtureToolRoot "edge-window-wrapper-fake-tool.ps1") "FIXTURE_TOOL_INVALID"
        if ([string]::IsNullOrWhiteSpace($FixtureFinalEvidencePath) -or $FixtureCrashAfter -in @("after_prepared", "after_evidence")) {
            Throw-SafeError "FIXTURE_INVALID"
        }
        $script:FixtureTerminalPath = Get-CanonicalFile $FixtureFinalEvidencePath "FIXTURE_PATH_INVALID"
        $repository = Get-CanonicalDirectory (Join-Path $script:FixtureToolRoot "repository") "FIXTURE_REPOSITORY_INVALID"
    }
    $output = Get-CanonicalDirectory $OutputDirectory "OUTPUT_DIRECTORY_INVALID"
    Assert-RestrictedAcl $output "OUTPUT_DIRECTORY_ACL_INVALID"
    $dockerConfigDirectory = New-RestrictedDirectory $output (".refunddesk-docker-{0}" -f (New-Nonce).Substring(0, 12)) "DOCKER_ISOLATION_INVALID"
    $ghConfigDirectory = New-RestrictedDirectory $output (".refunddesk-gh-{0}" -f (New-Nonce).Substring(0, 12)) "GH_ISOLATION_INVALID"
    $script:DockerConfigDirectory = $dockerConfigDirectory
    $script:DockerEndpoint = $ExpectedDockerEndpoint
    $script:GhConfigDirectory = $ghConfigDirectory
    $checkpoint = [IO.Path]::GetFullPath($WorkbenchCheckpointPath)
    $checkpointParent = Get-CanonicalDirectory ([IO.Path]::GetDirectoryName($checkpoint)) "WORKBENCH_PARENT_INVALID"
    Assert-RestrictedAcl $checkpointParent "WORKBENCH_PARENT_ACL_INVALID"
    $checkpointPreexisting = [bool] (Test-Path -LiteralPath $checkpoint)

    if ($ContractFixture -and -not $script:ProductionContractFixture) {
        if ($FixtureCrashAfter -notin @("none", "after_prepared", "after_evidence")) { Throw-SafeError "FIXTURE_INVALID" }
        if ($checkpointPreexisting) { Throw-SafeError "WORKBENCH_MUST_BE_ABSENT" }
        if ([string]::IsNullOrWhiteSpace($FixtureFinalEvidencePath)) { Throw-SafeError "FIXTURE_INVALID" }
        $fixture = Get-CanonicalFile $FixtureFinalEvidencePath "FIXTURE_PATH_INVALID"
        $fixtureBytes = [IO.File]::ReadAllBytes($fixture)
        $document = ConvertFrom-BoundedJson $fixtureBytes "FIXTURE_JSON_INVALID"
        $fixtureText = Get-Utf8Text $fixtureBytes "FIXTURE_JSON_INVALID"
        if (-not $fixtureText.EndsWith("`n") -or $fixtureText.Contains("`r") -or
            $fixtureText.Substring(0, $fixtureText.Length - 1).Contains("`n")) {
            Throw-SafeError "FIXTURE_LINE_FORMAT_INVALID"
        }
        if ((ConvertTo-CanonicalJson $document -Newline) -cne $fixtureText) {
            Throw-SafeError "FIXTURE_CANONICAL_INVALID"
        }
        $fixtureNonce = [string] $document.nonce
        $fixtureExitCode = [int] $document.exitCode
        if ($fixtureExitCode -notin @(0, 20, 21) -or $document.expectedRevision -cne $ExpectedRevision -or
            ($fixtureExitCode -eq 0 -and ($document.result -cne "PASS" -or $document.code -cne "PASS_EDGE_WINDOW_RECONTAINED")) -or
            ($fixtureExitCode -eq 20 -and $document.result -cne "FAIL") -or
            ($fixtureExitCode -eq 21 -and $document.result -cne "INCOMPLETE")) {
            Throw-SafeError "FIXTURE_IDENTITY_INVALID"
        }
        $validation = Invoke-BoundedProcess $PinnedNodePath @(
            (Join-Path $repository "scripts/validate-lightsail-edge-window.mjs"),
            $fixture, (Join-Path $repository "docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json"),
            $fixtureNonce, $ExpectedRevision, ([string] $fixtureExitCode),
            [string] $document.startedAt, [string] $document.completedAt, "fixture"
        ) (New-IsolatedEnvironment) $null 30 4096 @(0)
        if ((Get-ProcessText $validation "FIXTURE_VALIDATOR_FAILED").Trim() -cne "PASS_EDGE_WINDOW_RECONTAINED") { Throw-SafeError "FIXTURE_VALIDATOR_FAILED" }
        $fixtureSha256 = Get-Sha256Hex $fixtureBytes
        $fixtureEvidenceName = "edge-window-$ExpectedRevision-$($fixtureNonce.Substring(0, 12)).local.json"
        $fixtureEvidencePath = Join-Path $output $fixtureEvidenceName
        $fixtureMarkerPath = Join-Path $output "edge-window-fixture-attempt-$ExpectedRevision-$($fixtureNonce.Substring(0, 12)).json"
        $fixtureRecord = $null
        if (Test-Path -LiteralPath $fixtureMarkerPath) {
            $fixtureMarkerLock = Open-SensitiveLock $fixtureMarkerPath "FIXTURE_MARKER_INVALID"
            try {
                $fixtureRecord = ConvertFrom-BoundedJson (Read-LockedStreamBytes $fixtureMarkerLock.Stream 16384 "FIXTURE_MARKER_INVALID") "FIXTURE_MARKER_INVALID" -RequireCanonical
            }
            finally { $fixtureMarkerLock.Stream.Dispose() }
            Assert-ExactProperties $fixtureRecord @(
                "completedAt", "evidenceFile", "evidenceSha256", "exitCode", "fixtureSha256", "kind",
                "nonce", "result", "revision", "schemaVersion", "startedAt", "state"
            ) "FIXTURE_MARKER_INVALID"
            if ($fixtureRecord.schemaVersion -ne 1 -or $fixtureRecord.kind -cne "refunddesk.edge-window-contract-attempt" -or
                $fixtureRecord.revision -cne $ExpectedRevision -or $fixtureRecord.nonce -cne $fixtureNonce -or
                $fixtureRecord.fixtureSha256 -cne $fixtureSha256 -or [int] $fixtureRecord.exitCode -ne $fixtureExitCode -or
                $fixtureRecord.result -cne [string] $document.result -or
                $fixtureRecord.state -notin @("prepared", "finalizing", "cleanup_required", "complete")) {
                Throw-SafeError "FIXTURE_MARKER_INVALID"
            }
        }
        else {
            $fixtureRecord = [ordered]@{
                completedAt = $null
                evidenceFile = $null
                evidenceSha256 = $null
                exitCode = $fixtureExitCode
                fixtureSha256 = $fixtureSha256
                kind = "refunddesk.edge-window-contract-attempt"
                nonce = $fixtureNonce
                result = [string] $document.result
                revision = $ExpectedRevision
                schemaVersion = 1
                startedAt = Get-UtcTimestamp
                state = "prepared"
            }
            Write-CreateNew $fixtureMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $fixtureRecord -Newline)))
        }
        if ($FixtureCrashAfter -ceq "after_prepared" -and $fixtureRecord.state -ceq "prepared") {
            Throw-SafeError "FIXTURE_CRASH_AFTER_PREPARED"
        }
        if (Test-Path -LiteralPath $fixtureEvidencePath) {
            $fixtureEvidenceLock = Open-SensitiveLock $fixtureEvidencePath "FIXTURE_EVIDENCE_INVALID"
            try {
                $existingFixtureBytes = Read-LockedStreamBytes $fixtureEvidenceLock.Stream $MaximumEvidenceBytes "FIXTURE_EVIDENCE_INVALID"
                if ((Get-Sha256Hex $existingFixtureBytes) -cne $fixtureSha256) { Throw-SafeError "FIXTURE_EVIDENCE_INVALID" }
            }
            finally { $fixtureEvidenceLock.Stream.Dispose() }
        }
        else { Write-CreateNew $fixtureEvidencePath $fixtureBytes }
        if ($fixtureRecord.state -ceq "prepared") {
            $fixtureRecord.evidenceFile = $fixtureEvidenceName
            $fixtureRecord.evidenceSha256 = $fixtureSha256
            $fixtureRecord.state = if (Test-EdgeTerminalIsSafelyContained $document) { "finalizing" } else { "cleanup_required" }
            Write-RestrictedReplace $fixtureMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $fixtureRecord -Newline))) "FIXTURE_MARKER_COMMIT_FAILED"
        }
        if ($FixtureCrashAfter -ceq "after_evidence" -and $fixtureRecord.state -ceq "finalizing") {
            Throw-SafeError "FIXTURE_CRASH_AFTER_EVIDENCE"
        }
        if ($fixtureRecord.evidenceFile -cne $fixtureEvidenceName -or $fixtureRecord.evidenceSha256 -cne $fixtureSha256) {
            Throw-SafeError "FIXTURE_MARKER_INVALID"
        }
        if ($fixtureRecord.state -ceq "cleanup_required") {
            $operationSucceeded = $true
            $exitCode = $fixtureExitCode
            [Console]::Out.WriteLine($fixtureEvidenceName)
            exit $fixtureExitCode
        }
        if ($fixtureRecord.state -ceq "finalizing") {
            $fixtureRecord.completedAt = Get-UtcTimestamp
            $fixtureRecord.state = "complete"
            Write-RestrictedReplace $fixtureMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $fixtureRecord -Newline))) "FIXTURE_MARKER_COMMIT_FAILED"
        }
        $operationSucceeded = $true
        $exitCode = $fixtureExitCode
        [Console]::Out.WriteLine($fixtureEvidenceName)
        exit $fixtureExitCode
    }

    if ($script:ProductionContractFixture) {
        # The harness still pins and locks every executable byte it invokes.
        # Node, Docker and gh behavior is multiplexed through the single
        # separately locked fake PowerShell tool; Git remains the real CLI.
        $fixturePowerShellSha256 = Get-FileSha256 $PinnedPowerShellPath
        $fixtureGitSha256 = Get-FileSha256 $PinnedGitPath
        $fixtureTaskkillSha256 = Get-FileSha256 $PinnedTaskkillPath
        $script:PowerShellPath = Assert-PinnedTool $PinnedPowerShellPath $fixturePowerShellSha256 "POWERSHELL_TOOL_INVALID"
        $script:NodePath = $script:PowerShellPath
        $script:DockerPath = $script:PowerShellPath
        $script:GhPath = $script:PowerShellPath
        $script:GitPath = Assert-PinnedTool $PinnedGitPath $fixtureGitSha256 "GIT_TOOL_INVALID"
        $script:GitToolSha256 = $fixtureGitSha256
        $script:TaskkillPath = Assert-PinnedTool $PinnedTaskkillPath $fixtureTaskkillSha256 "TASKKILL_TOOL_INVALID"
        $toolSpecifications = @(
            @($script:PowerShellPath, $fixturePowerShellSha256, "POWERSHELL_TOOL_INVALID"),
            @($script:GitPath, $fixtureGitSha256, "GIT_TOOL_INVALID"),
            @($script:TaskkillPath, $fixtureTaskkillSha256, "TASKKILL_TOOL_INVALID"),
            @($script:FixtureToolPath, (Get-FileSha256 $script:FixtureToolPath), "FIXTURE_TOOL_INVALID")
        )
    }
    else {
        $script:NodePath = Assert-PinnedTool $PinnedNodePath $PinnedNodeSha256 "NODE_TOOL_INVALID"
        $script:GitPath = Assert-PinnedTool $PinnedGitPath $PinnedGitSha256 "GIT_TOOL_INVALID"
        $script:GitToolSha256 = $PinnedGitSha256
        $script:DockerPath = Assert-PinnedTool $PinnedDockerPath $PinnedDockerSha256 "DOCKER_TOOL_INVALID"
        $script:GhPath = Assert-PinnedTool $PinnedGhPath $PinnedGhSha256 "GH_TOOL_INVALID"
        $script:PowerShellPath = Assert-PinnedTool $PinnedPowerShellPath $PinnedPowerShellSha256 "POWERSHELL_TOOL_INVALID"
        $script:TaskkillPath = Assert-PinnedTool $PinnedTaskkillPath $PinnedTaskkillSha256 "TASKKILL_TOOL_INVALID"
        $toolSpecifications = @(
            @($script:NodePath, $PinnedNodeSha256, "NODE_TOOL_INVALID"),
            @($script:GitPath, $PinnedGitSha256, "GIT_TOOL_INVALID"),
            @($script:DockerPath, $PinnedDockerSha256, "DOCKER_TOOL_INVALID"),
            @($script:GhPath, $PinnedGhSha256, "GH_TOOL_INVALID"),
            @($script:PowerShellPath, $PinnedPowerShellSha256, "POWERSHELL_TOOL_INVALID"),
            @($script:TaskkillPath, $PinnedTaskkillSha256, "TASKKILL_TOOL_INVALID")
        )
    }
    foreach ($toolSpecification in $toolSpecifications) {
        $toolLock = Open-InputLock $toolSpecification[0] $toolSpecification[1] $toolSpecification[2] 1GB -NoBytes
        $locks.Add($toolLock.Stream)
    }

    $source = Get-SourceProvenance $repository
    foreach ($sourceBinding in @($source.bindings)) { $locks.Add($sourceBinding.Stream) }
    foreach ($controlBinding in @($source.controlBindings)) { $locks.Add($controlBinding.Stream) }
    Assert-SourceProvenance $repository $source

    $incidentLock = Open-InputLock $IncidentEvidencePath $ExpectedIncidentEvidenceSha256 "INCIDENT_EVIDENCE_INVALID" 128KB -RequireRestrictedAcl
    $preflightLock = Open-InputLock $PreflightEvidencePath $ExpectedPreflightEvidenceSha256 "PREFLIGHT_EVIDENCE_INVALID" 128KB -RequireRestrictedAcl
    $promotionLock = Open-InputLock $PromotionEvidencePath $ExpectedPromotionEvidenceSha256 "PROMOTION_EVIDENCE_INVALID" 65536 -RequireRestrictedAcl
    $authorizationLock = Open-InputLock $AuthorizationPath $ExpectedAuthorizationSha256 "AUTHORIZATION_INVALID" 32768 -RequireRestrictedAcl
    $operatorManifestLock = Open-InputLock $OperatorManifestPath $ExpectedOperatorManifestSha256 "OPERATOR_MANIFEST_INVALID" 65536 -RequireRestrictedAcl
    $operatorArchiveLock = Open-InputLock $OperatorArchivePath $ExpectedOperatorArchiveSha256 "OPERATOR_ARCHIVE_INVALID" 1GB -RequireRestrictedAcl -NoBytes
    $operatorArchiveSidecarLock = Open-InputLock $OperatorArchiveSidecarPath $ExpectedOperatorArchiveSidecarSha256 "OPERATOR_ARCHIVE_SIDECAR_INVALID" 512 -RequireRestrictedAcl
    $operatorAttestationLock = Open-InputLock $OperatorAttestationBundlePath $ExpectedOperatorAttestationBundleSha256 "OPERATOR_ATTESTATION_INVALID" 16MB -RequireRestrictedAcl
    $operatorProvenanceLock = Open-InputLock $OperatorProvenancePath $ExpectedOperatorProvenanceSha256 "OPERATOR_PROVENANCE_INVALID" 65536 -RequireRestrictedAcl
    foreach ($inputLock in @($incidentLock, $preflightLock, $promotionLock, $authorizationLock, $operatorManifestLock, $operatorArchiveLock, $operatorArchiveSidecarLock, $operatorAttestationLock, $operatorProvenanceLock)) {
        $locks.Add($inputLock.Stream)
    }
    $expectedArchiveName = "refunddesk-edge-operator-$ExpectedRevision.docker.tar.zst"
    $expectedSidecarName = "$expectedArchiveName.sha256"
    $actualArchiveName = [IO.Path]::GetFileName($operatorArchiveLock.Path)
    $actualSidecarName = [IO.Path]::GetFileName($operatorArchiveSidecarLock.Path)
    $expectedSidecarBytes = [Text.UTF8Encoding]::new($false).GetBytes("$ExpectedOperatorArchiveSha256  $expectedArchiveName`n")
    if ($actualArchiveName -cne $expectedArchiveName -or $actualSidecarName -cne $expectedSidecarName -or
        $operatorArchiveSidecarLock.Bytes.Length -ne $expectedSidecarBytes.Length) {
        Throw-SafeError "OPERATOR_ARCHIVE_SIDECAR_INVALID"
    }
    for ($sidecarByteIndex = 0; $sidecarByteIndex -lt $expectedSidecarBytes.Length; $sidecarByteIndex += 1) {
        if ($operatorArchiveSidecarLock.Bytes[$sidecarByteIndex] -ne $expectedSidecarBytes[$sidecarByteIndex]) {
            Throw-SafeError "OPERATOR_ARCHIVE_SIDECAR_INVALID"
        }
    }
    $script:CredentialsLock = Open-SensitiveLock $AwsCredentialsPath "AWS_CREDENTIALS_ACL_INVALID"
    $script:GitHubTokenLock = Open-SensitiveLock $GitHubTokenPath "GH_TOKEN_ACL_INVALID"
    $script:IdentityLock = Open-SensitiveLock $SshIdentityPath "SSH_IDENTITY_ACL_INVALID"
    $script:KnownHostsLock = Open-SensitiveLock $SshKnownHostsPath "SSH_KNOWN_HOSTS_ACL_INVALID"
    foreach ($sensitiveLock in @($script:CredentialsLock, $script:GitHubTokenLock, $script:IdentityLock, $script:KnownHostsLock)) { $locks.Add($sensitiveLock.Stream) }
    Assert-AllSensitiveLocks

    $attemptInputs = [ordered]@{
        authorizationSha256 = $ExpectedAuthorizationSha256
        incidentSha256 = $ExpectedIncidentEvidenceSha256
        operatorArchiveSha256 = $ExpectedOperatorArchiveSha256
        operatorArchiveSidecarSha256 = $ExpectedOperatorArchiveSidecarSha256
        operatorAttestationSha256 = $ExpectedOperatorAttestationBundleSha256
        operatorManifestSha256 = $ExpectedOperatorManifestSha256
        operatorProvenanceSha256 = $ExpectedOperatorProvenanceSha256
        preflightSha256 = $ExpectedPreflightEvidenceSha256
        promotionSha256 = $ExpectedPromotionEvidenceSha256
        revision = $ExpectedRevision
        sshCidrSha256 = Get-TextSha256 $ExpectedSshCidr
        windowSeconds = $WindowSeconds
    }
    $attemptBindingSha256 = Get-TextSha256 (ConvertTo-CanonicalJson $attemptInputs)
    $attemptMarkerPath = Join-Path $output ("edge-window-attempt-{0}-{1}.local.json" -f $ExpectedRevision, $attemptBindingSha256.Substring(0, 12))
    $attemptLeasePath = "$attemptMarkerPath.lock"
    $locks.Add((Open-AttemptLease $attemptLeasePath $attemptBindingSha256))
    $attemptMarkerInitiallyPresent = [bool] (Test-Path -LiteralPath $attemptMarkerPath)
    if ($attemptMarkerInitiallyPresent) {
        $attemptDiscovery = Read-AttemptMarkerDiscovery $attemptMarkerPath $attemptBindingSha256 $attemptInputs
        $attemptDiscoverySha256 = [string] $attemptDiscovery.Sha256
        $attemptStartedAt = [string] $attemptDiscovery.StartedAt
        $operatorBootIdentifierSha256 = [string] $attemptDiscovery.OperatorBootIdentifierSha256
        $operatorStartedMonotonicMilliseconds = [long] $attemptDiscovery.OperatorStartedMonotonicMilliseconds
        $operatorDeadlineMonotonicMilliseconds = [long] $attemptDiscovery.OperatorDeadlineMonotonicMilliseconds
        $script:FixtureMarkerMonotonicMilliseconds = $operatorStartedMonotonicMilliseconds
        $script:AttemptMarkerCommitted = $true
        $admissionValidationTimestamp = $attemptStartedAt
    }
    else {
        $admissionValidationTimestamp = Get-AdmissionUtcTimestamp
    }

    $githubTokenText = Get-Utf8Text (Read-LockedStreamBytes $script:GitHubTokenLock.Stream 512 "GH_TOKEN_INVALID") "GH_TOKEN_INVALID"
    if ($githubTokenText -notmatch "^(?:github_pat_[A-Za-z0-9_]{20,255}|ghp_[A-Za-z0-9]{20,255})(?:`n)?$") { Throw-SafeError "GH_TOKEN_INVALID" }
    $script:GitHubToken = $githubTokenText.TrimEnd("`n")
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $expectedCredentialPath = [IO.Path]::GetFullPath((Join-Path $userProfile ".aws/credentials"))
    $expectedIdentityPath = [IO.Path]::GetFullPath((Join-Path $repository "sandbox-evidence.local/aws/refunddesk-sandbox-lightsail-rsa"))
    $expectedKnownHostsPath = [IO.Path]::GetFullPath((Join-Path $repository "sandbox-evidence.local/aws/known_hosts.refunddesk-sandbox"))
    if ($script:ProductionContractFixture) {
        $fixturePrefix = $script:FixtureToolRoot.TrimEnd('\') + '\'
        foreach ($fixtureSensitivePath in @(
            $script:CredentialsLock.Path, $script:GitHubTokenLock.Path,
            $script:IdentityLock.Path, $script:KnownHostsLock.Path
        )) {
            if (-not $fixtureSensitivePath.StartsWith($fixturePrefix, [StringComparison]::OrdinalIgnoreCase)) {
                Throw-SafeError "FIXTURE_SENSITIVE_PATH_INVALID"
            }
        }
        if ($AwsProfile -cne "default") { Throw-SafeError "OFFICIAL_POSTFLIGHT_TRANSPORT_MISMATCH" }
    }
    elseif (-not [string]::Equals($script:CredentialsLock.Path, $expectedCredentialPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($script:IdentityLock.Path, $expectedIdentityPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($script:KnownHostsLock.Path, $expectedKnownHostsPath, [StringComparison]::OrdinalIgnoreCase) -or
        (Get-StreamSha256 $script:IdentityLock.Stream "SSH_IDENTITY_INVALID") -cne $ExpectedIdentitySha256 -or
        (Get-StreamSha256 $script:KnownHostsLock.Stream "SSH_KNOWN_HOSTS_INVALID") -cne $ExpectedKnownHostsSha256 -or
        $AwsProfile -cne "default") {
        Throw-SafeError "OFFICIAL_POSTFLIGHT_TRANSPORT_MISMATCH"
    }

    $promotionValidation = Invoke-Node @(
        (Join-Path $repository "scripts/validate-lightsail-contained-promotion.mjs"),
        "--evidence", $promotionLock.Path,
        "--expected-revision", $ExpectedRevision,
        "--expected-nonce", $PromotionNonce,
        "--expected-bundle-sha256", $ExpectedBundleSha256,
        "--expected-manifest-sha256", $ExpectedManifestSha256,
        "--expected-provenance-sha256", $ExpectedPromotionProvenanceSha256,
        "--expected-source-sha256", $ExpectedSourceSha256
    ) $null @(0) 30
    $promotionSummary = ConvertFrom-BoundedJson $promotionValidation.Stdout "PROMOTION_EVIDENCE_INVALID"
    if ($promotionSummary.result -cne "PASS" -or $promotionSummary.code -cne "PASS_CONTAINED_CANDIDATE_PROMOTED") {
        Throw-SafeError "PROMOTION_EVIDENCE_INVALID"
    }
    $promotion = ConvertFrom-BoundedJson $promotionLock.Bytes "PROMOTION_EVIDENCE_INVALID" -RequireCanonical
    if ([string] $promotion.runtime.workerRuntimeMode -cne "incident_admission") {
        Throw-SafeError "PROMOTION_WORKER_MODE_INVALID"
    }

    $incidentValidation = Invoke-Node @(
        (Join-Path $repository "scripts/validate-lightsail-incident-admission.mjs"),
        "--kind", "capture", "--expected-revision", $ExpectedRevision, "--now", $admissionValidationTimestamp,
        "--expected-promotion-bundle-sha256", $ExpectedBundleSha256,
        "--expected-promotion-evidence-sha256", $ExpectedPromotionEvidenceSha256,
        "--expected-promotion-manifest-sha256", $ExpectedManifestSha256,
        "--expected-promotion-provenance-sha256", $ExpectedPromotionProvenanceSha256,
        "--expected-promotion-source-sha256", $ExpectedSourceSha256
    ) $incidentLock.Bytes @(0) 30
    $incident = ConvertFrom-BoundedJson $incidentValidation.Stdout "INCIDENT_EVIDENCE_INVALID"
    if ($incident.result -cne "PASS" -or $incident.code -cne "PASS_INCIDENT_ADMITTED_CONTAINED" -or
        [int] $incident.exitCode -ne 0 -or $incident.admission -cne "ADMISSIBLE_CURRENT_STRIPE_BINDING_INCIDENT" -or
        [int] $incident.remoteDocument.exitCode -ne 0 -or [int] $incident.remote.exitCode -ne 0 -or
        $incident.remote.result -cne "PASS" -or $incident.remote.code -cne "PASS_INCIDENT_ADMITTED_CONTAINED") {
        Throw-SafeError "INCIDENT_EVIDENCE_INVALID"
    }
    $incidentCapture = ConvertFrom-BoundedJson $incidentLock.Bytes "INCIDENT_EVIDENCE_INVALID" -RequireCanonical
    if ($incidentCapture.provenance.promotionEvidenceSha256 -cne $ExpectedPromotionEvidenceSha256 -or
        $incidentCapture.remote.promotion.evidenceSha256 -cne $ExpectedPromotionEvidenceSha256 -or
        $incidentCapture.remote.promotion.bundleSha256 -cne $ExpectedBundleSha256 -or
        $incidentCapture.remote.promotion.manifestSha256 -cne $ExpectedManifestSha256 -or
        $incidentCapture.remote.promotion.provenanceSha256 -cne $ExpectedPromotionProvenanceSha256 -or
        $incidentCapture.remote.promotion.sourceSha256 -cne $ExpectedSourceSha256 -or
        $incidentCapture.remote.promotion.candidateRevision -cne $ExpectedRevision -or
        $incidentCapture.remote.promotion.contained -ne $true -or
        $incidentCapture.remote.promotion.postflightAfterPromotion -ne $true) {
        Throw-SafeError "INCIDENT_PROMOTION_BINDING_INVALID"
    }

    $preflightValidation = Invoke-Node @(
        (Join-Path $repository "scripts/validate-lightsail-incident-admission.mjs"),
        "--kind", "postflight", "--expected-revision", $ExpectedRevision, "--now", $admissionValidationTimestamp
    ) $preflightLock.Bytes @(0) 30
    Assert-ValidatorPass $preflightValidation "PASS_POSTFLIGHT_VALID" "PREFLIGHT_EVIDENCE_INVALID"
    $preflight = ConvertFrom-BoundedJson $preflightLock.Bytes "PREFLIGHT_EVIDENCE_INVALID"
    if ($incidentCapture.finalPostflight.sha256 -cne $ExpectedPreflightEvidenceSha256 -or
        $incidentCapture.finalPostflight.capturedAt -cne [string] $preflight.capturedAt -or
        $incidentCapture.finalPostflight.validUntil -cne [string] $preflight.validUntil -or
        $incidentCapture.finalPostflight.revision -cne $ExpectedRevision -or
        $incidentCapture.finalPostflight.posture -cne "COHERENT_CONTAINED" -or
        $incidentCapture.finalPostflight.workerRuntimeMode -cne "incident_admission" -or
        $incidentCapture.finalPostflight.officialValidation -ne $true -or
        (ConvertTo-CanonicalJson $incidentCapture.finalPostflight.awsControlPlane) -cne (ConvertTo-CanonicalJson $preflight.awsControlPlane) -or
        (ConvertTo-CanonicalJson $incidentCapture.finalPostflight.provenance) -cne (ConvertTo-CanonicalJson $preflight.provenance)) {
        Throw-SafeError "INCIDENT_FINAL_POSTFLIGHT_BINDING_INVALID"
    }
    Assert-ExactProperties $incidentCapture.finalPostflight.candidateBinding @(
        "caddyContainerIdSha256", "postgresContainerIdSha256", "systemIdentifierSha256",
        "verifierContainerIdSha256", "webContainerIdSha256", "workerContainerIdSha256"
    ) "INCIDENT_CANDIDATE_BINDING_INVALID"
    $expectedIncidentCandidateBinding = [ordered]@{
        caddyContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.caddyContainerId)
        postgresContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.postgresContainerId)
        systemIdentifierSha256 = Get-TextSha256 ([string] $promotion.database.systemIdentifier)
        verifierContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.verifierContainerId)
        webContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.webContainerId)
        workerContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.workerContainerId)
    }
    if ((ConvertTo-CanonicalJson $incidentCapture.finalPostflight.candidateBinding) -cne
        (ConvertTo-CanonicalJson $expectedIncidentCandidateBinding)) {
        Throw-SafeError "INCIDENT_CANDIDATE_BINDING_INVALID"
    }
    try {
        $postflightCapturedAtValue = [DateTime]::ParseExact([string] $preflight.capturedAt, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
        $postflightValidUntilValue = [DateTime]::ParseExact([string] $preflight.validUntil, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
        $incidentCapturedAtValue = [DateTime]::ParseExact([string] $incident.capturedAt, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
        $incidentValidUntilValue = [DateTime]::ParseExact([string] $incident.validUntil, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    }
    catch { Throw-SafeError "INCIDENT_POSTFLIGHT_CHRONOLOGY_INVALID" }
    $postflightLifetimeSeconds = ($postflightValidUntilValue - $postflightCapturedAtValue).TotalSeconds
    $incidentLifetimeSeconds = ($incidentValidUntilValue - $incidentCapturedAtValue).TotalSeconds
    if ($postflightCapturedAtValue -gt $incidentCapturedAtValue -or
        $postflightLifetimeSeconds -ne 900 -or
        $incidentLifetimeSeconds -le 0 -or $incidentLifetimeSeconds -gt 900) {
        Throw-SafeError "INCIDENT_POSTFLIGHT_CHRONOLOGY_INVALID"
    }
    $databaseA = $preflight.remote.captures.a.database
    $databaseB = $preflight.remote.captures.b.database
    $expectedPostflightContainerIds = [ordered]@{
        caddy = [string] $promotion.runtime.caddyContainerId
        postgres = [string] $promotion.runtime.postgresContainerId
        verifier = [string] $promotion.runtime.verifierContainerId
        web = [string] $promotion.runtime.webContainerId
        worker = [string] $promotion.runtime.workerContainerId
    }
    foreach ($postflightCapture in @($preflight.remote.captures.a, $preflight.remote.captures.b)) {
        if ($postflightCapture.identity.releaseEnvironmentWorkerRuntimeMode -cne "INCIDENT_ADMISSION" -or
            [string] $postflightCapture.database.systemIdentifier -cne [string] $promotion.database.systemIdentifier -or
            @($postflightCapture.containers).Count -ne 5) {
            Throw-SafeError "POSTFLIGHT_CANDIDATE_BINDING_INVALID"
        }
        $observedPostflightContainerIds = [ordered]@{}
        foreach ($postflightContainer in @($postflightCapture.containers)) {
            $service = [string] $postflightContainer.service
            if (-not $expectedPostflightContainerIds.Contains($service) -or $observedPostflightContainerIds.Contains($service) -or
                [string] $postflightContainer.containerId -cne [string] $expectedPostflightContainerIds[$service]) {
                Throw-SafeError "POSTFLIGHT_CANDIDATE_BINDING_INVALID"
            }
            if ($service -ceq "worker" -and $postflightContainer.effectiveWorkerRuntimeMode -cne "INCIDENT_ADMISSION") {
                Throw-SafeError "POSTFLIGHT_CANDIDATE_BINDING_INVALID"
            }
            $observedPostflightContainerIds[$service] = [string] $postflightContainer.containerId
        }
        if ($observedPostflightContainerIds.Count -ne 5) { Throw-SafeError "POSTFLIGHT_CANDIDATE_BINDING_INVALID" }
    }
    $postIncidentCounts = [ordered]@{
        activeFinancialJobs = [long] $databaseA.activeFinancialJobs
        auditEvents = [long] $databaseA.auditEvents
        mutationReceipts = [long] $databaseA.apiMutationReceipts
        refundExecutionAttempts = [long] $databaseA.refundExecutionAttempts
        refundExecutions = [long] $databaseA.refundExecutions
        refundRequests = [long] $databaseA.refundRequests
        unreleasedPaymentGuards = [long] $databaseA.unreleasedPaymentGuards
        webhookReceipts = [long] $databaseA.webhookReceipts
    }
    $postIncidentBaseline = [ordered]@{
        activeFinancialJobs = $postIncidentCounts.activeFinancialJobs
        auditEvents = $postIncidentCounts.auditEvents
        mutationReceipts = $postIncidentCounts.mutationReceipts
        refundExecutionAttempts = $postIncidentCounts.refundExecutionAttempts
        refundExecutions = $postIncidentCounts.refundExecutions
        refundRequests = $postIncidentCounts.refundRequests
        snapshotSha256 = Get-TextSha256 (ConvertTo-CanonicalJson $postIncidentCounts)
        unreleasedPaymentGuards = $postIncidentCounts.unreleasedPaymentGuards
        webhookReceipts = $postIncidentCounts.webhookReceipts
    }
    if ((ConvertTo-CanonicalJson $databaseA) -cne (ConvertTo-CanonicalJson $databaseB) -or
        (ConvertTo-CanonicalJson $incidentCapture.postIncidentBaseline) -cne (ConvertTo-CanonicalJson $postIncidentBaseline) -or
        (ConvertTo-CanonicalJson $incidentCapture.remote.postIncidentBaseline) -cne (ConvertTo-CanonicalJson $postIncidentBaseline) -or
        $incidentCapture.finalPostflight.postIncidentBaselineSha256 -cne $postIncidentBaseline.snapshotSha256) {
        Throw-SafeError "POST_INCIDENT_BASELINE_MISMATCH"
    }

    $script:Authorization = ConvertFrom-BoundedJson $authorizationLock.Bytes "AUTHORIZATION_INVALID" -RequireCanonical
    Assert-ExactProperties $script:Authorization @(
        "awsAccountId", "awsRegion", "code", "distributionId", "eventFingerprintSha256",
        "expectedRevision", "expectedSshCidr", "instanceName", "kind", "maxWindowSeconds", "originId",
        "publicBaseUrl", "result", "schemaVersion", "sourceRef", "sshHost", "validFrom", "validUntil"
    ) "AUTHORIZATION_INVALID"
    foreach ($authorizationStringField in @(
        "awsAccountId", "awsRegion", "code", "distributionId", "eventFingerprintSha256",
        "expectedRevision", "expectedSshCidr", "instanceName", "kind", "originId", "publicBaseUrl",
        "result", "sourceRef", "sshHost", "validFrom", "validUntil"
    )) {
        if ($script:Authorization.$authorizationStringField -isnot [string]) { Throw-SafeError "AUTHORIZATION_INVALID" }
    }
    $authorizationWindowIsInteger = ($script:Authorization.maxWindowSeconds -is [int] -or $script:Authorization.maxWindowSeconds -is [long])
    if (($script:Authorization.schemaVersion -isnot [int] -and $script:Authorization.schemaVersion -isnot [long]) -or
        [long] $script:Authorization.schemaVersion -ne 1 -or -not $authorizationWindowIsInteger -or
        $script:Authorization.kind -isnot [string] -or $script:Authorization.kind -cne "refunddesk.edge-window.authorization" -or
        $script:Authorization.result -cne "PASS" -or $script:Authorization.code -cne "PASS_EDGE_WINDOW_AUTHORIZED" -or
        $script:Authorization.expectedRevision -cne $ExpectedRevision -or
        $script:Authorization.awsAccountId -cne "633229204288" -or $script:Authorization.awsRegion -cne "eu-west-3" -or
        $script:Authorization.expectedSshCidr -cne $ExpectedSshCidr -or
        $script:Authorization.instanceName -cne "refunddesk-sandbox-paris" -or
        $script:Authorization.eventFingerprintSha256 -notmatch "^[0-9a-f]{64}$" -or
        $script:Authorization.distributionId -notmatch "^[A-Z0-9]{8,32}$" -or
        $script:Authorization.originId -notmatch "^[A-Za-z0-9._-]{1,128}$" -or
        $script:Authorization.publicBaseUrl -notmatch "^https://[A-Za-z0-9.-]+$" -or
        $script:Authorization.sourceRef -notmatch "^refs/heads/(?:main|release/sandbox-edge-[0-9]{4}-[0-9]{2}-[0-9]{2})$" -or
        $script:Authorization.sshHost -notmatch "^[A-Za-z0-9.-]+$" -or
        [long] $script:Authorization.maxWindowSeconds -lt $WindowSeconds -or [long] $script:Authorization.maxWindowSeconds -gt 300) { Throw-SafeError "AUTHORIZATION_INVALID" }
    if ($source.symbolicRef -cne [string] $script:Authorization.sourceRef) { Throw-SafeError "AUTHORIZATION_SOURCE_REF_MISMATCH" }
    $authorizationFrom = [DateTime]::ParseExact([string] $script:Authorization.validFrom, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    $authorizationUntil = [DateTime]::ParseExact([string] $script:Authorization.validUntil, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    if ($authorizationUntil -le $authorizationFrom -or ($authorizationUntil - $authorizationFrom).TotalSeconds -gt 7200) {
        Throw-SafeError "AUTHORIZATION_WINDOW_INVALID"
    }
    [void] (Assert-AttemptAdmissionWindow $admissionValidationTimestamp $postflightValidUntilValue $incidentCapturedAtValue $incidentValidUntilValue $authorizationFrom $authorizationUntil)

    $operatorManifest = ConvertFrom-BoundedJson $operatorManifestLock.Bytes "OPERATOR_MANIFEST_INVALID" -RequireCanonical
    Assert-ExactProperties $operatorManifest.archive @("file", "sha256", "sizeBytes") "OPERATOR_MANIFEST_INVALID"
    if ($operatorManifest.archive.file -isnot [string] -or $operatorManifest.archive.file -cne $expectedArchiveName -or
        $operatorManifest.archive.sha256 -isnot [string] -or $operatorManifest.archive.sha256 -cne $ExpectedOperatorArchiveSha256 -or
        ($operatorManifest.archive.sizeBytes -isnot [int] -and $operatorManifest.archive.sizeBytes -isnot [long]) -or
        [long] $operatorManifest.archive.sizeBytes -ne $operatorArchiveLock.Stream.Length) {
        Throw-SafeError "OPERATOR_MANIFEST_INVALID"
    }
    Assert-SourceProvenance $repository $source
    $operatorValidation = Invoke-Node @(
        (Join-Path $repository "scripts/validate-edge-operator-image.mjs"),
        "--archive", $operatorArchiveLock.Path,
        "--expected-archive-sha256", $ExpectedOperatorArchiveSha256,
        "--expected-manifest-sha256", $ExpectedOperatorManifestSha256,
        "--expected-revision", $ExpectedRevision,
        "--manifest", $operatorManifestLock.Path,
        "--repository", $repository
    ) $null @(0) 120
    Assert-ValidatorPass $operatorValidation "PASS_EDGE_OPERATOR_IMAGE_VALID" "OPERATOR_MANIFEST_INVALID"

    $operatorProvenance = ConvertFrom-BoundedJson $operatorProvenanceLock.Bytes "OPERATOR_PROVENANCE_INVALID" -RequireCanonical
    Assert-ExactProperties $operatorProvenance @(
        "archiveSha256", "attestationBundleSha256", "createdAt", "kind",
        "manifestSha256", "rekorEntryIndex", "repository", "revision", "schemaVersion",
        "sourceRef", "verification", "workflowPath", "workflowRunAttempt", "workflowRunId"
    ) "OPERATOR_PROVENANCE_INVALID"
    foreach ($operatorProvenanceStringField in @(
        "archiveSha256", "attestationBundleSha256", "createdAt", "kind", "manifestSha256",
        "repository", "revision", "sourceRef", "verification", "workflowPath"
    )) {
        if ($operatorProvenance.$operatorProvenanceStringField -isnot [string]) {
            Throw-SafeError "OPERATOR_PROVENANCE_INVALID"
        }
    }
    foreach ($operatorProvenanceIntegerField in @("schemaVersion", "rekorEntryIndex", "workflowRunAttempt", "workflowRunId")) {
        if ($operatorProvenance.$operatorProvenanceIntegerField -isnot [int] -and
            $operatorProvenance.$operatorProvenanceIntegerField -isnot [long]) {
            Throw-SafeError "OPERATOR_PROVENANCE_INVALID"
        }
    }
    try {
        [void] [DateTime]::ParseExact([string] $operatorProvenance.createdAt, "yyyy-MM-ddTHH:mm:ssZ",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    }
    catch { Throw-SafeError "OPERATOR_PROVENANCE_INVALID" }
    if ([long] $operatorProvenance.schemaVersion -ne 1 -or $operatorProvenance.kind -cne "refunddesk-edge-operator-input-provenance" -or
        $operatorProvenance.repository -cne $RepositoryName -or $operatorProvenance.revision -cne $ExpectedRevision -or
        $operatorProvenance.archiveSha256 -cne $ExpectedOperatorArchiveSha256 -or
        $operatorProvenance.manifestSha256 -cne $ExpectedOperatorManifestSha256 -or
        $operatorProvenance.attestationBundleSha256 -cne $ExpectedOperatorAttestationBundleSha256 -or
        $operatorProvenance.workflowPath -cne ".github/workflows/sandbox-images.yml" -or
        $operatorProvenance.sourceRef -cne $script:Authorization.sourceRef -or
        $operatorProvenance.verification -cne "github-actions-attestation-bundle-issued" -or
        $operatorProvenance.createdAt -notmatch "^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" -or
        [long] $operatorProvenance.workflowRunId -le 0 -or [long] $operatorProvenance.workflowRunAttempt -le 0 -or
        [long] $operatorProvenance.rekorEntryIndex -le 0) {
        Throw-SafeError "OPERATOR_PROVENANCE_INVALID"
    }
    $ghVerificationResult = Invoke-Gh @(
        "attestation", "verify", $operatorArchiveLock.Path,
        "--bundle", $operatorAttestationLock.Path,
        "--repo", $RepositoryName,
        "--signer-workflow", "selimhehe1/RefundDesk/.github/workflows/sandbox-images.yml",
        "--source-digest", $ExpectedRevision,
        "--source-ref", ([string] $script:Authorization.sourceRef),
        "--deny-self-hosted-runners",
        "--digest-alg", "sha256",
        "--predicate-type", "https://slsa.dev/provenance/v1",
        "--format", "json"
    ) 120
    try { $ghVerification = Get-ProcessText $ghVerificationResult "OPERATOR_ATTESTATION_INVALID" | ConvertFrom-Json }
    catch { Throw-SafeError "OPERATOR_ATTESTATION_INVALID" }
    if (@($ghVerification).Count -ne 1) { Throw-SafeError "OPERATOR_ATTESTATION_INVALID" }
    $verifiedEntry = @($ghVerification)[0]
    Assert-ExactProperties $verifiedEntry @("attestation", "verificationResult") "OPERATOR_ATTESTATION_INVALID"
    $statement = $verifiedEntry.verificationResult.statement
    $subjects = @($statement.subject)
    if ($statement.predicateType -cne "https://slsa.dev/provenance/v1" -or $subjects.Count -ne 1 -or
        $subjects[0].name -cne $expectedArchiveName -or $subjects[0].digest.sha256 -cne $ExpectedOperatorArchiveSha256) {
        Throw-SafeError "OPERATOR_ATTESTATION_INVALID"
    }
    $invocationId = [string] $statement.predicate.runDetails.metadata.invocationId
    if ($invocationId -notmatch ("^https://github\.com/selimhehe1/RefundDesk/actions/runs/{0}/attempts/([1-9][0-9]*)$" -f [long] $operatorProvenance.workflowRunId)) {
        Throw-SafeError "OPERATOR_ATTESTATION_INVALID"
    }
    $signedRunAttempt = [long] $Matches[1]
    if ($signedRunAttempt -ne [long] $operatorProvenance.workflowRunAttempt) {
        Throw-SafeError "OPERATOR_ATTESTATION_INVALID"
    }
    $tlogEntries = @($verifiedEntry.attestation.verificationMaterial.tlogEntries)
    if ($tlogEntries.Count -ne 1 -or [long] $tlogEntries[0].logIndex -ne [long] $operatorProvenance.rekorEntryIndex -or
        @($verifiedEntry.verificationResult.verifiedTimestamps).Count -lt 1) {
        Throw-SafeError "OPERATOR_ATTESTATION_INVALID"
    }
    $workflowRunResult = Invoke-Gh @(
        "api", "--method", "GET", "repos/$RepositoryName/actions/runs/$([long] $operatorProvenance.workflowRunId)",
        "--jq", '{conclusion:.conclusion,event:.event,headBranch:.head_branch,headSha:.head_sha,path:.path,repository:.repository.full_name,runAttempt:.run_attempt,status:.status,workflowId:.workflow_id}'
    ) 60
    try { $workflowRun = (Get-ProcessText $workflowRunResult "OPERATOR_WORKFLOW_RUN_INVALID").Trim() | ConvertFrom-Json }
    catch { Throw-SafeError "OPERATOR_WORKFLOW_RUN_INVALID" }
    Assert-ExactProperties $workflowRun @("conclusion", "event", "headBranch", "headSha", "path", "repository", "runAttempt", "status", "workflowId") "OPERATOR_WORKFLOW_RUN_INVALID"
    $expectedBranch = ([string] $script:Authorization.sourceRef).Substring("refs/heads/".Length)
    if ($workflowRun.status -cne "completed" -or $workflowRun.conclusion -cne "success" -or
        $workflowRun.event -cne "workflow_dispatch" -or $workflowRun.headSha -cne $ExpectedRevision -or
        $workflowRun.headBranch -cne $expectedBranch -or $workflowRun.repository -cne $RepositoryName -or
        $workflowRun.path -cne ".github/workflows/sandbox-images.yml" -or
        [long] $workflowRun.runAttempt -ne $signedRunAttempt -or
        [long] $workflowRun.runAttempt -ne [long] $operatorProvenance.workflowRunAttempt -or
        [long] $workflowRun.workflowId -lt 1) {
        Throw-SafeError "OPERATOR_WORKFLOW_RUN_INVALID"
    }
    $workflowRunObservationSha256 = Get-TextSha256 (ConvertTo-CanonicalJson $workflowRun)

    if ($attemptMarkerInitiallyPresent) {
        $attemptRecheck = Read-AttemptMarkerDiscovery $attemptMarkerPath $attemptBindingSha256 $attemptInputs
        if ([string] $attemptRecheck.Sha256 -cne $attemptDiscoverySha256) { Throw-SafeError "ATTEMPT_MARKER_INVALID" }
        $attempt = $attemptRecheck.Document
        Assert-ExactProperties $attempt @(
            "bindingSha256", "completedAt", "containerName", "evidenceFile", "evidenceSha256",
            "imageCreatedByAttempt", "imageId", "imageLoadAttempted", "imagePreexisting", "immutableInputs", "inputVolume", "inputs", "kind",
            "localCleanupComplete", "nonce", "operatorBootIdentifierSha256", "operatorClockInvalidated",
            "operatorDeadlineMonotonicMilliseconds", "operatorStartedMonotonicMilliseconds", "schemaVersion", "startedAt", "state", "volume"
        ) "ATTEMPT_MARKER_INVALID"
        Assert-ExactProperties $attempt.immutableInputs @("awsConfigSha256", "controlSha256", "sshConfigSha256", "transportSha256") "ATTEMPT_MARKER_INVALID"
        $immutableDigestValues = @(
            $attempt.immutableInputs.awsConfigSha256,
            $attempt.immutableInputs.controlSha256,
            $attempt.immutableInputs.sshConfigSha256,
            $attempt.immutableInputs.transportSha256
        )
        $immutableInputsCommitted = @($immutableDigestValues | Where-Object { $_ -is [string] -and $_ -cmatch "^[0-9a-f]{64}$" }).Count -eq 4
        $immutableInputsEmpty = @($immutableDigestValues | Where-Object { $null -eq $_ }).Count -eq 4
        if ($attempt.schemaVersion -ne 1 -or $attempt.kind -cne "refunddesk.edge-window-local-attempt" -or
            $attempt.bindingSha256 -cne $attemptBindingSha256 -or
            (ConvertTo-CanonicalJson $attempt.inputs) -cne (ConvertTo-CanonicalJson $attemptInputs) -or
            $attempt.imageId -cne [string] $operatorManifest.image.id -or
            $attempt.nonce -notmatch "^[0-9a-f]{64}$" -or
            $attempt.volume -cne ("refunddesk-edge-window-{0}" -f ([string] $attempt.nonce).Substring(0, 12)) -or
            $attempt.inputVolume -cne ("refunddesk-edge-input-{0}" -f ([string] $attempt.nonce).Substring(0, 12)) -or
            $attempt.containerName -cne ("refunddesk-edge-window-{0}" -f ([string] $attempt.nonce).Substring(0, 12)) -or
            $attempt.imageCreatedByAttempt -isnot [bool] -or $attempt.imageLoadAttempted -isnot [bool] -or
            ($null -ne $attempt.imagePreexisting -and $attempt.imagePreexisting -isnot [bool]) -or
            ($attempt.imageCreatedByAttempt -and ($attempt.imagePreexisting -ne $false -or -not $attempt.imageLoadAttempted)) -or
            $attempt.localCleanupComplete -isnot [bool] -or
            (-not $immutableInputsCommitted -and -not $immutableInputsEmpty) -or
            ($attempt.state -ne "prepared" -and -not $immutableInputsCommitted) -or
            $attempt.state -notin @("prepared", "finalizing", "cleanup_required", "cleanup_complete", "complete")) {
            Throw-SafeError "ATTEMPT_MARKER_INVALID"
        }
        if ($attempt.state -eq "prepared" -and -not [bool] $attempt.operatorClockInvalidated) {
            $resumeOperatorBudget = Get-OperatorBudgetSnapshot ([string] $attempt.operatorBootIdentifierSha256) ([long] $attempt.operatorDeadlineMonotonicMilliseconds)
            if (-not $resumeOperatorBudget.SameBoot -or [long] $resumeOperatorBudget.RemainingMilliseconds -le 0) {
                Set-OperatorClockInvalidated $attempt $attemptMarkerPath
            }
        }
        if ($attempt.state -eq "prepared") {
            if ($null -ne $attempt.completedAt -or $null -ne $attempt.evidenceFile -or $null -ne $attempt.evidenceSha256 -or $attempt.localCleanupComplete) {
                Throw-SafeError "ATTEMPT_MARKER_INVALID"
            }
            $orphanEvidenceName = "edge-window-$ExpectedRevision-$(([string] $attempt.nonce).Substring(0, 12)).local.json"
            $orphanEvidencePath = Join-Path $output $orphanEvidenceName
            if ($immutableInputsEmpty) {
                # No runner can be created until all four immutable input
                # digests are durable.  A crash in this interval is therefore
                # cleanup-only and must never infer input contents or accept
                # terminal evidence.
                if ((Test-Path -LiteralPath $orphanEvidencePath) -and -not [bool] $attempt.operatorClockInvalidated) {
                    Throw-SafeError "ATTEMPT_MARKER_INVALID"
                }
                $resumingUncommittedPrepared = $true
            }
            elseif ((Test-Path -LiteralPath $orphanEvidencePath) -and -not [bool] $attempt.operatorClockInvalidated) {
                $orphanEvidenceLock = Open-InputLock $orphanEvidencePath (Get-FileSha256 $orphanEvidencePath) "ATTEMPT_EVIDENCE_INVALID" $MaximumEvidenceBytes -RequireRestrictedAcl
                $locks.Add($orphanEvidenceLock.Stream)
                $orphanEvidence = ConvertFrom-BoundedJson $orphanEvidenceLock.Bytes "ATTEMPT_EVIDENCE_INVALID" -RequireCanonical
                $orphanExitCode = [int] $orphanEvidence.exitCode
                Assert-EdgeTerminalIdentity $orphanEvidence $orphanExitCode ([string] $attempt.nonce) "ATTEMPT_EVIDENCE_INVALID"
                $orphanValidationArguments = @(
                    (Join-Path $repository "scripts/validate-lightsail-edge-window.mjs"),
                    $orphanEvidenceLock.Path, (Join-Path $repository "docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json"),
                    [string] $attempt.nonce, $ExpectedRevision, ([string] $orphanExitCode), [string] $orphanEvidence.startedAt, [string] $orphanEvidence.completedAt
                )
                if ($script:ProductionContractFixture) { $orphanValidationArguments += "fixture" }
                $orphanValidation = Invoke-Node $orphanValidationArguments $null @(0) 30
                if ((Get-ProcessText $orphanValidation "ATTEMPT_EVIDENCE_INVALID").Trim() -cne "PASS_EDGE_WINDOW_RECONTAINED") {
                    Throw-SafeError "ATTEMPT_EVIDENCE_INVALID"
                }
                $attempt.completedAt = Get-UtcTimestamp
                $attempt.evidenceFile = $orphanEvidenceName
                $attempt.evidenceSha256 = Get-StreamSha256 $orphanEvidenceLock.Stream "ATTEMPT_EVIDENCE_INVALID"
                $attempt.state = if (Test-EdgeTerminalIsSafelyContained $orphanEvidence) { "finalizing" } else { "cleanup_required" }
                Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attempt -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
                if ($attempt.state -eq "finalizing") { $resumingFinalizing = $true }
                else { $resumingPrepared = $true }
            }
            else { $resumingPrepared = $true }
        }
        elseif ($attempt.state -eq "cleanup_complete") {
            if ($attempt.completedAt -notmatch "^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" -or
                $null -ne $attempt.evidenceFile -or $null -ne $attempt.evidenceSha256 -or -not $attempt.localCleanupComplete) {
                Throw-SafeError "ATTEMPT_MARKER_INVALID"
            }
            Assert-SourceProvenance $repository $source
            $operationSucceeded = $true
            $exitCode = 21
            [Console]::Error.WriteLine("edge-window-wrapper-error:ATTEMPT_CLEANUP_COMPLETE_NO_REOPEN")
            exit 21
        }
        else {
            if ($attempt.completedAt -notmatch "^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" -or
            $attempt.evidenceSha256 -notmatch "^[0-9a-f]{64}$" -or
            $attempt.evidenceFile -notmatch "^edge-window-[0-9a-f]{40}-[0-9a-f]{12}\.local\.json$") {
                Throw-SafeError "ATTEMPT_MARKER_INVALID"
            }
            if (($attempt.state -in @("finalizing", "cleanup_required") -and $attempt.localCleanupComplete) -or
                ($attempt.state -eq "complete" -and -not $attempt.localCleanupComplete)) { Throw-SafeError "ATTEMPT_MARKER_INVALID" }
        }
        if ($attempt.state -in @("finalizing", "cleanup_required", "complete")) {
            $consumedEvidencePath = Join-Path $output ([string] $attempt.evidenceFile)
            $consumedEvidenceLock = Open-InputLock $consumedEvidencePath ([string] $attempt.evidenceSha256) "ATTEMPT_EVIDENCE_INVALID" $MaximumEvidenceBytes -RequireRestrictedAcl
            $locks.Add($consumedEvidenceLock.Stream)
            $consumedEvidence = ConvertFrom-BoundedJson $consumedEvidenceLock.Bytes "ATTEMPT_EVIDENCE_INVALID" -RequireCanonical
            $consumedExitCode = [int] $consumedEvidence.exitCode
            Assert-EdgeTerminalIdentity $consumedEvidence $consumedExitCode ([string] $attempt.nonce) "ATTEMPT_EVIDENCE_INVALID"
            $consumedValidationArguments = @(
                (Join-Path $repository "scripts/validate-lightsail-edge-window.mjs"),
                $consumedEvidenceLock.Path, (Join-Path $repository "docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json"),
                [string] $attempt.nonce, $ExpectedRevision, ([string] $consumedExitCode),
                [string] $consumedEvidence.startedAt, [string] $consumedEvidence.completedAt
            )
            if ($script:ProductionContractFixture) { $consumedValidationArguments += "fixture" }
            $consumedValidation = Invoke-Node $consumedValidationArguments $null @(0) 30
            if ((Get-ProcessText $consumedValidation "ATTEMPT_EVIDENCE_INVALID").Trim() -cne "PASS_EDGE_WINDOW_RECONTAINED") {
                Throw-SafeError "ATTEMPT_EVIDENCE_INVALID"
            }
        }
        if ($attempt.state -eq "complete") {
            Assert-SourceProvenance $repository $source
            $operationSucceeded = $true
            $exitCode = $consumedExitCode
            [Console]::Out.WriteLine([string] $attempt.evidenceFile)
            exit $consumedExitCode
        }
        if ($attempt.state -eq "finalizing") { $resumingFinalizing = $true }
        if ($attempt.state -eq "cleanup_required") { $resumingPrepared = $true }
        $attemptRecord = $attempt
        $nonce = [string] $attempt.nonce
        $attemptStartedAt = [string] $attempt.startedAt
        $operatorBootIdentifierSha256 = [string] $attempt.operatorBootIdentifierSha256
        $operatorStartedMonotonicMilliseconds = [long] $attempt.operatorStartedMonotonicMilliseconds
        $operatorDeadlineMonotonicMilliseconds = [long] $attempt.operatorDeadlineMonotonicMilliseconds
        $volume = [string] $attempt.volume
        $inputVolume = [string] $attempt.inputVolume
        $immutableInputs = $attempt.immutableInputs
        $containerName = [string] $attempt.containerName
    }
    else {
        if ($checkpointPreexisting) { Throw-SafeError "WORKBENCH_MUST_BE_ABSENT" }
        $nonce = New-Nonce
        $operatorStartClock = Get-OperatorClockSnapshot
        $operatorBootIdentifierSha256 = [string] $operatorStartClock.BootIdentifierSha256
        $operatorStartedMonotonicMilliseconds = [long] $operatorStartClock.MonotonicMilliseconds
        if ($operatorStartedMonotonicMilliseconds -gt ($MaximumJsonSafeInteger - $SuccessfulExecutionSeconds * 1000)) {
            Throw-SafeError "OPERATOR_CLOCK_INVALID"
        }
        $operatorDeadlineMonotonicMilliseconds = [long] ($operatorStartedMonotonicMilliseconds + $SuccessfulExecutionSeconds * 1000)
        $attemptStartedAt = Get-AdmissionUtcTimestamp
        $volume = "refunddesk-edge-window-$($nonce.Substring(0, 12))"
        $inputVolume = "refunddesk-edge-input-$($nonce.Substring(0, 12))"
        $containerName = "refunddesk-edge-window-$($nonce.Substring(0, 12))"

        # Expensive local provenance, image and workflow checks have completed.
        # Re-run the two locked point-in-time validators against the exact value
        # that is about to become durable; never refresh or substitute their bytes.
        $freshIncidentValidation = Invoke-Node @(
            (Join-Path $repository "scripts/validate-lightsail-incident-admission.mjs"),
            "--kind", "capture", "--expected-revision", $ExpectedRevision, "--now", $attemptStartedAt,
            "--expected-promotion-bundle-sha256", $ExpectedBundleSha256,
            "--expected-promotion-evidence-sha256", $ExpectedPromotionEvidenceSha256,
            "--expected-promotion-manifest-sha256", $ExpectedManifestSha256,
            "--expected-promotion-provenance-sha256", $ExpectedPromotionProvenanceSha256,
            "--expected-promotion-source-sha256", $ExpectedSourceSha256
        ) $incidentLock.Bytes @(0) 30
        $freshIncident = ConvertFrom-BoundedJson $freshIncidentValidation.Stdout "INCIDENT_EVIDENCE_INVALID"
        if ($freshIncident.result -cne "PASS" -or $freshIncident.code -cne "PASS_INCIDENT_ADMITTED_CONTAINED" -or
            [int] $freshIncident.exitCode -ne 0 -or $freshIncident.admission -cne "ADMISSIBLE_CURRENT_STRIPE_BINDING_INCIDENT" -or
            [int] $freshIncident.remoteDocument.exitCode -ne 0 -or [int] $freshIncident.remote.exitCode -ne 0 -or
            $freshIncident.remote.result -cne "PASS" -or $freshIncident.remote.code -cne "PASS_INCIDENT_ADMITTED_CONTAINED") {
            Throw-SafeError "INCIDENT_EVIDENCE_INVALID"
        }
        $freshPreflightValidation = Invoke-Node @(
            (Join-Path $repository "scripts/validate-lightsail-incident-admission.mjs"),
            "--kind", "postflight", "--expected-revision", $ExpectedRevision, "--now", $attemptStartedAt
        ) $preflightLock.Bytes @(0) 30
        Assert-ValidatorPass $freshPreflightValidation "PASS_POSTFLIGHT_VALID" "PREFLIGHT_EVIDENCE_INVALID"
        $freshAdmissionWindow = Assert-AttemptAdmissionWindow $attemptStartedAt $postflightValidUntilValue $incidentCapturedAtValue $incidentValidUntilValue $authorizationFrom $authorizationUntil
        $postflightRemaining = [int] $freshAdmissionWindow.PostflightRemaining
        $incidentRemaining = [int] $freshAdmissionWindow.IncidentRemaining
        $attemptPrepared = [ordered]@{
            bindingSha256 = $attemptBindingSha256
            completedAt = $null
            containerName = $containerName
            evidenceFile = $null
            evidenceSha256 = $null
            imageCreatedByAttempt = $false
            imageId = [string] $operatorManifest.image.id
            imageLoadAttempted = $false
            imagePreexisting = $null
            immutableInputs = [ordered]@{
                awsConfigSha256 = $null
                controlSha256 = $null
                sshConfigSha256 = $null
                transportSha256 = $null
            }
            inputVolume = $inputVolume
            inputs = $attemptInputs
            kind = "refunddesk.edge-window-local-attempt"
            localCleanupComplete = $false
            nonce = $nonce
            operatorBootIdentifierSha256 = $operatorBootIdentifierSha256
            operatorClockInvalidated = $false
            operatorDeadlineMonotonicMilliseconds = $operatorDeadlineMonotonicMilliseconds
            operatorStartedMonotonicMilliseconds = $operatorStartedMonotonicMilliseconds
            schemaVersion = 1
            startedAt = $attemptStartedAt
            state = "prepared"
            volume = $volume
        }
        $attemptRecord = $attemptPrepared
        Write-CreateNew $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptPrepared -Newline)))
        $script:FixtureMarkerMonotonicMilliseconds = $operatorStartedMonotonicMilliseconds
        $script:AttemptMarkerCommitted = $true
        if ($script:ProductionContractFixture -and $FixtureCrashAfter -ceq "after_attempt_marker") { exit 99 }
    }

    $admissionWindow = Assert-AttemptAdmissionWindow $attemptStartedAt $postflightValidUntilValue $incidentCapturedAtValue $incidentValidUntilValue $authorizationFrom $authorizationUntil
    $attemptStartedAtValue = [DateTime] $admissionWindow.StartedAt
    $attemptDeadlineValue = [DateTime] $admissionWindow.Deadline
    $postflightRemaining = [int] $admissionWindow.PostflightRemaining
    $incidentRemaining = [int] $admissionWindow.IncidentRemaining

    Assert-SourceProvenance $repository $source
    Assert-AllSensitiveLocks
    if (-not $attemptMarkerInitiallyPresent) {
        $initialOperatorBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
        if (-not $initialOperatorBudget.SameBoot -or [long] $initialOperatorBudget.RemainingMilliseconds -le 0) {
            Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath
            $resumingUncommittedPrepared = $true
        }
    }
    $dockerVersion = (Get-ProcessText (Invoke-Docker @("version", "--format", "{{.Server.Version}}") $null @(0) 30 4096) "DOCKER_VERSION_INVALID").Trim()
    if ($dockerVersion -notmatch "^29\.") { Throw-SafeError "DOCKER_ZSTD_LOAD_UNSUPPORTED" }
    $dockerInfoText = Get-ProcessText (Invoke-Docker @("info", "--format", "{{json .}}") $null @(0) 30 1MB) "DOCKER_DAEMON_INVALID"
    try { $dockerInfo = $dockerInfoText.Trim() | ConvertFrom-Json }
    catch { Throw-SafeError "DOCKER_DAEMON_INVALID" }
    if ($dockerInfo.OSType -cne "linux" -or
        [string] $dockerInfo.Architecture -notmatch "^(?:amd64|x86_64)$" -or
        [string] $dockerInfo.OperatingSystem -notmatch "^Docker Desktop(?: |$)" -or
        [string] $dockerInfo.Name -cne "docker-desktop") {
        Throw-SafeError "DOCKER_DAEMON_INVALID"
    }
    $imageId = [string] $operatorManifest.image.id
    if ($resumingUncommittedPrepared) {
        # The durable marker proves that container creation was unreachable:
        # immutable input digests are committed immediately before the first
        # container create. Refuse any container, validate both volume label
        # identities before mutating either, then remove only those exact local
        # objects. This branch precedes image inspection/loading so a crash
        # immediately after marker creation cannot create any Docker object on
        # replay merely to prove that no object exists.
        $uncommittedContainer = Invoke-Docker @("container", "inspect", $containerName) $null @(0, 1) 30 4096
        if ($uncommittedContainer.ExitCode -ne 1) { Throw-SafeError "ATTEMPT_UNCOMMITTED_CONTAINER_PRESENT" }
        $uncommittedStateVolume = Invoke-Docker @("volume", "inspect", $volume) $null @(0, 1) 30 65536
        $uncommittedInputVolume = Invoke-Docker @("volume", "inspect", $inputVolume) $null @(0, 1) 30 65536
        if ($uncommittedStateVolume.ExitCode -eq 0) {
            $stateVolumeInspection = @((Get-ProcessText $uncommittedStateVolume "ATTEMPT_VOLUME_INVALID") | ConvertFrom-Json)
            if ($stateVolumeInspection.Count -ne 1 -or $stateVolumeInspection[0].Name -cne $volume -or
                $stateVolumeInspection[0].Driver -cne "local" -or $stateVolumeInspection[0].Scope -cne "local") {
                Throw-SafeError "ATTEMPT_VOLUME_INVALID"
            }
            Assert-ExactProperties $stateVolumeInspection[0].Labels @(
                "com.refunddesk.edge-window-nonce", "com.refunddesk.revision"
            ) "ATTEMPT_VOLUME_INVALID"
            if ($stateVolumeInspection[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
                $stateVolumeInspection[0].Labels."com.refunddesk.edge-window-nonce" -cne $nonce) {
                Throw-SafeError "ATTEMPT_VOLUME_INVALID"
            }
        }
        if ($uncommittedInputVolume.ExitCode -eq 0) {
            $inputVolumeInspection = @((Get-ProcessText $uncommittedInputVolume "ATTEMPT_INPUT_VOLUME_INVALID") | ConvertFrom-Json)
            if ($inputVolumeInspection.Count -ne 1 -or $inputVolumeInspection[0].Name -cne $inputVolume -or
                $inputVolumeInspection[0].Driver -cne "local" -or $inputVolumeInspection[0].Scope -cne "local") {
                Throw-SafeError "ATTEMPT_INPUT_VOLUME_INVALID"
            }
            Assert-ExactProperties $inputVolumeInspection[0].Labels @(
                "com.refunddesk.edge-window-input", "com.refunddesk.edge-window-nonce", "com.refunddesk.revision"
            ) "ATTEMPT_INPUT_VOLUME_INVALID"
            if ($inputVolumeInspection[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
                $inputVolumeInspection[0].Labels."com.refunddesk.edge-window-nonce" -cne $nonce -or
                $inputVolumeInspection[0].Labels."com.refunddesk.edge-window-input" -cne "true") {
                Throw-SafeError "ATTEMPT_INPUT_VOLUME_INVALID"
            }
        }
        if ($uncommittedInputVolume.ExitCode -eq 0) {
            [void] (Invoke-Docker @("volume", "rm", $inputVolume) $null @(0) 30 4096)
        }
        if ($uncommittedStateVolume.ExitCode -eq 0) {
            [void] (Invoke-Docker @("volume", "rm", $volume) $null @(0) 30 4096)
        }
        if ((Invoke-Docker @("container", "inspect", $containerName) $null @(0, 1) 30 4096).ExitCode -ne 1 -or
            (Invoke-Docker @("volume", "inspect", $volume) $null @(0, 1) 30 4096).ExitCode -ne 1 -or
            (Invoke-Docker @("volume", "inspect", $inputVolume) $null @(0, 1) 30 4096).ExitCode -ne 1) {
            Throw-SafeError "ATTEMPT_UNCOMMITTED_CLEANUP_AMBIGUOUS"
        }
        $uncommittedImageMayBelongToAttempt = [bool] $attemptRecord.imageCreatedByAttempt -or
            ($attemptRecord.imagePreexisting -eq $false -and [bool] $attemptRecord.imageLoadAttempted)
        if ($uncommittedImageMayBelongToAttempt -and
            (Invoke-Docker @("image", "inspect", $imageId) $null @(0, 1) 30 4096).ExitCode -eq 0) {
            [void] (Invoke-Docker @("image", "rm", $imageId) $null @(0) 60 4096)
        }
        $attemptRecord.completedAt = Get-UtcTimestamp
        $attemptRecord.localCleanupComplete = $true
        $attemptRecord.state = "cleanup_complete"
        Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
        Assert-SourceProvenance $repository $source
        $operationSucceeded = $true
        $exitCode = 21
        [Console]::Error.WriteLine("edge-window-wrapper-error:ATTEMPT_CLEANUP_COMPLETE_NO_REOPEN")
        exit 21
    }
    $imageInspectionBefore = Invoke-Docker @("image", "inspect", $imageId) $null @(0, 1) 30 4096
    $preexistingImage = $imageInspectionBefore.ExitCode -eq 0
    if ($null -eq $attemptRecord.imagePreexisting) {
        $attemptRecord.imagePreexisting = [bool] $preexistingImage
        Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
    }
    elseif ([bool] $attemptRecord.imagePreexisting -and -not $preexistingImage) {
        Throw-SafeError "ATTEMPT_PREEXISTING_IMAGE_MISSING"
    }
    elseif (-not [bool] $attemptRecord.imagePreexisting -and $preexistingImage -and
        -not [bool] $attemptRecord.imageLoadAttempted -and -not [bool] $attemptRecord.imageCreatedByAttempt) {
        Throw-SafeError "ATTEMPT_IMAGE_OWNERSHIP_AMBIGUOUS"
    }
    if (-not [bool] $attemptRecord.imagePreexisting -and $preexistingImage -and [bool] $attemptRecord.imageLoadAttempted) {
        $attemptRecord.imageCreatedByAttempt = $true
        $imageLoadedByAttempt = $true
        Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
    }
    if (-not $preexistingImage) {
        if (-not $attemptMarkerInitiallyPresent) {
            $preImageLoadBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
            if (-not $preImageLoadBudget.SameBoot -or [long] $preImageLoadBudget.RemainingMilliseconds -le 0) {
                Exit-PreRunnerClockCleanup $attemptRecord $attemptMarkerPath $containerName $volume $inputVolume $imageId $null $null $null $repository $source
            }
        }
        if (-not [bool] $attemptRecord.imageLoadAttempted) {
            $attemptRecord.imageLoadAttempted = $true
            Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
        }
        [void] (Invoke-Docker @("image", "load", "--input", $operatorArchiveLock.Path) $null @(0) 300 1MB)
        $imageLoadedByAttempt = $true
        $attemptRecord.imageCreatedByAttempt = $true
        Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
    }
    $referenceId = (Get-ProcessText (Invoke-Docker @("image", "inspect", "--format", "{{.Id}}", [string] $operatorManifest.image.reference) $null @(0) 30 4096) "OPERATOR_IMAGE_INVALID").Trim()
    if ($referenceId -cne $imageId) { Throw-SafeError "OPERATOR_IMAGE_INVALID" }
    $operatorImage = Assert-OperatorImageRuntime $imageId $operatorManifest $source

    if ($resumingFinalizing) {
        # The remote terminal evidence was already validated before entering this branch.
        # Only exact local objects named and labelled by the durable attempt
        # may be removed; no AWS, SSH, origin or runner command is issued.
        $controlRelative = "control-$nonce.json"
        $transportRelative = "transport-$nonce.json"
        $expectedRecoveredCommand = Get-RunnerCommand "run" $nonce $controlRelative $transportRelative
        $containerResult = Invoke-Docker @("container", "inspect", $containerName) $null @(0, 1) 30 1MB
        if ($containerResult.ExitCode -eq 0) {
            $existingContainer = @((Get-ProcessText $containerResult "ATTEMPT_CONTAINER_INVALID") | ConvertFrom-Json)
            if ($existingContainer.Count -ne 1 -or $existingContainer[0].State.Running -ne $false) {
                Throw-SafeError "ATTEMPT_CONTAINER_INVALID"
            }
            Assert-RunnerContainerContract $existingContainer[0] $operatorImage $containerName $imageId $volume $inputVolume $nonce $expectedRecoveredCommand "ATTEMPT_CONTAINER_INVALID"
            [void] (Invoke-Docker @("container", "rm", $containerName) $null @(0) 30 4096)
        }
        $volumeResult = Invoke-Docker @("volume", "inspect", $volume) $null @(0, 1) 30 65536
        $inputVolumeResult = Invoke-Docker @("volume", "inspect", $inputVolume) $null @(0, 1) 30 65536
        if ($inputVolumeResult.ExitCode -eq 0) {
            $existingInputVolume = @((Get-ProcessText $inputVolumeResult "ATTEMPT_INPUT_VOLUME_INVALID") | ConvertFrom-Json)
            if ($existingInputVolume.Count -ne 1 -or $existingInputVolume[0].Name -cne $inputVolume -or
                $existingInputVolume[0].Driver -cne "local" -or $existingInputVolume[0].Scope -cne "local" -or
                $existingInputVolume[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
                $existingInputVolume[0].Labels."com.refunddesk.edge-window-nonce" -cne $nonce -or
                $existingInputVolume[0].Labels."com.refunddesk.edge-window-input" -cne "true") {
                Throw-SafeError "ATTEMPT_INPUT_VOLUME_INVALID"
            }
            Assert-SealedInputVolume $inputVolume $imageId $nonce $immutableInputs
        }
        if ($volumeResult.ExitCode -eq 0) {
            $existingVolume = @((Get-ProcessText $volumeResult "ATTEMPT_VOLUME_INVALID") | ConvertFrom-Json)
            if ($existingVolume.Count -ne 1 -or $existingVolume[0].Name -cne $volume -or
                $existingVolume[0].Driver -cne "local" -or $existingVolume[0].Scope -cne "local" -or
                $existingVolume[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
                $existingVolume[0].Labels."com.refunddesk.edge-window-nonce" -cne $nonce) {
                Throw-SafeError "ATTEMPT_VOLUME_INVALID"
            }
            $scanProgram = 'import os,sys;root="/control";bad=[];[(bad.append(os.path.join(d,n)) if n=="origin-token" or (n.startswith("cloudfront.") and n.endswith(".json")) else None) for d,_,fs in os.walk(root) for n in fs];sys.exit(1 if bad else 0)'
            [void] (Invoke-Docker @(
                "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--user", "10001:10001",
                "--mount", "type=volume,source=$volume,target=/control,readonly",
                "--entrypoint", "/usr/bin/python3", $imageId, "-c", $scanProgram
            ) $null @(0) 30 4096)
            [void] (Invoke-Docker @("volume", "rm", $volume) $null @(0) 30 4096)
        }
        if ($inputVolumeResult.ExitCode -eq 0) {
            [void] (Invoke-Docker @("volume", "rm", $inputVolume) $null @(0) 30 4096)
        }
        if (([bool] $attemptRecord.imageCreatedByAttempt -or $imageLoadedByAttempt) -and
            (Invoke-Docker @("image", "inspect", $imageId) $null @(0, 1) 30 4096).ExitCode -eq 0) {
            [void] (Invoke-Docker @("image", "rm", $imageId) $null @(0) 60 4096)
        }
        $attemptRecord.localCleanupComplete = $true
        $attemptRecord.state = "complete"
        Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
        Assert-SourceProvenance $repository $source
        $operationSucceeded = $true
        $exitCode = [int] $consumedEvidence.exitCode
        [Console]::Out.WriteLine([string] $attemptRecord.evidenceFile)
        exit $exitCode
    }

    if ($resumingPrepared) {
        # A prepared attempt is cleanup-only forever.  Reuse its exact nonce,
        # image and private volume; never create a new runner or public window.
        $preservedTerminal = $null
        if ($attemptRecord.state -eq "cleanup_required") {
            $preservedTerminal = [pscustomobject]@{
                Document = $consumedEvidence
                ExitCode = [int] $consumedEvidence.exitCode
                Name = [string] $attemptRecord.evidenceFile
                Path = Join-Path $output ([string] $attemptRecord.evidenceFile)
                Sha256 = [string] $attemptRecord.evidenceSha256
            }
        }
        $controlRelative = "control-$nonce.json"
        $transportRelative = "transport-$nonce.json"
        $expectedRecoveredCommand = Get-RunnerCommand "run" $nonce $controlRelative $transportRelative
        $containerResult = Invoke-Docker @("container", "inspect", $containerName) $null @(0, 1) 30 1MB
        $volumeResult = Invoke-Docker @("volume", "inspect", $volume) $null @(0, 1) 30 65536
        $inputVolumeResult = Invoke-Docker @("volume", "inspect", $inputVolume) $null @(0, 1) 30 65536
        if ($inputVolumeResult.ExitCode -eq 0) {
            $existingInputVolume = @((Get-ProcessText $inputVolumeResult "ATTEMPT_INPUT_VOLUME_INVALID") | ConvertFrom-Json)
            if ($existingInputVolume.Count -ne 1 -or $existingInputVolume[0].Name -cne $inputVolume -or
                $existingInputVolume[0].Driver -cne "local" -or $existingInputVolume[0].Scope -cne "local" -or
                $existingInputVolume[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
                $existingInputVolume[0].Labels."com.refunddesk.edge-window-nonce" -cne $nonce -or
                $existingInputVolume[0].Labels."com.refunddesk.edge-window-input" -cne "true") {
                Throw-SafeError "ATTEMPT_INPUT_VOLUME_INVALID"
            }
            Assert-SealedInputVolume $inputVolume $imageId $nonce $immutableInputs
        }
        if ($containerResult.ExitCode -eq 0) {
            $existingContainer = @((Get-ProcessText $containerResult "ATTEMPT_CONTAINER_INVALID") | ConvertFrom-Json)
            if ($existingContainer.Count -ne 1) {
                Throw-SafeError "ATTEMPT_CONTAINER_INVALID"
            }
            Assert-RunnerContainerContract $existingContainer[0] $operatorImage $containerName $imageId $volume $inputVolume $nonce $expectedRecoveredCommand "ATTEMPT_CONTAINER_INVALID"
            if ($existingContainer[0].State.Running) {
                Stop-RunnerContainerBounded $containerName $imageId $volume $repository $nonce
                $stoppedState = Get-DockerContainerState $containerName
                if ($null -eq $stoppedState -or $stoppedState.Running) {
                    Throw-SafeError "RUNNER_CONTAINER_STOP_AMBIGUOUS"
                }
            }
            if ($null -eq $preservedTerminal -and -not [bool] $attemptRecord.operatorClockInvalidated) {
                $terminalState = Get-DockerContainerState $containerName
                if ($null -ne $terminalState -and -not $terminalState.Running -and [int] $terminalState.ExitCode -in @(0, 20, 21)) {
                    $terminalLogs = Invoke-Docker @("container", "logs", $containerName) $null @(0) 30 $MaximumEvidenceBytes
                    if ($terminalLogs.Stderr.Length -ne 0 -or $terminalLogs.Stdout.Length -le 0) {
                        Throw-SafeError "ATTEMPT_TERMINAL_OUTPUT_INVALID"
                    }
                    $preservedTerminal = Save-ValidatedEdgeTerminalEvidence $terminalLogs.Stdout ([int] $terminalState.ExitCode) $nonce $repository $output "ATTEMPT_TERMINAL_EVIDENCE_INVALID"
                    $attemptRecord.completedAt = Get-UtcTimestamp
                    $attemptRecord.evidenceFile = $preservedTerminal.Name
                    $attemptRecord.evidenceSha256 = $preservedTerminal.Sha256
                    $attemptRecord.state = if (Test-EdgeTerminalIsSafelyContained $preservedTerminal.Document) { "finalizing" } else { "cleanup_required" }
                    Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
                }
            }
        }
        $cleanupProvedContained = ($null -ne $preservedTerminal -and (Test-EdgeTerminalIsSafelyContained $preservedTerminal.Document))
        if ($volumeResult.ExitCode -eq 0) {
            $existingVolume = @((Get-ProcessText $volumeResult "ATTEMPT_VOLUME_INVALID") | ConvertFrom-Json)
            if ($existingVolume.Count -ne 1 -or $existingVolume[0].Name -cne $volume -or
                $existingVolume[0].Driver -cne "local" -or $existingVolume[0].Scope -cne "local" -or
                $existingVolume[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
                $existingVolume[0].Labels."com.refunddesk.edge-window-nonce" -cne $nonce) {
                Throw-SafeError "ATTEMPT_VOLUME_INVALID"
            }
            if (-not $cleanupProvedContained -and $inputVolumeResult.ExitCode -eq 0 -and
                $null -ne (Get-VolumeFile $inputVolume $imageId $controlRelative) -and
                $null -ne (Get-VolumeFile $inputVolume $imageId $transportRelative)) {
                $cleanupResult = Invoke-RunnerCleanup $imageId $volume $inputVolume $repository $transportRelative $controlRelative $nonce $immutableInputs
                if ($cleanupResult.Stdout.Length -gt 0 -and $cleanupResult.Stderr.Length -eq 0 -and
                    (-not [bool] $attemptRecord.operatorClockInvalidated -or [int] $cleanupResult.ExitCode -in @(20, 21))) {
                    $cleanupEvidence = ConvertFrom-BoundedJson $cleanupResult.Stdout "ATTEMPT_CLEANUP_EVIDENCE_INVALID" -RequireCanonical
                    $cleanupCandidate = Join-Path $output (".edge-window-cleanup-{0}-{1}.json" -f $nonce.Substring(0, 12), (New-Nonce).Substring(0, 12))
                    try {
                        Write-CreateNew $cleanupCandidate $cleanupResult.Stdout
                        $cleanupValidationArguments = @(
                            (Join-Path $repository "scripts/validate-lightsail-edge-window.mjs"),
                            $cleanupCandidate, (Join-Path $repository "docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json"),
                            $nonce, $ExpectedRevision, ([string] $cleanupResult.ExitCode),
                            [string] $cleanupEvidence.startedAt, [string] $cleanupEvidence.completedAt
                        )
                        if ($script:ProductionContractFixture) { $cleanupValidationArguments += "fixture" }
                        $cleanupValidation = Invoke-Node $cleanupValidationArguments $null @(0) 30
                        if ((Get-ProcessText $cleanupValidation "ATTEMPT_CLEANUP_EVIDENCE_INVALID").Trim() -cne "PASS_EDGE_WINDOW_RECONTAINED") {
                            Throw-SafeError "ATTEMPT_CLEANUP_EVIDENCE_INVALID"
                        }
                    }
                    finally {
                        if (Test-Path -LiteralPath $cleanupCandidate) { [IO.File]::Delete($cleanupCandidate) }
                    }
                    Assert-EdgeTerminalIdentity $cleanupEvidence ([int] $cleanupResult.ExitCode) $nonce "ATTEMPT_CLEANUP_EVIDENCE_INVALID"
                    if (-not (Test-EdgeTerminalIsSafelyContained $cleanupEvidence)) {
                        Throw-SafeError "ATTEMPT_CLEANUP_NOT_CONTAINED"
                    }
                    if ($null -eq $preservedTerminal -and -not [bool] $attemptRecord.operatorClockInvalidated) {
                        $preservedTerminal = Save-ValidatedEdgeTerminalEvidence $cleanupResult.Stdout ([int] $cleanupResult.ExitCode) $nonce $repository $output "ATTEMPT_CLEANUP_EVIDENCE_INVALID"
                        $attemptRecord.completedAt = Get-UtcTimestamp
                        $attemptRecord.evidenceFile = $preservedTerminal.Name
                        $attemptRecord.evidenceSha256 = $preservedTerminal.Sha256
                        $attemptRecord.state = "finalizing"
                        Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
                    }
                    $cleanupProvedContained = $true
                }
            }
        }
        if ($containerResult.ExitCode -eq 0) {
            [void] (Invoke-Docker @("container", "rm", "--force", $containerName) $null @(0, 1) 30 4096)
        }
        if ($cleanupProvedContained -and $volumeResult.ExitCode -eq 0) {
            $scanProgram = 'import os,sys;root="/control";bad=[];[(bad.append(os.path.join(d,n)) if n=="origin-token" or (n.startswith("cloudfront.") and n.endswith(".json")) else None) for d,_,fs in os.walk(root) for n in fs];sys.exit(1 if bad else 0)'
            [void] (Invoke-Docker @(
                "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--user", "10001:10001",
                "--mount", "type=volume,source=$volume,target=/control,readonly",
                "--entrypoint", "/usr/bin/python3", $imageId, "-c", $scanProgram
            ) $null @(0) 30 4096)
            [void] (Invoke-Docker @("volume", "rm", $volume) $null @(0) 30 4096)
            if ($inputVolumeResult.ExitCode -eq 0) {
                [void] (Invoke-Docker @("volume", "rm", $inputVolume) $null @(0) 30 4096)
            }
        }
        $containerAfter = Invoke-Docker @("container", "inspect", $containerName) $null @(0, 1) 30 4096
        $volumeAfter = Invoke-Docker @("volume", "inspect", $volume) $null @(0, 1) 30 4096
        $inputVolumeAfter = Invoke-Docker @("volume", "inspect", $inputVolume) $null @(0, 1) 30 4096
        if ($volumeAfter.ExitCode -eq 1 -and $inputVolumeAfter.ExitCode -eq 1 -and $containerAfter.ExitCode -eq 1 -and
            ($cleanupProvedContained -or ($volumeResult.ExitCode -eq 1 -and $inputVolumeResult.ExitCode -eq 1 -and $containerResult.ExitCode -eq 1))) {
            if ([bool] $attemptRecord.imageCreatedByAttempt -and
                (Invoke-Docker @("image", "inspect", $imageId) $null @(0, 1) 30 4096).ExitCode -eq 0) {
                [void] (Invoke-Docker @("image", "rm", $imageId) $null @(0) 60 4096)
            }
            $attemptRecord.completedAt = Get-UtcTimestamp
            $attemptRecord.localCleanupComplete = $true
            $attemptRecord.state = if ($null -ne $preservedTerminal) { "complete" } else { "cleanup_complete" }
            Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
        }
        Assert-SourceProvenance $repository $source
        $operationSucceeded = $true
        if ($null -ne $preservedTerminal -and $attemptRecord.state -eq "complete") {
            $exitCode = [int] $preservedTerminal.ExitCode
            [Console]::Out.WriteLine([string] $preservedTerminal.Name)
            exit $exitCode
        }
        $exitCode = 21
        [Console]::Error.WriteLine("edge-window-wrapper-error:ATTEMPT_CLEANUP_ONLY_NO_REOPEN")
        exit 21
    }

    if ((Invoke-Docker @("volume", "inspect", $volume) $null @(0, 1) 30 4096).ExitCode -eq 0 -or
        (Invoke-Docker @("volume", "inspect", $inputVolume) $null @(0, 1) 30 4096).ExitCode -eq 0) {
        Throw-SafeError "VOLUME_PREEXISTS"
    }
    $preVolumeBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
    if (-not $preVolumeBudget.SameBoot -or [long] $preVolumeBudget.RemainingMilliseconds -le 0) {
        Exit-PreRunnerClockCleanup $attemptRecord $attemptMarkerPath $containerName $volume $inputVolume $imageId $operatorImage $null $null $repository $source
    }
    [void] (Invoke-Docker @("volume", "create", "--label", "com.refunddesk.revision=$ExpectedRevision", "--label", "com.refunddesk.edge-window-nonce=$nonce", $volume) $null @(0) 30 4096)
    $volumeCreatedByAttempt = $true
    [void] (Invoke-Docker @("volume", "create", "--label", "com.refunddesk.revision=$ExpectedRevision", "--label", "com.refunddesk.edge-window-nonce=$nonce", "--label", "com.refunddesk.edge-window-input=true", $inputVolume) $null @(0) 30 4096)
    $inputVolumeCreatedByAttempt = $true
    if ($script:ProductionContractFixture -and $FixtureCrashAfter -ceq "after_input_volume_create") {
        # Offline fixture-only hard death before any immutable input digest is
        # journaled.  Recovery must remove exact labelled volumes without ever
        # creating or starting a runner.
        [Environment]::Exit(99)
    }
    $volumeInspection = (Get-ProcessText (Invoke-Docker @("volume", "inspect", $volume) $null @(0) 30 65536) "VOLUME_CONTRACT_INVALID") | ConvertFrom-Json
    if (@($volumeInspection).Count -ne 1 -or $volumeInspection[0].Name -cne $volume -or
        $volumeInspection[0].Driver -cne "local" -or $volumeInspection[0].Scope -cne "local" -or
        $volumeInspection[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
        $volumeInspection[0].Labels."com.refunddesk.edge-window-nonce" -cne $nonce) {
        Throw-SafeError "VOLUME_CONTRACT_INVALID"
    }
    $inputVolumeInspection = (Get-ProcessText (Invoke-Docker @("volume", "inspect", $inputVolume) $null @(0) 30 65536) "INPUT_VOLUME_CONTRACT_INVALID") | ConvertFrom-Json
    if (@($inputVolumeInspection).Count -ne 1 -or $inputVolumeInspection[0].Name -cne $inputVolume -or
        $inputVolumeInspection[0].Driver -cne "local" -or $inputVolumeInspection[0].Scope -cne "local" -or
        $inputVolumeInspection[0].Labels."com.refunddesk.revision" -cne $ExpectedRevision -or
        $inputVolumeInspection[0].Labels."com.refunddesk.edge-window-nonce" -cne $nonce -or
        $inputVolumeInspection[0].Labels."com.refunddesk.edge-window-input" -cne "true") {
        Throw-SafeError "INPUT_VOLUME_CONTRACT_INVALID"
    }

    $sshConfig = @"
Host refunddesk-edge
  HostName $($script:Authorization.sshHost)
  User ubuntu
  BatchMode yes
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  GSSAPIAuthentication no
  IdentitiesOnly yes
  IdentityFile /operator/ssh/id
  UserKnownHostsFile /operator/ssh/known_hosts
  StrictHostKeyChecking yes
  ForwardAgent no
  ClearAllForwardings yes
  PermitLocalCommand no
  RequestTTY no
  SendEnv -*
  IdentityAgent none
  LogLevel ERROR
"@
    $sshConfigBytes = [Text.UTF8Encoding]::new($false).GetBytes($sshConfig.Replace("`r`n", "`n"))
    # Both auxiliary configuration byte sequences are finalized before the
    # transport document so the runner can independently re-hash the exact
    # immutable files it will consume.
    $awsConfigBytes = [Text.UTF8Encoding]::new($false).GetBytes("[default]`nregion = $($script:Authorization.awsRegion)`noutput = json`n")
    $sshConfigSha256 = Get-Sha256Hex $sshConfigBytes
    $awsConfigSha256 = Get-Sha256Hex $awsConfigBytes
    $transport = [ordered]@{
        awsAccountId = [string] $script:Authorization.awsAccountId
        awsConfigSha256 = $awsConfigSha256
        awsRegion = [string] $script:Authorization.awsRegion
        caddyContainerId = [string] $promotion.runtime.caddyContainerId
        distributionId = [string] $script:Authorization.distributionId
        expectedSshCidr = $ExpectedSshCidr
        gitExecutable = [string] $operatorManifest.tools.git.path
        gitSha256 = [string] $operatorManifest.tools.git.sha256
        instanceName = [string] $script:Authorization.instanceName
        nodeExecutable = [string] $operatorManifest.tools.node.path
        nodeSha256 = [string] $operatorManifest.tools.node.sha256
        originId = [string] $script:Authorization.originId
        postgresContainerId = [string] $promotion.runtime.postgresContainerId
        publicBaseUrl = [string] $script:Authorization.publicBaseUrl
        sshConfigSha256 = $sshConfigSha256
        sshConfigPath = "/var/lib/refunddesk/input/ssh-config"
        sshHost = "refunddesk-edge"
        targetHost = [string] $script:Authorization.sshHost
        verifierContainerId = [string] $promotion.runtime.verifierContainerId
        webContainerId = [string] $promotion.runtime.webContainerId
        workerContainerId = [string] $promotion.runtime.workerContainerId
    }
    $transportText = ConvertTo-CanonicalJson $transport -Newline
    $transportBytes = [Text.UTF8Encoding]::new($false).GetBytes($transportText)
    $transportRelative = "transport-$nonce.json"

    # All unbounded-by-count Git rechecks happen before the reserve snapshot.
    # Their open read handles remain deny-write locks through runner start.  The
    # 240-second launch reserve then covers exactly five remaining bounded
    # Docker calls before/start: 30+30+60+30+30 seconds before start, 30 seconds
    # of local scheduling margin, and the 30-second start timeout itself.
    Assert-SourceProvenance $repository $source
    Assert-AllSensitiveLocks
    $operatorControlClock = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
    if (-not $operatorControlClock.SameBoot -or [long] $operatorControlClock.RemainingMilliseconds -le 0) {
        Exit-PreRunnerClockCleanup $attemptRecord $attemptMarkerPath $containerName $volume $inputVolume $imageId $operatorImage $null $null $repository $source
    }
    $operatorControlCalculatedMonotonicMilliseconds = [long] $operatorControlClock.CurrentMonotonicMilliseconds
    $operationRemainingSecondsAtRunnerStart = [long] [Math]::Floor([long] $operatorControlClock.RemainingMilliseconds / 1000) - $RunnerLaunchReserveSeconds
    if ($operationRemainingSecondsAtRunnerStart -le 0 -or
        $operationRemainingSecondsAtRunnerStart -gt ($SuccessfulExecutionSeconds - $RunnerLaunchReserveSeconds)) {
        Exit-PreRunnerClockCleanup $attemptRecord $attemptMarkerPath $containerName $volume $inputVolume $imageId $operatorImage $null $null $repository $source
    }

    $control = [ordered]@{
        admission = [ordered]@{
            authorizationAccepted = $true
            authorizationEvidenceSha256 = $ExpectedAuthorizationSha256
            authorizationMaxWindowSeconds = [int] $script:Authorization.maxWindowSeconds
            authorizationValidFrom = [string] $script:Authorization.validFrom
            authorizationValidUntil = [string] $script:Authorization.validUntil
            authorizedAwsAccountIdSha256 = Get-TextSha256 ([string] $script:Authorization.awsAccountId)
            authorizedAwsRegionSha256 = Get-TextSha256 ([string] $script:Authorization.awsRegion)
            authorizedDistributionIdSha256 = Get-TextSha256 ([string] $script:Authorization.distributionId)
            authorizedInstanceNameSha256 = Get-TextSha256 ([string] $script:Authorization.instanceName)
            authorizedOriginIdSha256 = Get-TextSha256 ([string] $script:Authorization.originId)
            authorizedPublicBaseUrlSha256 = Get-TextSha256 ([string] $script:Authorization.publicBaseUrl)
            authorizedSshCidrSha256 = Get-TextSha256 ([string] $script:Authorization.expectedSshCidr)
            authorizedSshHostSha256 = Get-TextSha256 ([string] $script:Authorization.sshHost)
            incidentAccepted = $true
            incidentCapturedAt = [string] $incident.capturedAt
            incidentEvidenceSha256 = $ExpectedIncidentEvidenceSha256
            incidentRemainingSecondsAtStart = $incidentRemaining
            incidentValidUntil = [string] $incident.validUntil
            postflightAccepted = $true
            postflightCapturedAt = [string] $preflight.capturedAt
            postflightEvidenceSha256 = $ExpectedPreflightEvidenceSha256
            postflightRemainingSecondsAtStart = $postflightRemaining
            postflightValidUntil = [string] $preflight.validUntil
            promotionAccepted = $true
            promotionCaddyContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.caddyContainerId)
            promotionDatabaseSystemIdentifierSha256 = Get-TextSha256 ([string] $promotion.database.systemIdentifier)
            promotionEvidenceSha256 = $ExpectedPromotionEvidenceSha256
            promotionPostgresContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.postgresContainerId)
            promotionVerifierContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.verifierContainerId)
            promotionWebContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.webContainerId)
            promotionWorkerContainerIdSha256 = Get-TextSha256 ([string] $promotion.runtime.workerContainerId)
            promotionWorkerRuntimeMode = "incident_admission"
            promotionRevision = $ExpectedRevision
        }
        eventFingerprintSha256 = [string] $script:Authorization.eventFingerprintSha256
        expectedRevision = $ExpectedRevision
        kind = "refunddesk.edge-window-control"
        nonce = $nonce
        operationRemainingSecondsAtRunnerStart = [int] $operationRemainingSecondsAtRunnerStart
        operationStartedAt = $attemptStartedAt
        operatorBootIdentifierSha256 = $operatorBootIdentifierSha256
        operatorControlCalculatedMonotonicMilliseconds = $operatorControlCalculatedMonotonicMilliseconds
        operatorDeadlineMonotonicMilliseconds = $operatorDeadlineMonotonicMilliseconds
        operatorStartedMonotonicMilliseconds = $operatorStartedMonotonicMilliseconds
        postIncidentBaseline = $postIncidentBaseline
        provenance = [ordered]@{
            fixtureOnly = [bool] $script:ProductionContractFixture
            operatorLockHeld = $true
            repositoryHead = [string] $source.repositoryHead
            repositoryIndexSha256 = [string] $source.repositoryIndexSha256
            sourceBundleSha256 = [string] $source.sourceBundleSha256
            sources = $source.records
            sourcesExact = $true
            transportInputsSha256 = Get-Sha256Hex $transportBytes
            transportInputsPinned = $true
            toolImageIdSha256 = Get-TextSha256 $imageId
            workflowRunId = [long] $operatorProvenance.workflowRunId
            workflowRunObservationSha256 = $workflowRunObservationSha256
        }
        schemaVersion = 1
        windowSeconds = $WindowSeconds
    }
    $controlBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $control -Newline))
    $controlRelative = "control-$nonce.json"
    $immutableInputFiles = [ordered]@{ "aws-config" = $awsConfigBytes; "ssh-config" = $sshConfigBytes }
    $immutableInputFiles[$controlRelative] = $controlBytes
    $immutableInputFiles[$transportRelative] = $transportBytes
    New-SealedInputVolume $inputVolume $imageId $nonce $immutableInputFiles
    $immutableInputs = [ordered]@{
        awsConfigSha256 = $awsConfigSha256
        controlSha256 = Get-Sha256Hex $controlBytes
        sshConfigSha256 = $sshConfigSha256
        transportSha256 = Get-Sha256Hex $transportBytes
    }
    Assert-SealedInputVolume $inputVolume $imageId $nonce ([pscustomobject] $immutableInputs)
    if ($script:ProductionContractFixture -and $FixtureCrashAfter -ceq "after_input_seal_before_marker") {
        # Offline fixture-only hard death after sealing but before publishing
        # the four digests into the durable attempt marker.
        [Environment]::Exit(99)
    }
    $attemptRecord.immutableInputs = $immutableInputs
    Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptRecord -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"

    $preContainerBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
    if (-not $preContainerBudget.SameBoot -or [long] $preContainerBudget.RemainingMilliseconds -le 0) {
        Exit-PreRunnerClockCleanup $attemptRecord $attemptMarkerPath $containerName $volume $inputVolume $imageId $operatorImage $null $immutableInputs $repository $source
    }
    $runnerCommand = Get-RunnerCommand "run" $nonce $controlRelative $transportRelative
    $createArguments = @(
        "container", "create", "--name", $containerName, "--pull", "never",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--network", "bridge", "--restart", "no", "--ipc", "private", "--pid", "private", "--uts", "private",
        "--user", "10001:10001", "--pids-limit", "256", "--memory", "512m", "--cpus", "1.0",
        "--label", "com.refunddesk.edge-window-nonce=$nonce", "--label", "com.refunddesk.revision=$ExpectedRevision",
        "--mount", "type=volume,source=$volume,target=/var/lib/refunddesk/control",
        "--mount", "type=volume,source=$inputVolume,target=/var/lib/refunddesk/input,readonly",
        "--mount", "type=bind,source=$($script:CredentialsLock.Path),target=/operator/aws/credentials,readonly",
        "--mount", "type=bind,source=$($script:IdentityLock.Path),target=/operator/ssh/id,readonly",
        "--mount", "type=bind,source=$($script:KnownHostsLock.Path),target=/operator/ssh/known_hosts,readonly",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m",
        "--tmpfs", "/run/refunddesk:rw,noexec,nosuid,nodev,size=8m",
        "--env", "AWS_SHARED_CREDENTIALS_FILE=/operator/aws/credentials",
        "--env", "AWS_CONFIG_FILE=/var/lib/refunddesk/input/aws-config", "--env", "AWS_PROFILE=default",
        "--env", "AWS_REGION=$($script:Authorization.awsRegion)", "--env", "AWS_DEFAULT_REGION=$($script:Authorization.awsRegion)",
        "--env", "AWS_EC2_METADATA_DISABLED=true", "--env", "AWS_PAGER=",
        "--env", "REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR=1",
        $imageId
    )
    $createArguments += $runnerCommand
    [void] (Invoke-Docker $createArguments $null @(0) 60 4096)
    $containerCreatedByAttempt = $true
    $containerInspect = (Get-ProcessText (Invoke-Docker @("container", "inspect", $containerName) $null @(0) 30 2MB) "CONTAINER_CONTRACT_INVALID") | ConvertFrom-Json
    if (@($containerInspect).Count -ne 1) { Throw-SafeError "CONTAINER_CONTRACT_INVALID" }
    $container = @($containerInspect)[0]
    Assert-RunnerContainerContract $container $operatorImage $containerName $imageId $volume $inputVolume $nonce $runnerCommand "CONTAINER_CONTRACT_INVALID"

    $startedAt = Get-UtcTimestamp
    $now = Get-AdmissionUtcNow
    if ($authorizationFrom -gt $now -or $authorizationUntil -lt $now.AddSeconds($WindowSeconds)) {
        Throw-SafeError "AUTHORIZATION_WINDOW_INVALID"
    }
    $operationTimer = [Diagnostics.Stopwatch]::StartNew()
    Assert-AllSensitiveLocks
    Assert-SealedInputVolume $inputVolume $imageId $nonce ([pscustomobject] $immutableInputs)
    $script:FixtureRunnerStartRecheck = $true
    $preStartBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
    $preStartReserveMilliseconds = [long] (($RunnerLaunchReserveSeconds - $RunnerStartTimeoutSeconds) * 1000)
    if ($operatorControlCalculatedMonotonicMilliseconds -gt [long]::MaxValue - $preStartReserveMilliseconds) {
        Throw-SafeError "OPERATOR_CLOCK_INVALID"
    }
    $latestAllowedPreStartMonotonicMilliseconds = [long] ($operatorControlCalculatedMonotonicMilliseconds + $preStartReserveMilliseconds)
    if (-not $preStartBudget.SameBoot -or [long] $preStartBudget.RemainingMilliseconds -le 0 -or
        [long] $preStartBudget.CurrentMonotonicMilliseconds -gt $latestAllowedPreStartMonotonicMilliseconds) {
        Exit-PreRunnerClockCleanup $attemptRecord $attemptMarkerPath $containerName $volume $inputVolume $imageId $operatorImage $runnerCommand $immutableInputs $repository $source
    }
    [void] (Invoke-Docker @("container", "start", $containerName) $null @(0) $RunnerStartTimeoutSeconds 4096)
    $runnerStarted = $true
    $script:FixtureRunnerStartRecheck = $false
    $script:FixtureRunnerMonitoring = $true
    $workbenchInjected = $false
    $postflightInjected = $false
    $requestLocalPath = Join-Path $output "edge-window-workbench-request-$ExpectedRevision-$($nonce.Substring(0, 12)).local.json"
    $evidenceDirectory = Join-Path $repository "sandbox-evidence.local/aws"

    while ($true) {
        $runtimeOperatorBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
        if (-not $runtimeOperatorBudget.SameBoot -or [long] $runtimeOperatorBudget.RemainingMilliseconds -le 0) {
            Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath
            Throw-SafeError "OPERATOR_CLOCK_DEADLINE_EXPIRED"
        }
        $state = Get-DockerContainerState $containerName
        if ($null -eq $state) { Throw-SafeError "CONTAINER_STATE_INVALID" }
        if (-not $state.Running) { break }
        if ($operationTimer.Elapsed.TotalSeconds -gt $SuccessfulExecutionSeconds) {
            Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath
            Throw-SafeError "OPERATOR_CLOCK_DEADLINE_EXPIRED"
        }
        if (-not $workbenchInjected) {
            $requestBytes = Get-VolumeFile $volume $imageId "workbench-request-$nonce.json"
            if ($null -ne $requestBytes) {
                $request = ConvertFrom-BoundedJson $requestBytes "WORKBENCH_REQUEST_INVALID" -RequireCanonical
                Assert-ExactProperties $request @("deadlineAt", "eventFingerprintSha256", "expectedRevision", "kind", "nonce", "openedAt", "schemaVersion") "WORKBENCH_REQUEST_INVALID"
                if ($request.kind -cne "refunddesk.operator-workbench-request" -or $request.nonce -cne $nonce -or
                    $request.expectedRevision -cne $ExpectedRevision -or $request.eventFingerprintSha256 -cne $script:Authorization.eventFingerprintSha256) {
                    Throw-SafeError "WORKBENCH_REQUEST_INVALID"
                }
                Write-CreateNew $requestLocalPath $requestBytes
                $deadline = [DateTime]::Parse([string] $request.deadlineAt).ToUniversalTime()
                $checkpointWaitTimer = [Diagnostics.Stopwatch]::StartNew()
                while (-not (Test-Path -LiteralPath $checkpoint)) {
                    $checkpointOperatorBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
                    if (-not $checkpointOperatorBudget.SameBoot -or [long] $checkpointOperatorBudget.RemainingMilliseconds -le 0) {
                        Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath
                        Throw-SafeError "OPERATOR_CLOCK_DEADLINE_EXPIRED"
                    }
                    $currentRunnerState = Get-DockerContainerState $containerName
                    if ($null -eq $currentRunnerState -or -not $currentRunnerState.Running -or
                        $checkpointWaitTimer.Elapsed.TotalSeconds -ge $WindowSeconds -or
                        $operationTimer.Elapsed.TotalSeconds -ge $SuccessfulExecutionSeconds) { break }
                    Start-Sleep -Milliseconds 500
                }
                if (-not (Test-Path -LiteralPath $checkpoint)) {
                    # The runner owns AWS-first cleanup and its host watchdog is
                    # already armed.  Stop waiting for human input without
                    # terminating that containment path.
                    $workbenchInjected = $true
                    continue
                }
                if ((Get-CanonicalDirectory ([IO.Path]::GetDirectoryName($checkpoint)) "WORKBENCH_PARENT_INVALID") -cne $checkpointParent) {
                    Throw-SafeError "WORKBENCH_PARENT_CHANGED"
                }
                Assert-RestrictedAcl $checkpointParent "WORKBENCH_PARENT_ACL_INVALID"
                $checkpointLock = Open-SensitiveLock $checkpoint "WORKBENCH_CHECKPOINT_ACL_INVALID"
                $locks.Add($checkpointLock.Stream)
                $checkpointCanonical = $checkpointLock.Path
                if ([DateTime]::UtcNow -gt $deadline) { Throw-SafeError "WORKBENCH_CHECKPOINT_TIMEOUT" }
                $checkpointBytes = Read-LockedStreamBytes $checkpointLock.Stream 16384 "WORKBENCH_CHECKPOINT_INVALID"
                $checkpointValidation = Invoke-Node @(
                    (Join-Path $repository "scripts/validate-lightsail-edge-window.mjs"),
                    "--workbench", $checkpointCanonical, $nonce, $ExpectedRevision,
                    [string] $request.eventFingerprintSha256, [string] $request.openedAt, [string] $request.deadlineAt
                ) $null @(0) 30
                if ((Get-ProcessText $checkpointValidation "WORKBENCH_CHECKPOINT_INVALID").Trim() -cne "PASS_WORKBENCH_CHECKPOINT") {
                    Throw-SafeError "WORKBENCH_CHECKPOINT_INVALID"
                }
                if ((Get-CanonicalFile $checkpoint "WORKBENCH_CHECKPOINT_INVALID") -cne $checkpointCanonical -or
                    (Get-StreamSha256 $checkpointLock.Stream "WORKBENCH_CHECKPOINT_INVALID") -cne (Get-Sha256Hex $checkpointBytes)) {
                    Throw-SafeError "WORKBENCH_CHECKPOINT_CHANGED"
                }
                Assert-RestrictedAcl $checkpointCanonical "WORKBENCH_CHECKPOINT_ACL_INVALID"
                Assert-RestrictedAcl $checkpointParent "WORKBENCH_PARENT_ACL_INVALID"
                New-VolumeFile $volume $imageId "workbench-$nonce.json" $checkpointBytes
                $workbenchInjected = $true
            }
        }
        if (-not $postflightInjected) {
            $postflightRequestBytes = Get-VolumeFile $volume $imageId "edge-window-operation-$nonce/final-postflight-request.json"
            if ($null -ne $postflightRequestBytes) {
                $postflightRequest = ConvertFrom-BoundedJson $postflightRequestBytes "FINAL_POSTFLIGHT_REQUEST_INVALID" -RequireCanonical
                Assert-ExactProperties $postflightRequest @("expectedRevision", "kind", "nonce", "requestBootIdSha256", "requestedAt", "requestedBoottimeMilliseconds", "schemaVersion") "FINAL_POSTFLIGHT_REQUEST_INVALID"
                Assert-FinalPostflightRequestValues $postflightRequest $nonce
                $postflightOperatorBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
                if (-not $postflightOperatorBudget.SameBoot -or [long] $postflightOperatorBudget.RemainingMilliseconds -le 0) {
                    Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath
                    Throw-SafeError "OPERATOR_CLOCK_DEADLINE_EXPIRED"
                }
                $remainingSeconds = [int] [Math]::Floor([long] $postflightOperatorBudget.RemainingMilliseconds / 1000)
                if ($remainingSeconds -le 0) { Throw-SafeError "EDGE_WINDOW_OVERALL_TIMEOUT" }
                $postflightTimeout = [Math]::Min($FinalPostflightSeconds, $remainingSeconds)
                $capture = Invoke-OfficialFinalPostflight $repository $evidenceDirectory $postflightTimeout
                $locks.Add($capture.Stream)
                $postflightCompletedBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
                if (-not $postflightCompletedBudget.SameBoot -or [long] $postflightCompletedBudget.RemainingMilliseconds -le 0) {
                    Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath
                    Throw-SafeError "OPERATOR_CLOCK_DEADLINE_EXPIRED"
                }
                New-VolumeFile $volume $imageId "edge-window-operation-$nonce/final-postflight-capture.json" $capture.Bytes
                $postflightInjected = $true
            }
        }
        Start-Sleep -Milliseconds 500
    }

    $finalState = Get-DockerContainerState $containerName
    $exitCode = [int] $finalState.ExitCode
    if ($exitCode -notin @(0, 20, 21)) { Throw-SafeError "RUNNER_EXIT_INVALID" }
    $terminalOperatorBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
    if (-not $terminalOperatorBudget.SameBoot -or [long] $terminalOperatorBudget.RemainingMilliseconds -le 0) {
        Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath
        Throw-SafeError "OPERATOR_CLOCK_DEADLINE_EXPIRED"
    }
    Assert-SourceProvenance $repository $source
    Assert-AllSensitiveLocks
    $logsResult = Invoke-Docker @("container", "logs", $containerName) $null @(0) 30 $MaximumEvidenceBytes
    if ($script:ProductionContractFixture -and $FixtureCrashAfter -ceq "after_remote_terminal") {
        # Intentional hard process death for the offline contract only.  This
        # skips catch/finally exactly like a killed workstation after the
        # remote runner is terminal but before its stdout can be admitted or
        # local CreateNew evidence can be attempted.  In particular, this lets
        # the contract prove that a terminal exit without evidence remains an
        # unclassified prepared attempt on every later invocation.
        [Environment]::Exit(99)
    }
    if ($logsResult.Stderr.Length -ne 0 -or $logsResult.Stdout.Length -le 0) { Throw-SafeError "RUNNER_OUTPUT_INVALID" }
    $terminalLogsBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
    if (-not $terminalLogsBudget.SameBoot -or [long] $terminalLogsBudget.RemainingMilliseconds -le 0) {
        Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath
        Throw-SafeError "OPERATOR_CLOCK_DEADLINE_EXPIRED"
    }
    $terminal = Save-ValidatedEdgeTerminalEvidence $logsResult.Stdout $exitCode $nonce $repository $output "EDGE_EVIDENCE_INVALID" {
        $terminalPublishBudget = Get-OperatorBudgetSnapshot $operatorBootIdentifierSha256 $operatorDeadlineMonotonicMilliseconds
        if (-not $terminalPublishBudget.SameBoot -or [long] $terminalPublishBudget.RemainingMilliseconds -le 0) {
            Set-OperatorClockInvalidated $attemptRecord $attemptMarkerPath
            Throw-SafeError "OPERATOR_CLOCK_DEADLINE_EXPIRED"
        }
    }
    $finalEvidence = $terminal.Document
    Assert-SourceProvenance $repository $source
    $attemptFinalizing = [ordered]@{
        bindingSha256 = $attemptBindingSha256
        completedAt = Get-UtcTimestamp
        containerName = [string] $attemptRecord.containerName
        evidenceFile = $terminal.Name
        evidenceSha256 = $terminal.Sha256
        imageCreatedByAttempt = [bool] $attemptRecord.imageCreatedByAttempt
        imageId = [string] $attemptRecord.imageId
        imageLoadAttempted = [bool] $attemptRecord.imageLoadAttempted
        imagePreexisting = [bool] $attemptRecord.imagePreexisting
        immutableInputs = $attemptRecord.immutableInputs
        inputVolume = [string] $attemptRecord.inputVolume
        inputs = $attemptInputs
        kind = "refunddesk.edge-window-local-attempt"
        localCleanupComplete = $false
        nonce = $nonce
        operatorBootIdentifierSha256 = [string] $attemptRecord.operatorBootIdentifierSha256
        operatorClockInvalidated = [bool] $attemptRecord.operatorClockInvalidated
        operatorDeadlineMonotonicMilliseconds = [long] $attemptRecord.operatorDeadlineMonotonicMilliseconds
        operatorStartedMonotonicMilliseconds = [long] $attemptRecord.operatorStartedMonotonicMilliseconds
        schemaVersion = 1
        startedAt = $attemptStartedAt
        state = if (Test-EdgeTerminalIsSafelyContained $finalEvidence) { "finalizing" } else { "cleanup_required" }
        volume = [string] $attemptRecord.volume
    }
    Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptFinalizing -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
    $attemptRecord = $attemptFinalizing
    if ($attemptRecord.state -eq "cleanup_required") {
        # Preserve the first terminal result and every private recovery input.
        # A subsequent invocation is cleanup-only under the same attempt lock;
        # it can never create a fresh nonce or reopen ingress.
        $operationSucceeded = $true
        [Console]::Out.WriteLine([string] $attemptRecord.evidenceFile)
        exit $exitCode
    }
    else {
        $scanProgram = 'import os,sys;root="/control";bad=[];[(bad.append(os.path.join(d,n)) if n=="origin-token" or (n.startswith("cloudfront.") and n.endswith(".json")) else None) for d,_,fs in os.walk(root) for n in fs];sys.exit(1 if bad else 0)'
        [void] (Invoke-Docker @(
            "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--user", "10001:10001",
            "--mount", "type=volume,source=$volume,target=/control,readonly",
            "--entrypoint", "/usr/bin/python3", $imageId, "-c", $scanProgram
        ) $null @(0) 30 4096)
        [void] (Invoke-Docker @("container", "rm", $containerName) $null @(0) 30 4096)
        $containerCreatedByAttempt = $false
        $containerName = $null
        [void] (Invoke-Docker @("volume", "rm", $volume) $null @(0) 30 4096)
        $volumeCreatedByAttempt = $false
        $volume = $null
        [void] (Invoke-Docker @("volume", "rm", $inputVolume) $null @(0) 30 4096)
        $inputVolumeCreatedByAttempt = $false
        $inputVolume = $null
        if ($imageLoadedByAttempt) {
            [void] (Invoke-Docker @("image", "rm", $imageId) $null @(0) 60 4096)
            $imageLoadedByAttempt = $false
        }
        $attemptComplete = $attemptFinalizing
        $attemptComplete.localCleanupComplete = $true
        $attemptComplete.state = "complete"
        Write-RestrictedReplace $attemptMarkerPath ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-CanonicalJson $attemptComplete -Newline))) "ATTEMPT_MARKER_COMMIT_FAILED"
        $operationSucceeded = $true
    }
    Assert-SourceProvenance $repository $source
    Assert-AllSensitiveLocks
    [Console]::Out.WriteLine([string] $attemptRecord.evidenceFile)
}
catch {
    $safeCode = if ($_.Exception.Message -match "^REFUNDDESK_([A-Z0-9_]+)$") { $Matches[1] } else { "EDGE_WINDOW_WRAPPER_INCOMPLETE" }
    [Console]::Error.WriteLine("edge-window-wrapper-error:$safeCode")
    $exitCode = 21
}
finally {
    if (-not $operationSucceeded -and $containerCreatedByAttempt -and $null -ne $containerName) {
        try {
            $state = Get-DockerContainerState $containerName
            if ($null -ne $state -and $state.Running) {
                Stop-RunnerContainerBounded $containerName $imageId $volume $repository $nonce
            }
            if ($runnerStarted -and $null -ne $volume -and $null -ne $inputVolume -and
                $null -ne $controlRelative -and $null -ne $transportRelative -and $null -ne $immutableInputs) {
                Invoke-RunnerCleanup $imageId $volume $inputVolume $repository $transportRelative $controlRelative $nonce $immutableInputs
            }
            [void] (Invoke-Docker @("container", "rm", "--force", $containerName) $null @(0, 1) 30 4096)
        }
        catch {
            # Preserve the private recovery volume and exact image on ambiguity.
        }
    }
    $script:GitHubToken = $null
    foreach ($lock in $locks) {
        try { $lock.Dispose() } catch {}
    }
    if ($null -ne $dockerConfigDirectory) {
        try {
            Assert-DockerIsolation
            [IO.Directory]::Delete($dockerConfigDirectory, $false)
        }
        catch {
            if ($exitCode -eq 0) { $exitCode = 21 }
        }
    }
    if ($null -ne $ghConfigDirectory) {
        try {
            $canonicalGh = Get-CanonicalDirectory $ghConfigDirectory "GH_ISOLATION_INVALID"
            Assert-RestrictedAcl $canonicalGh "GH_ISOLATION_INVALID"
            if (@(Get-ChildItem -LiteralPath $canonicalGh -Force).Count -ne 0) { throw "nonempty" }
            [IO.Directory]::Delete($ghConfigDirectory, $false)
        }
        catch {
            if ($exitCode -eq 0) { $exitCode = 21 }
        }
    }
}

exit $exitCode
