[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Sort-JsonValue {
    param([AllowNull()] $Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        [string[]] $keys = @($Value.Keys | ForEach-Object { [string] $_ })
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        foreach ($key in $keys) { $ordered[$key] = Sort-JsonValue $Value[$key] }
        return $ordered
    }
    if ($Value -is [Management.Automation.PSCustomObject]) {
        $ordered = [ordered]@{}
        [string[]] $keys = @($Value.PSObject.Properties.Name)
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        foreach ($key in $keys) { $ordered[$key] = Sort-JsonValue $Value.$key }
        return $ordered
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
        $items = @($Value | ForEach-Object { Sort-JsonValue $_ })
        return ,$items
    }
    return $Value
}

function Canonical-Json {
    param([Parameter(Mandatory = $true)] $Value, [switch] $Newline)
    $sorted = Sort-JsonValue $Value
    $text = ConvertTo-Json -InputObject $sorted -Compress -Depth 100
    if ($Newline) { return "$text`n" }
    return $text
}
function Ordered-Json {
    param([Parameter(Mandatory = $true)] $Value, [switch] $Newline)
    $text = ConvertTo-Json -InputObject $Value -Compress -Depth 100
    if ($Newline) { return "$text`n" }
    return $text
}

function Utf8-Bytes([string] $Text) {
    # Keep zero-byte encoder results as byte[] instead of letting the PS5
    # pipeline collapse them to $null (the same exact-boundary rule as stdin).
    return ,[Text.UTF8Encoding]::new($false).GetBytes($Text)
}
function Write-Bytes([byte[]] $Bytes) {
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($Bytes, 0, $Bytes.Length)
    $stream.Flush()
}
function Write-Text([string] $Text) { Write-Bytes (Utf8-Bytes $Text) }
function Read-StdinBytes {
    $inputStream = [Console]::OpenStandardInput()
    $memory = [IO.MemoryStream]::new()
    # Preserve the byte-array object even when stdin is empty.  Without the
    # unary comma PowerShell enumerates an empty byte[] into no pipeline object,
    # producing $null and bypassing the exact zero-length stdin contract.
    try { $inputStream.CopyTo($memory); return ,$memory.ToArray() }
    finally { $memory.Dispose() }
}
function Read-JsonFile([string] $Path) {
    return ([Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($Path)) | ConvertFrom-Json)
}
function Write-JsonFile([string] $Path, $Value) {
    [IO.File]::WriteAllText($Path, (Canonical-Json $Value -Newline), [Text.UTF8Encoding]::new($false))
}
function File-Sha256([string] $Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Bytes-Sha256([byte[]] $Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function Get-SourceSha256([string] $Path) {
    $sourceMatches = @($config.sourceRecords | Where-Object { [string] $_.path -ceq $Path })
    if ($sourceMatches.Count -ne 1 -or [string] $sourceMatches[0].sourceSha256 -cnotmatch "^[0-9a-f]{64}$") {
        throw "fixture source record missing"
    }
    return [string] $sourceMatches[0].sourceSha256
}
function ConvertTo-NativeArgument([AllowEmptyString()][string] $Value) {
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
function Invoke-RealNode([string[]] $Arguments, [byte[]] $InputBytes) {
    if ($config.realNodePath -isnot [string] -or -not [IO.File]::Exists([string] $config.realNodePath)) {
        throw "fixture real Node path missing"
    }
    if ($config.realNodeSha256 -isnot [string] -or [string] $config.realNodeSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        (File-Sha256 ([string] $config.realNodePath)) -cne [string] $config.realNodeSha256) {
        throw "fixture real Node digest mismatch"
    }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = [string] $config.realNodePath
    $start.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument ([string] $_) }) -join " ")
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    [void] $start.EnvironmentVariables.Clear()
    foreach ($entry in @{
        LC_ALL = "C"; SYSTEMROOT = $env:SystemRoot; TEMP = [IO.Path]::GetTempPath().TrimEnd('\');
        TMP = [IO.Path]::GetTempPath().TrimEnd('\'); WINDIR = $env:SystemRoot
    }.GetEnumerator()) { $start.EnvironmentVariables[[string] $entry.Key] = [string] $entry.Value }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "fixture real Node start failed" }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($null -ne $InputBytes -and $InputBytes.Length -gt 0) {
            $process.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
        }
        $process.StandardInput.Close()
        $process.WaitForExit()
        [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]] @($stdoutTask, $stderrTask))
        $stdoutBytes = Utf8-Bytes $stdoutTask.Result
        $stderrBytes = Utf8-Bytes $stderrTask.Result
        if ($stdoutBytes.Length -gt 2MB -or $stderrBytes.Length -gt 64KB) { throw "fixture real Node output exceeded bound" }
        [IO.File]::AppendAllText(
            (Join-Path $fixtureRoot "real-node-results.jsonl"),
            (Canonical-Json ([ordered]@{
                exitCode = [int] $process.ExitCode
                script = if ($Arguments.Count -gt 0) { [IO.Path]::GetFileName([string] $Arguments[0]) } else { "" }
                stderr = $stderrTask.Result.Trim()
            }) -Newline),
            [Text.UTF8Encoding]::new($false)
        )
        if ($stdoutBytes.Length -gt 0) { Write-Bytes $stdoutBytes }
        if ($stderrBytes.Length -gt 0) {
            $errorStream = [Console]::OpenStandardError()
            $errorStream.Write($stderrBytes, 0, $stderrBytes.Length)
            $errorStream.Flush()
        }
        return $process.ExitCode
    }
    finally { $process.Dispose() }
}
function Ensure-SafeName([string] $Value) {
    if ($Value -notmatch "^[A-Za-z0-9._-]{1,128}$") { throw "unsafe fixture object name" }
    return $Value
}
function Get-OptionValue([string[]] $Values, [string] $Name) {
    for ($index = 0; $index -lt $Values.Count - 1; $index += 1) {
        if ($Values[$index] -ceq $Name) { return [string] $Values[$index + 1] }
    }
    return $null
}
function Get-VolumeFromMount([string[]] $Values) {
    for ($index = 0; $index -lt $Values.Count - 1; $index += 1) {
        if ($Values[$index] -ceq "--mount" -and $Values[$index + 1] -match "(?:^|,)source=([^,]+)") {
            return Ensure-SafeName $Matches[1]
        }
    }
    throw "fixture volume mount missing"
}
function Get-VolumeDirectory([string] $Name) {
    return Join-Path $script:VolumeRoot (Ensure-SafeName $Name)
}
function Get-VolumeFilePath([string] $Name, [string] $Relative) {
    if ($Relative -notmatch "^[A-Za-z0-9._/-]{1,200}$" -or $Relative.Contains("..")) { throw "unsafe fixture volume path" }
    $root = Get-VolumeDirectory $Name
    $path = [IO.Path]::GetFullPath((Join-Path (Join-Path $root "fs") ($Relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))
    $prefix = [IO.Path]::GetFullPath((Join-Path $root "fs")).TrimEnd('\') + '\'
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "fixture volume path escaped" }
    return $path
}
function Get-ContainerDirectory([string] $Name) {
    return Join-Path $script:ContainerRoot (Ensure-SafeName $Name)
}
function Get-ContainerState([string] $Name) {
    return Read-JsonFile (Join-Path (Get-ContainerDirectory $Name) "state.json")
}
function Set-ContainerState([string] $Name, $State) {
    Write-JsonFile (Join-Path (Get-ContainerDirectory $Name) "state.json") $State
}
function Get-ContainerMetadata([string] $Name) {
    return Read-JsonFile (Join-Path (Get-ContainerDirectory $Name) "metadata.json")
}
function Set-ContainerLogs([string] $Name, [byte[]] $Bytes) {
    [IO.File]::WriteAllBytes((Join-Path (Get-ContainerDirectory $Name) "logs.bin"), $Bytes)
}
function Get-ControlVolume($Metadata) {
    $matches = @($Metadata.Mounts | Where-Object { $_.Destination -ceq "/var/lib/refunddesk/control" -and $_.Type -ceq "volume" })
    if ($matches.Count -ne 1) { throw "fixture control volume missing" }
    return [string] $matches[0].Name
}
function Get-InputVolume($Metadata) {
    $matches = @($Metadata.Mounts | Where-Object { $_.Destination -ceq "/var/lib/refunddesk/input" -and $_.Type -ceq "volume" -and $_.RW -eq $false })
    if ($matches.Count -ne 1) { throw "fixture immutable input volume missing" }
    return [string] $matches[0].Name
}
function Get-TerminalBytes([string] $Nonce, [string] $InputVolume) {
    $terminal = Read-JsonFile $env:REFUNDDESK_FIXTURE_TERMINAL_PATH
    $control = Read-JsonFile (Get-VolumeFilePath $InputVolume "control-$Nonce.json")
    $operationStarted = [DateTime]::ParseExact(
        [string] $control.operationStartedAt,
        "yyyy-MM-ddTHH:mm:ssZ",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    )
    $started = $operationStarted
    $terminal.nonce = $Nonce
    $terminal.expectedRevision = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
    $terminal.operationStartedAt = $started.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.startedAt = $started.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.window.openedAt = $started.AddSeconds(10).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.window.closedAt = $started.AddSeconds(25).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.window.deadlineAt = $started.AddSeconds(35).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.completedAt = $started.AddSeconds(35).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.prefixes.createDate = $started.AddMinutes(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.prefixes.fetchedAt = $started.AddSeconds(2).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.watchdog.armedAt = $started.AddSeconds(5).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.watchdog.deadlineAt = $terminal.window.deadlineAt
    $terminal.watchdog.armedBoottimeMilliseconds = 100000
    $terminal.watchdog.deadlineBoottimeMilliseconds = 130000
    $terminal.watchdog.closedBoottimeMilliseconds = 125000
    $terminal.watchdog.monotonicDurationMilliseconds = 25000
    $terminal.probes.workbench.capturedAt = $started.AddSeconds(15).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.probes.finalPostflight.capturedAt = $started.AddSeconds(30).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.probes.finalPostflight.validUntil = $started.AddSeconds(930).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $terminal.admission = $control.admission
    $terminal.provenance = $control.provenance
    foreach ($clockProjection in @(
        @("operationRemainingSecondsAtRunnerStart", [long] $control.operationRemainingSecondsAtRunnerStart),
        @("operatorBootIdentifierSha256", [string] $control.operatorBootIdentifierSha256),
        @("operatorControlCalculatedMonotonicMilliseconds", [long] $control.operatorControlCalculatedMonotonicMilliseconds),
        @("operatorDeadlineMonotonicMilliseconds", [long] $control.operatorDeadlineMonotonicMilliseconds),
        @("operatorStartedMonotonicMilliseconds", [long] $control.operatorStartedMonotonicMilliseconds),
        @("runnerBootIdentifierSha256", [string] $config.requestBootIdSha256),
        @("runnerStartedBoottimeMilliseconds", [long] 100000),
        @("runnerDeadlineBoottimeMilliseconds", [long] (100000 + [long] $control.operationRemainingSecondsAtRunnerStart * 1000))
    )) {
        $terminal.provenance | Add-Member -MemberType NoteProperty -Name ([string] $clockProjection[0]) -Value $clockProjection[1] -Force
    }
    foreach ($binding in @(
        @("awsAccountIdSha256", "authorizedAwsAccountIdSha256"),
        @("awsRegionSha256", "authorizedAwsRegionSha256"),
        @("sshCidrSha256", "authorizedSshCidrSha256")
    )) {
        $terminal.topology | Add-Member -MemberType NoteProperty -Name ([string] $binding[0]) -Value $control.admission.([string] $binding[1]) -Force
    }
    $terminal.origin.distributionIdSha256 = $control.admission.authorizedDistributionIdSha256
    $terminal.origin.originIdSha256 = $control.admission.authorizedOriginIdSha256
    $terminal.topology.finalCaddyContainerIdSha256 = $control.admission.promotionCaddyContainerIdSha256
    foreach ($databasePhase in @("before", "during", "after")) {
        $terminal.database.$databasePhase.systemIdentifierSha256 = $control.admission.promotionDatabaseSystemIdentifierSha256
    }
    $terminal.window.durationSeconds = [int] $control.windowSeconds
    return Utf8-Bytes (Canonical-Json $terminal -Newline)
}
function Get-RunnerControlRejection([string] $Nonce, [string] $InputVolume) {
    try {
        $control = Read-JsonFile (Get-VolumeFilePath $InputVolume "control-$Nonce.json")
        $expectedControlProperties = @(
            "admission", "eventFingerprintSha256", "expectedRevision", "kind", "nonce",
            "operationRemainingSecondsAtRunnerStart", "operationStartedAt", "operatorBootIdentifierSha256",
            "operatorControlCalculatedMonotonicMilliseconds", "operatorDeadlineMonotonicMilliseconds",
            "operatorStartedMonotonicMilliseconds",
            "postIncidentBaseline", "provenance", "schemaVersion", "windowSeconds"
        ) | Sort-Object -CaseSensitive
        $actualControlProperties = @($control.PSObject.Properties.Name | Sort-Object -CaseSensitive)
        if (($actualControlProperties -join "`n") -cne ($expectedControlProperties -join "`n")) {
            return "CONTROL_SHAPE_INVALID"
        }
        $admission = $control.admission
        if ($control.operationStartedAt -isnot [string] -or
            $control.operatorBootIdentifierSha256 -isnot [string] -or
            [string] $control.operatorBootIdentifierSha256 -cnotmatch "^[0-9a-f]{64}$" -or
            ($control.operatorStartedMonotonicMilliseconds -isnot [int] -and
                $control.operatorStartedMonotonicMilliseconds -isnot [long]) -or
            [long] $control.operatorStartedMonotonicMilliseconds -lt 0 -or
            ($control.operatorControlCalculatedMonotonicMilliseconds -isnot [int] -and
                $control.operatorControlCalculatedMonotonicMilliseconds -isnot [long]) -or
            [long] $control.operatorControlCalculatedMonotonicMilliseconds -lt 0 -or
            [long] $control.operatorControlCalculatedMonotonicMilliseconds -gt 9007199254740991 -or
            ($control.operatorDeadlineMonotonicMilliseconds -isnot [int] -and
                $control.operatorDeadlineMonotonicMilliseconds -isnot [long]) -or
            [long] $control.operatorDeadlineMonotonicMilliseconds -lt 0 -or
            [long] $control.operatorStartedMonotonicMilliseconds -gt (9007199254740991 - 2100000) -or
            [long] $control.operatorDeadlineMonotonicMilliseconds -gt 9007199254740991 -or
            [long] $control.operatorDeadlineMonotonicMilliseconds -ne
                ([long] $control.operatorStartedMonotonicMilliseconds + 2100000) -or
            ($control.operationRemainingSecondsAtRunnerStart -isnot [int] -and
                $control.operationRemainingSecondsAtRunnerStart -isnot [long]) -or
            [long] $control.operationRemainingSecondsAtRunnerStart -lt 1 -or
            [long] $control.operationRemainingSecondsAtRunnerStart -gt 1860 -or
            [long] $control.operatorControlCalculatedMonotonicMilliseconds -lt
                [long] $control.operatorStartedMonotonicMilliseconds -or
            [long] $control.operatorControlCalculatedMonotonicMilliseconds -ge
                [long] $control.operatorDeadlineMonotonicMilliseconds -or
            [long] $control.operationRemainingSecondsAtRunnerStart -gt
                ([long] [Math]::Floor(
                    ([long] $control.operatorDeadlineMonotonicMilliseconds -
                        [long] $control.operatorControlCalculatedMonotonicMilliseconds) / 1000
                ) - 240) -or
            ($admission.incidentRemainingSecondsAtStart -isnot [int] -and
                $admission.incidentRemainingSecondsAtStart -isnot [long]) -or
            [long] $admission.incidentRemainingSecondsAtStart -lt 720 -or
            [long] $admission.incidentRemainingSecondsAtStart -gt 900 -or
            ($admission.postflightRemainingSecondsAtStart -isnot [int] -and
                $admission.postflightRemainingSecondsAtStart -isnot [long]) -or
            [long] $admission.postflightRemainingSecondsAtStart -lt 720 -or
            [long] $admission.postflightRemainingSecondsAtStart -gt 900) {
            return "CONTROL_ADMISSION_TTL_INVALID"
        }
        $style = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        $culture = [Globalization.CultureInfo]::InvariantCulture
        $postflightCaptured = [DateTime]::ParseExact([string] $admission.postflightCapturedAt, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $postflightValidUntil = [DateTime]::ParseExact([string] $admission.postflightValidUntil, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $incidentCaptured = [DateTime]::ParseExact([string] $admission.incidentCapturedAt, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $incidentValidUntil = [DateTime]::ParseExact([string] $admission.incidentValidUntil, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $authorizationValidFrom = [DateTime]::ParseExact([string] $admission.authorizationValidFrom, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $authorizationValidUntil = [DateTime]::ParseExact([string] $admission.authorizationValidUntil, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $started = [DateTime]::ParseExact([string] $control.operationStartedAt, "yyyy-MM-ddTHH:mm:ssZ", $culture, $style)
        $postflightRemaining = [Math]::Floor(($postflightValidUntil - $started).TotalSeconds)
        $incidentRemaining = [Math]::Floor(($incidentValidUntil - $started).TotalSeconds)
        if (($postflightValidUntil - $postflightCaptured).TotalSeconds -ne 900 -or
            ($incidentValidUntil - $incidentCaptured).TotalSeconds -le 0 -or
            ($incidentValidUntil - $incidentCaptured).TotalSeconds -gt 900 -or
            $postflightRemaining -ne [long] $admission.postflightRemainingSecondsAtStart -or
            $incidentRemaining -ne [long] $admission.incidentRemainingSecondsAtStart -or
            $postflightCaptured -gt $incidentCaptured -or $incidentCaptured -gt $started -or
            $authorizationValidFrom -gt $started -or $authorizationValidUntil -lt $started.AddMinutes(35)) {
            return "CONTROL_ADMISSION_TTL_INVALID"
        }
        $clockObservation = [ordered]@{
            nonce = $Nonce
            operationRemainingSecondsAtRunnerStart = [long] $control.operationRemainingSecondsAtRunnerStart
            operatorBootIdentifierSha256 = [string] $control.operatorBootIdentifierSha256
            operatorControlCalculatedMonotonicMilliseconds = [long] $control.operatorControlCalculatedMonotonicMilliseconds
            operatorDeadlineMonotonicMilliseconds = [long] $control.operatorDeadlineMonotonicMilliseconds
            operatorStartedMonotonicMilliseconds = [long] $control.operatorStartedMonotonicMilliseconds
        }
        [IO.File]::AppendAllText(
            (Join-Path $fixtureRoot "operator-clock-observations.jsonl"),
            (Canonical-Json $clockObservation -Newline),
            [Text.UTF8Encoding]::new($false)
        )
    }
    catch { return "CONTROL_ADMISSION_TTL_INVALID" }
    return $null
}
function Get-RunnerTransportRejection([string] $Nonce, [string] $InputVolume) {
    $transportPath = Get-VolumeFilePath $InputVolume "transport-$Nonce.json"
    $transport = Read-JsonFile $transportPath
    $expectedProperties = @(
        "awsAccountId", "awsConfigSha256", "awsRegion", "caddyContainerId", "distributionId",
        "expectedSshCidr", "gitExecutable", "gitSha256", "instanceName", "nodeExecutable",
        "nodeSha256", "originId", "postgresContainerId", "publicBaseUrl", "sshConfigPath",
        "sshConfigSha256", "sshHost", "targetHost", "verifierContainerId", "webContainerId",
        "workerContainerId"
    ) | Sort-Object -CaseSensitive
    $actualProperties = @($transport.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if (($actualProperties -join "`n") -cne ($expectedProperties -join "`n")) {
        return "TRANSPORT_SHAPE_INVALID"
    }
    if ($transport.sshConfigPath -isnot [string] -or
        $transport.sshConfigPath -cne "/var/lib/refunddesk/input/ssh-config") {
        return "TRANSPORT_SSH_CONFIG_PATH_INVALID"
    }
    if ($transport.awsConfigSha256 -isnot [string] -or
        [string] $transport.awsConfigSha256 -cnotmatch "^[0-9a-f]{64}$" -or
        $transport.sshConfigSha256 -isnot [string] -or
        [string] $transport.sshConfigSha256 -cnotmatch "^[0-9a-f]{64}$") {
        return "TRANSPORT_CONFIG_DIGEST_INVALID"
    }
    if ((File-Sha256 (Get-VolumeFilePath $InputVolume "aws-config")) -cne [string] $transport.awsConfigSha256 -or
        (File-Sha256 (Get-VolumeFilePath $InputVolume "ssh-config")) -cne [string] $transport.sshConfigSha256) {
        return "TRANSPORT_CONFIG_DIGEST_INVALID"
    }
    return $null
}
function Stop-RunnerPreEffect([string] $Name, [string] $Nonce, [string] $InputVolume, $State, [string] $Code) {
    $terminal = Read-JsonFile $env:REFUNDDESK_FIXTURE_TERMINAL_PATH
    if (($terminal.exitCode -isnot [int] -and $terminal.exitCode -isnot [long]) -or [long] $terminal.exitCode -ne 21) {
        throw "fixture pre-effect rejection requires terminal exit 21"
    }
    [IO.File]::AppendAllText(
        (Join-Path $fixtureRoot "runner-pre-effect-rejections.jsonl"),
        (Canonical-Json ([ordered]@{ code = $Code; fixtureOnly = $true; nonce = $Nonce }) -Newline),
        [Text.UTF8Encoding]::new($false)
    )
    Set-ContainerLogs $Name (Get-TerminalBytes $Nonce $InputVolume)
    $State.Running = $false
    $State.ExitCode = 21
    $State.Status = "exited"
    $State.Stage = 90
    Set-ContainerState $Name $State
    return $State
}
function Set-TransportNegativeFixture([string] $Name, $Metadata) {
    $variant = [IO.Path]::GetFileName([string] $env:REFUNDDESK_FIXTURE_TERMINAL_PATH).ToLowerInvariant()
    if ($variant -notin @("transport-ssh-path-escape.json", "transport-aws-digest-drift.json")) { return }
    $nonceIndex = [Array]::IndexOf([object[]] @($Metadata.Config.Cmd), "--nonce")
    if ($nonceIndex -lt 0) { throw "fixture transport nonce missing" }
    $nonce = [string] $Metadata.Config.Cmd[$nonceIndex + 1]
    $inputVolume = Get-InputVolume $Metadata
    $transportPath = Get-VolumeFilePath $inputVolume "transport-$nonce.json"
    $transportItem = Get-Item -LiteralPath $transportPath -Force
    $transportItem.IsReadOnly = $false
    try {
        $transport = Read-JsonFile $transportPath
        if ($variant -ceq "transport-ssh-path-escape.json") {
            $transport.sshConfigPath = "/var/lib/refunddesk/input/../control/ssh-config"
        }
        else { $transport.awsConfigSha256 = "0" * 64 }
        Write-JsonFile $transportPath $transport
    }
    finally { (Get-Item -LiteralPath $transportPath -Force).IsReadOnly = $true }
}
function New-HostPostflightContainer([string] $Service, [int] $Index) {
    $core = @("postgres", "verifier", "web") -contains $Service
    $containerId = [string] $config.containerIds.$Service
    if ($containerId -cnotmatch "^[0-9a-f]{64}$") { throw "fixture container identity missing" }
    $imageDigit = if ($Service -ceq "caddy") { 7 } else { ($Index + 5) % 10 }
    $imageId = "sha256:" + (([string] $imageDigit) * 64)
    return [ordered]@{
        service = $Service
        presentCount = 1
        containerId = $containerId
        imageId = $imageId
        expectedImageId = $imageId
        imageReferenceMatches = $true
        noPublishedPorts = $true
        effectiveGlobalLiveDisabled = if ($Service -in @("worker", "web")) { $true } else { $null }
        effectiveLiveWebhookDisabled = if ($Service -ceq "web") { $true } else { $null }
        effectiveWorkerRuntimeMode = if ($Service -ceq "worker") { "INCIDENT_ADMISSION" } else { $null }
        status = if ($core) { "RUNNING" } else { "EXITED" }
        health = if ($core) { "HEALTHY" } else { "NONE" }
        projectLabelMatches = $true
        serviceLabelMatches = $true
        revisionLabel = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
    }
}
function New-HostPostflightCapture([string] $CapturedAt) {
    $composeSha256 = Get-SourceSha256 "deploy/lightsail/compose.yml"
    return [ordered]@{
        capturedAt = $CapturedAt
        identity = [ordered]@{
            activeRevision = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
            currentRevision = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
            sourceRevision = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
            releaseEnvironmentRevision = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
            releaseEnvironmentWorkerRuntimeMode = "INCIDENT_ADMISSION"
            manifestRevision = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
            composeSha256 = $composeSha256
            installedManifestSha256 = $composeSha256
            manifestSchemaValid = $true
        }
        containers = @(
            (New-HostPostflightContainer "postgres" 1)
            (New-HostPostflightContainer "verifier" 2)
            (New-HostPostflightContainer "worker" 3)
            (New-HostPostflightContainer "web" 4)
            (New-HostPostflightContainer "caddy" 5)
        )
        control = [ordered]@{
            operatorLockShared = $true
            transitionJournalPresent = $false
            transitionCommitMarkerValid = $true
            runtimeQuiesceJournalPresent = $false
            backupJournalPresent = $false
            legacyAppIdJournalPresent = $false
            managedTransitionInFlightPresent = $false
            managedTransitionCompletion = "VALID_PASS_CONTAINED"
            activeReleaseUnitCount = 0
            activeFenceUnitCount = 0
            releaseRuntimeMarkerCount = 0
            dockerInventoryAvailable = $true
            expectedImagesAvailable = $true
            sensitiveModesSafe = $true
        }
        surface = [ordered]@{
            platformLiveDisabled = $true
            workerLiveDisabled = $true
            liveWebhookDisabled = $true
            backupTimerActive = $false
            retentionTimerActive = $false
            backupServiceActive = $false
            retentionServiceActive = $false
            quiesceRecoveryActive = $false
            tcp80Listening = $false
            tcp443Listening = $false
            udp80Listening = $false
            udp443Listening = $false
            systemdInventoryAvailable = $true
            listenerInventoryAvailable = $true
            liveInterlocksAvailable = $true
            runtimeLiveInterlocksAvailable = $true
            unexpectedRunningContainerCount = 0
        }
        database = [ordered]@{
            snapshotAvailable = $true
            systemIdentifier = [string] $config.systemIdentifier
            activeWorkflows = 0
            unreleasedPaymentGuards = 0
            activeFinancialJobs = 0
            liveTenants = 0
            liveInstallations = 0
            preparedTransactions = 0
            refundRequests = 15
            refundExecutions = 14
            refundExecutionAttempts = 13
            webhookReceipts = 16
            apiMutationReceipts = 11
            auditEvents = 12
        }
    }
}
function Get-HostPostflightOuterBytes([string] $Nonce) {
    if ($Nonce -cnotmatch "^[0-9a-f]{64}$") { throw "fixture postflight nonce invalid" }
    $completed = [DateTime]::UtcNow
    $started = $completed.AddSeconds(-3)
    $captureA = New-HostPostflightCapture $completed.AddSeconds(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $captureB = New-HostPostflightCapture $completed.AddSeconds(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $remote = [ordered]@{
        schemaVersion = 1
        kind = "refunddesk.lightsail.host-postflight"
        nonce = $Nonce
        startedAt = $started.ToString("yyyy-MM-ddTHH:mm:ssZ")
        completedAt = $completed.ToString("yyyy-MM-ddTHH:mm:ssZ")
        exitCode = 0
        result = "PASS"
        code = "PASS_CONTAINED"
        posture = "COHERENT_CONTAINED"
        diagnostics = @()
        captures = [ordered]@{ a = $captureA; b = $captureB }
        containment = [ordered]@{
            liveDisabled = $true; workerStopped = $true; caddyStopped = $true; maintenanceStopped = $true
            publicListenersClosed = $true; journalsClosed = $true; fenceClosed = $true; sensitiveModesSafe = $true
        }
        availability = [ordered]@{
            capturesStable = $true; metadataCoherent = $true; containersCoherent = $true
            coreHealthy = $true; recoverableRuntimeStopped = $false
        }
        financial = [ordered]@{ snapshotAvailable = $true; stable = $true; quiescent = $true }
        redaction = [ordered]@{
            rawSecretPresent = $false; rawApiKeyPresent = $false; rawSignaturePresent = $false
            rawPayloadPresent = $false; customerDataPresent = $false; arbitraryPathPresent = $false; stderrPresent = $false
        }
    }

    # Each named fixture changes raw observation bytes while deliberately
    # leaving a claimed PASS summary behind.  The exact official validator,
    # not the incident projection, must reject every case.
    $variant = [IO.Path]::GetFileNameWithoutExtension($env:REFUNDDESK_FIXTURE_TERMINAL_PATH).ToLowerInvariant()
    if ($variant.Contains("postflight-caddy-running")) {
        foreach ($capture in @($remote.captures.a, $remote.captures.b)) {
            $caddy = @($capture.containers | Where-Object { $_.service -ceq "caddy" })[0]
            $caddy.status = "RUNNING"; $caddy.health = "HEALTHY"
        }
    }
    elseif ($variant.Contains("postflight-caddy-image")) {
        foreach ($capture in @($remote.captures.a, $remote.captures.b)) {
            $caddy = @($capture.containers | Where-Object { $_.service -ceq "caddy" })[0]
            $caddy.imageId = "sha256:" + ("9" * 64)
        }
    }
    elseif ($variant.Contains("postflight-listener")) {
        $remote.captures.a.surface.tcp443Listening = $true
        $remote.captures.b.surface.tcp443Listening = $true
    }
    elseif ($variant.Contains("postflight-derived-lie")) {
        $remote.captures.b.database.auditEvents = 13
    }

    $remoteBytes = Utf8-Bytes (Ordered-Json $remote -Newline)
    function Source-Provenance([string] $Path) {
        return [ordered]@{ gitObject = $null; sha256 = Get-SourceSha256 $Path }
    }
    $capturedAt = $started.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $outer = [ordered]@{
        schemaVersion = 1
        kind = "refunddesk.lightsail.host-postflight.capture"
        result = "PASS"
        admission = "FIXTURE_ONLY"
        posture = "COHERENT_CONTAINED"
        capturedAt = $capturedAt
        validUntil = $started.AddMinutes(15).ToString("yyyy-MM-ddTHH:mm:ssZ")
        remote = $remote
        awsControlPlane = [ordered]@{
            targetId = "refunddesk-sandbox-paris@eu-west-3"
            accountMatches = $true; regionMatches = $true; instanceMatches = $true; instanceRunning = $true
            firewallClosedBefore = $true; firewallClosedAfter = $true; firewallUnchanged = $true
        }
        provenance = [ordered]@{
            remoteDocumentSha256 = Bytes-Sha256 $remoteBytes
            observer = Source-Provenance "deploy/lightsail/scripts/observe-host-postflight.sh"
            validator = Source-Provenance "scripts/validate-lightsail-postflight.mjs"
            wrapper = Source-Provenance "scripts/invoke-lightsail-postflight.ps1"
            schema = Source-Provenance "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json"
            repositoryHead = $null
            revisionComposeVerified = $true
            transportInputsPinned = $true
            fixtureOnly = $true
        }
        redaction = [ordered]@{
            rawSecretPresent = $false; rawApiKeyPresent = $false; rawSignaturePresent = $false
            rawPayloadPresent = $false; customerDataPresent = $false; arbitraryPathPresent = $false
            ipAddressPresent = $false; stderrPresent = $false; keyDigestPresent = $false
        }
    }
    return Utf8-Bytes (Ordered-Json $outer -Newline)
}
function Advance-Runner([string] $Name, $Metadata, $State) {
    if (-not [bool] $State.Running) { return $State }
    $modeIndex = [Array]::IndexOf([object[]] @($Metadata.Config.Cmd), "--mode")
    $mode = if ($modeIndex -ge 0) { [string] $Metadata.Config.Cmd[$modeIndex + 1] } else { "" }
    $nonceIndex = [Array]::IndexOf([object[]] @($Metadata.Config.Cmd), "--nonce")
    $nonce = if ($nonceIndex -ge 0) { [string] $Metadata.Config.Cmd[$nonceIndex + 1] } else { throw "fixture nonce missing" }
    $volume = Get-ControlVolume $Metadata
    $inputVolume = Get-InputVolume $Metadata
    if ($mode -ceq "cleanup") {
        Set-ContainerLogs $Name (Get-TerminalBytes $nonce $inputVolume)
        $terminal = Read-JsonFile $env:REFUNDDESK_FIXTURE_TERMINAL_PATH
        $State.Running = $false
        $State.ExitCode = [int] $terminal.exitCode
        $State.Status = "exited"
        $State.Stage = 9
        Set-ContainerState $Name $State
        return $State
    }
    if ([int] $State.Stage -eq 0) {
        $transportRejection = Get-RunnerTransportRejection $nonce $inputVolume
        if ($null -ne $transportRejection) {
            return Stop-RunnerPreEffect $Name $nonce $inputVolume $State $transportRejection
        }
        $controlRejection = Get-RunnerControlRejection $nonce $inputVolume
        if ($null -ne $controlRejection) {
            return Stop-RunnerPreEffect $Name $nonce $inputVolume $State $controlRejection
        }
        $controlPath = Get-VolumeFilePath $inputVolume "control-$nonce.json"
        $control = Read-JsonFile $controlPath
        $now = [DateTime]::UtcNow
        $request = [ordered]@{
            deadlineAt = $now.AddSeconds([Math]::Max(60, [int] $control.windowSeconds)).ToString("yyyy-MM-ddTHH:mm:ssZ")
            eventFingerprintSha256 = [string] $control.eventFingerprintSha256
            expectedRevision = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
            kind = "refunddesk.operator-workbench-request"
            nonce = $nonce
            openedAt = $now.AddSeconds(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")
            schemaVersion = 1
        }
        $requestPath = Get-VolumeFilePath $volume "workbench-request-$nonce.json"
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($requestPath)) | Out-Null
        if (-not [IO.File]::Exists($requestPath)) { [IO.File]::WriteAllText($requestPath, (Canonical-Json $request -Newline), [Text.UTF8Encoding]::new($false)) }
        $State.Stage = 1
        Set-ContainerState $Name $State
    }
    $checkpointPath = Get-VolumeFilePath $volume "workbench-$nonce.json"
    if ([int] $State.Stage -eq 1 -and [IO.File]::Exists($checkpointPath)) {
        $request = [ordered]@{
            expectedRevision = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
            kind = "refunddesk.edge-window-final-postflight-request"
            nonce = $nonce
            requestBootIdSha256 = [string] $config.requestBootIdSha256
            requestedAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
            requestedBoottimeMilliseconds = [long] $config.requestedBoottimeMilliseconds
            schemaVersion = 1
        }
        $requestPath = Get-VolumeFilePath $volume "edge-window-operation-$nonce/final-postflight-request.json"
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($requestPath)) | Out-Null
        if (-not [IO.File]::Exists($requestPath)) { [IO.File]::WriteAllText($requestPath, (Canonical-Json $request -Newline), [Text.UTF8Encoding]::new($false)) }
        $State.Stage = 2
        Set-ContainerState $Name $State
    }
    $capturePath = Get-VolumeFilePath $volume "edge-window-operation-$nonce/final-postflight-capture.json"
    if ([int] $State.Stage -eq 2 -and [IO.File]::Exists($capturePath)) {
        # This exact fixture models a runner that reached terminal exit 21
        # after an immutable-input/source failure but could not emit admissible
        # JSON.  The zero-byte log file is deliberate: Docker logs succeeds,
        # while the wrapper must refuse to classify or consume a terminal.
        $noStdout = [IO.Path]::GetFileName([string] $env:REFUNDDESK_FIXTURE_TERMINAL_PATH) -ceq "runner-exit21-no-stdout.json"
        $bytes = if ($noStdout) { ,([byte[]]::new(0)) } else { Get-TerminalBytes $nonce $inputVolume }
        Set-ContainerLogs $Name $bytes
        $terminal = Read-JsonFile $env:REFUNDDESK_FIXTURE_TERMINAL_PATH
        $State.Running = $false
        $State.ExitCode = [int] $terminal.exitCode
        $State.Status = "exited"
        $State.Stage = 3
        Set-ContainerState $Name $State
    }
    return $State
}

$fixtureRoot = [IO.Path]::GetFullPath($env:REFUNDDESK_FIXTURE_ROOT)
$script:VolumeRoot = Join-Path $fixtureRoot "fake-volumes"
$script:ContainerRoot = Join-Path $fixtureRoot "fake-containers"
[IO.Directory]::CreateDirectory($script:VolumeRoot) | Out-Null
[IO.Directory]::CreateDirectory($script:ContainerRoot) | Out-Null
$config = Read-JsonFile (Join-Path $fixtureRoot "fixture-config.json")
$argumentText = [Text.UTF8Encoding]::new($false, $true).GetString([Convert]::FromBase64String($env:REFUNDDESK_FIXTURE_ARGUMENTS_BASE64))
$decodedArguments = $argumentText | ConvertFrom-Json
$arguments = @()
foreach ($decodedArgument in $decodedArguments) { $arguments += [string] $decodedArgument }
$stdinBytes = Read-StdinBytes

$lock = $null
for ($attempt = 0; $attempt -lt 200 -and $null -eq $lock; $attempt += 1) {
    try { $lock = [IO.FileStream]::new((Join-Path $fixtureRoot "fake-tool.lock"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { Start-Sleep -Milliseconds 25 }
}
if ($null -eq $lock) { throw "fixture tool lock timeout" }
try {
    $log = [ordered]@{
        arguments = @($arguments)
        stdinLength = [long] $stdinBytes.Length
        stdinSha256 = Bytes-Sha256 $stdinBytes
        tool = $env:REFUNDDESK_FIXTURE_TOOL
    }
    [IO.File]::AppendAllText((Join-Path $fixtureRoot "operations.jsonl"), (Canonical-Json $log -Newline), [Text.UTF8Encoding]::new($false))

    if ($env:REFUNDDESK_FIXTURE_TOOL -ceq "node") {
        $scriptName = if ($arguments.Count -gt 0) { [IO.Path]::GetFileName([string] $arguments[0]) } else { "" }
        if ($scriptName -ceq "validate-lightsail-contained-promotion.mjs") {
            Write-Text '{"code":"PASS_CONTAINED_CANDIDATE_PROMOTED","result":"PASS"}'
        }
        elseif ($scriptName -ceq "validate-lightsail-incident-admission.mjs") {
            $kindIndex = [Array]::IndexOf([object[]] $arguments, "--kind")
            $kind = if ($kindIndex -ge 0) { [string] $arguments[$kindIndex + 1] } else { "" }
            if ($kind -ceq "capture") {
                $candidate = [Text.UTF8Encoding]::new($false, $true).GetString($stdinBytes) | ConvertFrom-Json
                if ($candidate.capturedAt -isnot [string] -or $candidate.validUntil -isnot [string]) {
                    [Console]::Error.Write("incident-validation-error:CAPTURE_TTL_INVALID`n")
                    exit 1
                }
                $summary = [ordered]@{
                    admission = "ADMISSIBLE_CURRENT_STRIPE_BINDING_INCIDENT"
                    capturedAt = [string] $candidate.capturedAt
                    code = "PASS_INCIDENT_ADMITTED_CONTAINED"
                    exitCode = 0
                    remote = [ordered]@{ code = "PASS_INCIDENT_ADMITTED_CONTAINED"; exitCode = 0; result = "PASS" }
                    remoteDocument = [ordered]@{ exitCode = 0 }
                    result = "PASS"
                    validUntil = [string] $candidate.validUntil
                }
                Write-Text (Canonical-Json $summary)
            }
            else {
                $candidate = [Text.UTF8Encoding]::new($false, $true).GetString($stdinBytes) | ConvertFrom-Json
                $candidateKind = if ($null -ne $candidate.PSObject.Properties["kind"]) { [string] $candidate.kind } else { "" }
                if ($candidateKind -ceq "refunddesk.lightsail.host-postflight.capture") {
                    if ($null -eq $candidate.provenance -or $candidate.provenance.fixtureOnly -ne $true -or
                        $candidate.result -cne "PASS" -or $candidate.posture -cne "COHERENT_CONTAINED" -or
                        $null -eq $candidate.remote -or $candidate.provenance.remoteDocumentSha256 -isnot [string]) {
                        [Console]::Error.Write("incident-validation-error:POSTFLIGHT_FIXTURE_INVALID`n")
                        exit 1
                    }
                    $candidateRemoteBytes = Utf8-Bytes (Ordered-Json $candidate.remote -Newline)
                    if ((Bytes-Sha256 $candidateRemoteBytes) -cne [string] $candidate.provenance.remoteDocumentSha256) {
                        [Console]::Error.Write("incident-validation-error:POSTFLIGHT_REMOTE_DIGEST_INVALID`n")
                        exit 1
                    }
                    # The exact incident projection admits these outer bytes,
                    # including the four intentionally inconsistent ADR 0034
                    # observations.  Delegating it here demonstrates why the
                    # second, complete postflight validator is independently
                    # necessary rather than merely duplicating the first gate.
                    exit (Invoke-RealNode $arguments $stdinBytes)
                }
                Write-Text '{"code":"PASS_POSTFLIGHT_VALID","result":"PASS"}'
            }
        }
        elseif ($scriptName -ceq "validate-lightsail-postflight.mjs") {
            # Delegate this one boundary to the exact copied validator.  It is
            # still reached through the bounded fake-Node process, with the
            # same stdin bytes and argv that production receives.
            exit (Invoke-RealNode $arguments $stdinBytes)
        }
        elseif ($scriptName -ceq "validate-edge-operator-image.mjs") {
            Write-Text '{"code":"PASS_EDGE_OPERATOR_IMAGE_VALID","result":"PASS"}'
        }
        elseif ($scriptName -ceq "validate-lightsail-edge-window.mjs") {
            if ($arguments -contains "--workbench") { Write-Text "PASS_WORKBENCH_CHECKPOINT`n" }
            else { exit (Invoke-RealNode $arguments $stdinBytes) }
        }
        else { throw "unexpected fixture node command: $scriptName" }
        exit 0
    }

    if ($env:REFUNDDESK_FIXTURE_TOOL -ceq "gh") {
        if ($arguments.Count -ge 2 -and $arguments[0] -ceq "attestation" -and $arguments[1] -ceq "verify") {
            $archivePath = [string] $arguments[2]
            $attestation = @([ordered]@{
                attestation = [ordered]@{ verificationMaterial = [ordered]@{ tlogEntries = @([ordered]@{ logIndex = [long] $config.rekorEntryIndex }) } }
                verificationResult = [ordered]@{
                    statement = [ordered]@{
                        predicate = [ordered]@{ runDetails = [ordered]@{ metadata = [ordered]@{ invocationId = "https://github.com/selimhehe1/RefundDesk/actions/runs/$([long] $config.workflowRunId)/attempts/$([long] $config.workflowRunAttempt)" } } }
                        predicateType = "https://slsa.dev/provenance/v1"
                        subject = @([ordered]@{ digest = [ordered]@{ sha256 = [string] $config.archiveSha256 }; name = [IO.Path]::GetFileName($archivePath) })
                    }
                    verifiedTimestamps = @("fixture")
                }
            })
            Write-Text (Canonical-Json $attestation)
        }
        elseif ($arguments.Count -gt 0 -and $arguments[0] -ceq "api") {
            $run = [ordered]@{
                conclusion = "success"
                event = "workflow_dispatch"
                headBranch = "main"
                headSha = $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION
                path = ".github/workflows/sandbox-images.yml"
                repository = "selimhehe1/RefundDesk"
                runAttempt = [long] $config.workflowRunAttempt
                status = "completed"
                workflowId = 37
            }
            Write-Text (Canonical-Json $run)
        }
        else { throw "unexpected fixture gh command" }
        exit 0
    }

    if ($env:REFUNDDESK_FIXTURE_TOOL -ceq "postflight") {
        if ($arguments.Count -ne 2 -or $arguments[0] -cne $env:REFUNDDESK_FIXTURE_EXPECTED_REVISION) {
            throw "fixture postflight arguments invalid"
        }
        Write-Bytes (Get-HostPostflightOuterBytes ([string] $arguments[1]))
        exit 0
    }

    if ($env:REFUNDDESK_FIXTURE_TOOL -cne "docker") { throw "unknown fixture tool" }
    $dockerArguments = @($arguments)
    if ($dockerArguments.Count -ge 2 -and $dockerArguments[0] -ceq "--host") { $dockerArguments = @($dockerArguments[2..($dockerArguments.Count - 1)]) }
    if ($dockerArguments[0] -ceq "version") { Write-Text "29.1.0`n"; exit 0 }
    if ($dockerArguments[0] -ceq "info") {
        Write-Text '{"Architecture":"amd64","Name":"docker-desktop","OSType":"linux","OperatingSystem":"Docker Desktop"}'
        exit 0
    }
    if ($dockerArguments[0] -ceq "image" -and $dockerArguments[1] -ceq "load") {
        [IO.File]::WriteAllText((Join-Path $fixtureRoot "fake-image.present"), [string] $config.imageId)
        Write-Text "Loaded image fixture`n"
        exit 0
    }
    if ($dockerArguments[0] -ceq "image" -and $dockerArguments[1] -ceq "rm") {
        Remove-Item -LiteralPath (Join-Path $fixtureRoot "fake-image.present") -Force -ErrorAction SilentlyContinue
        Write-Text "$($config.imageId)`n"
        exit 0
    }
    if ($dockerArguments[0] -ceq "image" -and $dockerArguments[1] -ceq "inspect") {
        if (-not [IO.File]::Exists((Join-Path $fixtureRoot "fake-image.present"))) { exit 1 }
        if ($dockerArguments -contains "--format") { Write-Text "$($config.imageId)`n"; exit 0 }
        $image = [ordered]@{
            Architecture = "amd64"
            Config = $config.imageConfig
            Id = [string] $config.imageId
            Os = "linux"
        }
        Write-Text (Canonical-Json @($image))
        exit 0
    }
    if ($dockerArguments[0] -ceq "volume" -and $dockerArguments[1] -ceq "create") {
        $name = Ensure-SafeName ([string] $dockerArguments[-1])
        $directory = Get-VolumeDirectory $name
        if ([IO.Directory]::Exists($directory)) { exit 1 }
        [IO.Directory]::CreateDirectory((Join-Path $directory "fs")) | Out-Null
        $labels = [ordered]@{}
        for ($index = 2; $index -lt $dockerArguments.Count - 1; $index += 1) {
            if ($dockerArguments[$index] -ceq "--label") {
                $parts = ([string] $dockerArguments[$index + 1]).Split([char[]] @('='), 2, [StringSplitOptions]::None)
                $labels[$parts[0]] = $parts[1]
                $index += 1
            }
        }
        Write-JsonFile (Join-Path $directory "metadata.json") ([ordered]@{ Driver = "local"; Labels = $labels; Name = $name; Scope = "local" })
        Write-Text "$name`n"
        exit 0
    }
    if ($dockerArguments[0] -ceq "volume" -and $dockerArguments[1] -ceq "inspect") {
        $name = Ensure-SafeName ([string] $dockerArguments[-1])
        $directory = Get-VolumeDirectory $name
        if (-not [IO.Directory]::Exists($directory)) { exit 1 }
        Write-Text (Canonical-Json @((Read-JsonFile (Join-Path $directory "metadata.json"))))
        exit 0
    }
    if ($dockerArguments[0] -ceq "volume" -and $dockerArguments[1] -ceq "rm") {
        $name = Ensure-SafeName ([string] $dockerArguments[-1])
        $directory = Get-VolumeDirectory $name
        if (-not [IO.Directory]::Exists($directory)) { exit 1 }
        foreach ($file in @(Get-ChildItem -LiteralPath $directory -File -Recurse -Force)) {
            if ($file.IsReadOnly) { $file.IsReadOnly = $false }
        }
        [IO.Directory]::Delete($directory, $true)
        Write-Text "$name`n"
        exit 0
    }
    if ($dockerArguments[0] -ceq "run") {
        $programIndex = [Array]::IndexOf([object[]] $dockerArguments, "-c")
        $program = if ($programIndex -ge 0) { [string] $dockerArguments[$programIndex + 1] } else { "" }
        if ($program.Contains("REFUNDDESK_IMMUTABLE_INPUT_BUNDLE_V1")) {
            $volume = Get-VolumeFromMount $dockerArguments
            $root = Join-Path (Get-VolumeDirectory $volume) "fs"
            if (@(Get-ChildItem -LiteralPath $root -Force).Count -ne 0) { exit 64 }
            $payload = [Text.UTF8Encoding]::new($false, $true).GetString($stdinBytes) | ConvertFrom-Json
            # The nonce is passed as the final Docker argument; do not trust a
            # fixture-only environment shortcut when emulating the production
            # helper's exact-name contract.
            $nonce = [string] $dockerArguments[-1]
            $expectedNames = @("aws-config", "control-$nonce.json", "ssh-config", "transport-$nonce.json") | Sort-Object -CaseSensitive
            $actualNames = @($payload.PSObject.Properties.Name | Sort-Object -CaseSensitive)
            if (($actualNames -join "`n") -cne ($expectedNames -join "`n")) { exit 64 }
            foreach ($property in $payload.PSObject.Properties) {
                $path = Get-VolumeFilePath $volume ([string] $property.Name)
                [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String([string] $property.Value))
                (Get-Item -LiteralPath $path -Force).IsReadOnly = $true
            }
            Write-JsonFile (Join-Path (Get-VolumeDirectory $volume) "sealed.json") ([ordered]@{ fixtureOnly = $true; mode = "root-0555-files-0444" })
            exit 0
        }
        if ($program.Contains("REFUNDDESK_IMMUTABLE_INPUT_ASSERT_V1")) {
            $volume = Get-VolumeFromMount $dockerArguments
            $sealPath = Join-Path (Get-VolumeDirectory $volume) "sealed.json"
            if (-not [IO.File]::Exists($sealPath)) { exit 64 }
            $expected = [Text.UTF8Encoding]::new($false, $true).GetString($stdinBytes) | ConvertFrom-Json
            $actualItems = @(Get-ChildItem -LiteralPath (Join-Path (Get-VolumeDirectory $volume) "fs") -Force)
            $actualNames = @($actualItems.Name | Sort-Object -CaseSensitive)
            $expectedNames = @($expected.PSObject.Properties.Name | Sort-Object -CaseSensitive)
            if (($actualNames -join "`n") -cne ($expectedNames -join "`n")) { exit 64 }
            foreach ($property in $expected.PSObject.Properties) {
                $path = Get-VolumeFilePath $volume ([string] $property.Name)
                $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
                if ($null -eq $item -or $item.PSIsContainer -or
                    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.IsReadOnly -or
                    (File-Sha256 $path) -cne [string] $property.Value) { exit 65 }
            }
            exit 0
        }
        if ($program.Contains('os.O_WRONLY|os.O_CREAT|os.O_EXCL')) {
            $volume = Get-VolumeFromMount $dockerArguments
            $relative = [string] $dockerArguments[-1]
            $path = Get-VolumeFilePath $volume $relative
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
            $stream = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $stream.Write($stdinBytes, 0, $stdinBytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
            exit 0
        }
        if ($program.Contains('sys.exit(3) if not os.path.isfile')) {
            $volume = Get-VolumeFromMount $dockerArguments
            $path = Get-VolumeFilePath $volume ([string] $dockerArguments[-1])
            if (-not [IO.File]::Exists($path)) { exit 3 }
            Write-Bytes ([IO.File]::ReadAllBytes($path))
            exit 0
        }
        if ($program.Contains('cmds={')) { Write-Text (Canonical-Json $config.tools); exit 0 }
        if ($program.Contains('root=pathlib.Path("/workspace")')) { Write-Text (Canonical-Json @($config.sourceRecords)); exit 0 }
        if ($program.Contains('cloudfront.')) {
            $volume = Get-VolumeFromMount $dockerArguments
            $files = @(Get-ChildItem -LiteralPath (Join-Path (Get-VolumeDirectory $volume) "fs") -File -Recurse -Force | Where-Object {
                $_.Name -ceq "origin-token" -or ($_.Name.StartsWith("cloudfront.") -and $_.Name.EndsWith(".json"))
            })
            if ($files.Count -ne 0) { exit 1 }
            exit 0
        }
        throw "unexpected fixture docker run"
    }
    if ($dockerArguments[0] -ceq "container" -and $dockerArguments[1] -ceq "create") {
        $name = Ensure-SafeName (Get-OptionValue $dockerArguments "--name")
        $directory = Get-ContainerDirectory $name
        if ([IO.Directory]::Exists($directory)) { exit 1 }
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $imageIndex = [Array]::IndexOf([object[]] $dockerArguments, [string] $config.imageId)
        if ($imageIndex -lt 0) { throw "fixture image id missing" }
        $command = if ($imageIndex + 1 -lt $dockerArguments.Count) { @($dockerArguments[($imageIndex + 1)..($dockerArguments.Count - 1)]) } else { @() }
        $labels = [ordered]@{}
        if ($null -ne $config.imageConfig.Labels) {
            foreach ($property in $config.imageConfig.Labels.PSObject.Properties) { $labels[$property.Name] = [string] $property.Value }
        }
        $environment = @($config.imageConfig.Env)
        $mounts = @()
        $tmpfs = [ordered]@{}
        for ($index = 2; $index -lt $imageIndex; $index += 1) {
            if ($dockerArguments[$index] -ceq "--label") {
                $parts = ([string] $dockerArguments[$index + 1]).Split([char[]] @('='), 2, [StringSplitOptions]::None); $labels[$parts[0]] = $parts[1]; $index += 1
            }
            elseif ($dockerArguments[$index] -ceq "--env") { $environment += [string] $dockerArguments[$index + 1]; $index += 1 }
            elseif ($dockerArguments[$index] -ceq "--tmpfs") {
                $parts = ([string] $dockerArguments[$index + 1]).Split([char[]] @(':'), 2, [StringSplitOptions]::None); $tmpfs[$parts[0]] = $parts[1]; $index += 1
            }
            elseif ($dockerArguments[$index] -ceq "--mount") {
                $specification = [string] $dockerArguments[$index + 1]
                $values = @{}
                foreach ($part in $specification.Split(',')) {
                    $pair = $part.Split([char[]] @('='), 2, [StringSplitOptions]::None)
                    if ($pair.Count -eq 2) { $values[$pair[0]] = $pair[1] } else { $values[$part] = $true }
                }
                if ($values.type -ceq "volume") {
                    $readOnly = $values.ContainsKey("readonly")
                    $mounts += [ordered]@{ Destination = [string] $values.target; Driver = "local"; Mode = "z"; Name = [string] $values.source; Propagation = ""; RW = (-not $readOnly); Type = "volume" }
                }
                else {
                    $mounts += [ordered]@{ Destination = [string] $values.target; Mode = ""; Propagation = "rprivate"; RW = $false; Source = [IO.Path]::GetFullPath([string] $values.source); Type = "bind" }
                }
                $index += 1
            }
        }
        $metadata = [ordered]@{
            Config = [ordered]@{
                Cmd = @($command)
                Entrypoint = @($config.imageConfig.Entrypoint)
                Env = @($environment)
                ExposedPorts = $null
                Image = [string] $config.imageId
                Labels = $labels
                User = "10001:10001"
            }
            HostConfig = [ordered]@{
                CapAdd = @()
                CapDrop = @("ALL")
                IpcMode = "private"
                Memory = 536870912
                NanoCpus = 1000000000
                NetworkMode = "bridge"
                PidMode = "private"
                PidsLimit = 256
                PortBindings = $null
                Privileged = $false
                PublishAllPorts = $false
                ReadonlyRootfs = $true
                RestartPolicy = [ordered]@{ Name = "no" }
                SecurityOpt = @("no-new-privileges")
                Tmpfs = $tmpfs
                UTSMode = "private"
                UsernsMode = ""
            }
            Image = [string] $config.imageId
            Mounts = @($mounts)
            Name = "/$name"
            State = [ordered]@{ ExitCode = 0; Running = $false; Stage = 0; Status = "created" }
        }
        Write-JsonFile (Join-Path $directory "metadata.json") $metadata
        Write-JsonFile (Join-Path $directory "state.json") ([ordered]@{ ExitCode = 0; Running = $false; Stage = 0; Status = "created" })
        Write-Text "$name`n"
        exit 0
    }
    if ($dockerArguments[0] -ceq "container" -and $dockerArguments[1] -ceq "start") {
        $name = Ensure-SafeName ([string] $dockerArguments[-1])
        if (-not [IO.Directory]::Exists((Get-ContainerDirectory $name))) { exit 1 }
        $state = Get-ContainerState $name
        $state.Running = $true; $state.ExitCode = 0; $state.Stage = 0; $state.Status = "running"
        Set-ContainerState $name $state
        $metadata = Get-ContainerMetadata $name
        Set-TransportNegativeFixture $name $metadata
        $modeIndex = [Array]::IndexOf([object[]] @($metadata.Config.Cmd), "--mode")
        if ($modeIndex -ge 0 -and $metadata.Config.Cmd[$modeIndex + 1] -ceq "cleanup") { [void] (Advance-Runner $name $metadata $state) }
        Write-Text "$name`n"
        exit 0
    }
    if ($dockerArguments[0] -ceq "container" -and $dockerArguments[1] -ceq "inspect") {
        $name = Ensure-SafeName ([string] $dockerArguments[-1])
        if (-not [IO.Directory]::Exists((Get-ContainerDirectory $name))) { exit 1 }
        $metadata = Get-ContainerMetadata $name
        $state = Advance-Runner $name $metadata (Get-ContainerState $name)
        if ($dockerArguments -contains "--format") { Write-Text (Canonical-Json $state); exit 0 }
        $metadata.State = $state
        Write-Text (Canonical-Json @($metadata))
        exit 0
    }
    if ($dockerArguments[0] -ceq "container" -and $dockerArguments[1] -ceq "logs") {
        $name = Ensure-SafeName ([string] $dockerArguments[-1])
        $path = Join-Path (Get-ContainerDirectory $name) "logs.bin"
        if (-not [IO.File]::Exists($path)) { exit 1 }
        Write-Bytes ([IO.File]::ReadAllBytes($path))
        exit 0
    }
    if ($dockerArguments[0] -ceq "container" -and $dockerArguments[1] -ceq "kill") {
        $name = Ensure-SafeName ([string] $dockerArguments[-1])
        if (-not [IO.Directory]::Exists((Get-ContainerDirectory $name))) { exit 1 }
        $state = Get-ContainerState $name; $state.Running = $false; $state.ExitCode = 21; $state.Status = "exited"
        Set-ContainerState $name $state
        if (-not [IO.File]::Exists((Join-Path (Get-ContainerDirectory $name) "logs.bin"))) {
            $metadata = Get-ContainerMetadata $name
            $nonceIndex = [Array]::IndexOf([object[]] @($metadata.Config.Cmd), "--nonce")
            if ($nonceIndex -ge 0) {
                $inputVolume = Get-InputVolume $metadata
                Set-ContainerLogs $name (Get-TerminalBytes ([string] $metadata.Config.Cmd[$nonceIndex + 1]) $inputVolume)
            }
        }
        exit 0
    }
    if ($dockerArguments[0] -ceq "container" -and $dockerArguments[1] -ceq "rm") {
        $name = Ensure-SafeName ([string] $dockerArguments[-1])
        $directory = Get-ContainerDirectory $name
        if (-not [IO.Directory]::Exists($directory)) { exit 1 }
        [IO.Directory]::Delete($directory, $true)
        Write-Text "$name`n"
        exit 0
    }
    throw "unexpected fixture docker command: $($dockerArguments -join ' ')"
}
finally {
    $lock.Dispose()
}
