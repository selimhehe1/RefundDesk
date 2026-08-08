[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $PreflightEvidencePath,

    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string] $ExpectedSshCidr,

    [Parameter()]
    [switch] $ContractFixture,

    [Parameter()]
    [string] $FixtureToolDirectory,

    [Parameter()]
    [string] $FixtureEvidencePath,

    [Parameter()]
    [ValidateRange(1, 15)]
    [int] $FixtureTimeoutSeconds = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ExpectedAwsAccount = "633229204288"
$ExpectedAwsRegion = "eu-west-3"
$ExpectedInstanceName = "refunddesk-sandbox-paris"
$ExpectedRevision = "8da280b78a9d1475c7bd79063e72c5af77121e8d"
$ExpectedComposeSha256 = "92a96553a38b226505957e717e2844960794256dceb5a5284fde0c00d22b4610"
$ExpectedManifestSha256 = "e72319926d184db8e696c7d4d032d3f9e44cbabbde9b36e64c473da96ef241ca"
$ExpectedImageIds = [ordered]@{
    postgres = "sha256:0a314d409a9633cff4f89dc18482262625c0ee78cb1aa2ff8e47bc6da0251e1b"
    verifier = "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe"
    worker = "sha256:e3ead31f6c3084b69731e095a250b8d0a4e3e9d6e8d239dccf077e6b90d53f64"
    web = "sha256:c1d13b7db80e019e8a0ea24717c2a2028052b5959e1aaf65746336073606601f"
    caddy = "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe"
}
$ExpectedIdentitySha256 = "59686a4e392a5c279ab0d71fae083a1907ef952d03acc286c5a90288dc122f5b"
$ExpectedKnownHostsSha256 = "3d15ffcd3aaedc3505648f86c565da70679253fc51e34679c2651dcbe10eb854"
$PinnedAwsPath = "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
$PinnedAwsSha256 = "adec66edbf500c5863659e5720a68400aa2a735a0defee7223571c9373e1d537"
$PinnedSshPath = "C:\Windows\System32\OpenSSH\ssh.exe"
$PinnedSshSha256 = "8607ff933e769e77534b1244e39965bcf1c904dbfd4b9da819bbb71034cfef88"
$PinnedNodePath = "C:\Program Files\nodejs\node.exe"
$PinnedNodeSha256 = "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de"
$PinnedGitPath = "C:\Program Files\Git\cmd\git.exe"
$PinnedGitSha256 = "5385ff9ae361ca41e7a31b335fc0d81f2de9c35fc62a165c5e34850d837b59cc"
$MaximumAwsOutputBytes = 262144
$MaximumSshOutputBytes = 131072
$MaximumDiagnosticBytes = 32768
$MaximumValidatorOutputBytes = 1048576
$MaximumPreflightBytes = 1048576

function Throw-SafeError {
    param(
        [Parameter(Mandatory = $true)]
        [ValidatePattern("^[A-Z][A-Z0-9_]{0,63}$")]
        [string] $Code
    )

    throw [System.InvalidOperationException]::new("REFUNDDESK_$Code")
}

function Get-UtcTimestamp {
    return [DateTime]::UtcNow.ToString(
        "yyyy-MM-ddTHH:mm:ssZ",
        [Globalization.CultureInfo]::InvariantCulture
    )
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Open-VerifiedReadLock {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedSha256,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $stream = $null
    $algorithm = $null
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read,
            65536,
            [IO.FileOptions]::SequentialScan
        )
        $algorithm = [Security.Cryptography.SHA256]::Create()
        $actualSha256 = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        if ($actualSha256 -cne $ExpectedSha256) {
            Throw-SafeError $FailureCode
        }
        return [pscustomobject]@{
            Stream = $stream
            Sha256 = $actualSha256
        }
    }
    catch {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError $FailureCode
    }
    finally {
        if ($null -ne $algorithm) {
            $algorithm.Dispose()
        }
    }
}

function Get-LockedFileSha256 {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $stream = $null
    $algorithm = $null
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read,
            65536,
            [IO.FileOptions]::SequentialScan
        )
        $algorithm = [Security.Cryptography.SHA256]::Create()
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    catch {
        Throw-SafeError $FailureCode
    }
    finally {
        if ($null -ne $algorithm) {
            $algorithm.Dispose()
        }
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Read-LockedFileBytes {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][ValidateRange(1, 1048576)][int] $MaximumBytes,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $stream = $null
    $memory = $null
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read,
            65536,
            [IO.FileOptions]::SequentialScan
        )
        if ($stream.Length -le 0 -or $stream.Length -gt $MaximumBytes) {
            Throw-SafeError $FailureCode
        }
        $memory = [IO.MemoryStream]::new([int] $stream.Length)
        $buffer = New-Object byte[] 65536
        while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if (($memory.Length + $count) -gt $MaximumBytes) {
                Throw-SafeError $FailureCode
            }
            $memory.Write($buffer, 0, $count)
        }
        return $memory.ToArray()
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError $FailureCode
    }
    finally {
        if ($null -ne $memory) {
            $memory.Dispose()
        }
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Get-RandomNonce {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function Assert-CanonicalIpv4HostCidr {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][AllowNull()][string] $Value,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    if ($Value -notmatch "^(?<address>(?:[0-9]{1,3}\.){3}[0-9]{1,3})/32$") {
        Throw-SafeError $FailureCode
    }
    $parsedAddress = $null
    if (
        -not [Net.IPAddress]::TryParse($Matches.address, [ref] $parsedAddress) -or
        $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        ("{0}/32" -f $parsedAddress.ToString()) -cne $Value
    ) {
        Throw-SafeError $FailureCode
    }
    return $Value
}

function Assert-FixtureDocumentationCidr {
    param(
        [Parameter(Mandatory = $true)][string] $Value,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    if (
        $Value -notmatch "^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)[0-9]{1,3}/32$"
    ) {
        Throw-SafeError $FailureCode
    }
}

function Assert-NoReparsePath {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $fullPath = [IO.Path]::GetFullPath($Path)
        $root = [IO.Path]::GetPathRoot($fullPath)
        $relativePath = $fullPath.Substring($root.Length)
        $current = $root
        foreach ($component in $relativePath.Split(@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar), [StringSplitOptions]::RemoveEmptyEntries)) {
            $current = Join-Path $current $component
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-SafeError $FailureCode
            }
        }
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError $FailureCode
    }
}

function Get-CanonicalFile {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $fullPath = [IO.Path]::GetFullPath($Path)
        Assert-NoReparsePath -Path $fullPath -FailureCode $FailureCode
        $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    }
    catch {
        Throw-SafeError $FailureCode
    }
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Throw-SafeError $FailureCode
    }
    return $fullPath
}

function Assert-RestrictedAcl {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $allowedSids = @($currentSid, "S-1-5-18", "S-1-5-32-544")
        $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($allowedSids -notcontains $ownerSid) {
            Throw-SafeError $FailureCode
        }
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
                continue
            }
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($allowedSids -notcontains $sid) {
                Throw-SafeError $FailureCode
            }
        }
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError $FailureCode
    }
}

function Open-PinnedTransportLock {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedSha256,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $canonical = Get-CanonicalFile -Path $Path -FailureCode $FailureCode
    Assert-RestrictedAcl -Path $canonical -FailureCode $FailureCode
    $stream = $null
    $algorithm = $null
    try {
        $stream = [IO.FileStream]::new(
            $canonical, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read,
            65536, [IO.FileOptions]::SequentialScan
        )
        if ($stream.Length -le 0 -or $stream.Length -gt 262144) { Throw-SafeError $FailureCode }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        $actualSha256 = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        if ($actualSha256 -cne $ExpectedSha256) { Throw-SafeError $FailureCode }
        $stream.Position = 0
        return [pscustomobject]@{
            Path = $canonical
            Stream = $stream
            Sha256 = $actualSha256
            Length = $stream.Length
        }
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
    finally {
        if ($null -ne $algorithm) { $algorithm.Dispose() }
    }
}

function Assert-PinnedTransportLockUnchanged {
    param(
        [Parameter(Mandatory = $true)] $Lock,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $canonical = Get-CanonicalFile -Path $Lock.Path -FailureCode $FailureCode
        if ($canonical -cne $Lock.Path) { Throw-SafeError $FailureCode }
        Assert-RestrictedAcl -Path $canonical -FailureCode $FailureCode
        if ($Lock.Stream.Length -ne $Lock.Length) { Throw-SafeError $FailureCode }
        $Lock.Stream.Position = 0
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            $actualSha256 = ([BitConverter]::ToString($algorithm.ComputeHash($Lock.Stream))).Replace("-", "").ToLowerInvariant()
        }
        finally { $algorithm.Dispose() }
        if ($actualSha256 -cne $Lock.Sha256) { Throw-SafeError $FailureCode }
        $Lock.Stream.Position = 0
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Open-RestrictedCredentialLock {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $canonical = Assert-RestrictedCredentialFile -Path $Path -FailureCode $FailureCode
    $stream = $null
    try {
        $item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
        $stream = [IO.FileStream]::new(
            $canonical, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read,
            1, [IO.FileOptions]::None
        )
        if ($stream.Length -ne $item.Length -or $stream.Length -le 0 -or $stream.Length -gt 262144) {
            Throw-SafeError $FailureCode
        }
        return [pscustomobject]@{
            Path = $canonical
            Stream = $stream
            Length = $stream.Length
        }
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Assert-RestrictedCredentialLockUnchanged {
    param(
        [Parameter(Mandatory = $true)] $Lock,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $canonical = Assert-RestrictedCredentialFile -Path $Lock.Path -FailureCode $FailureCode
        $item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
        if (
            $canonical -cne $Lock.Path -or
            $item.Length -ne $Lock.Length -or
            $Lock.Stream.Length -ne $Lock.Length
        ) { Throw-SafeError $FailureCode }
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Assert-RestrictedCredentialFile {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $canonical = Get-CanonicalFile -Path $Path -FailureCode $FailureCode
    Assert-RestrictedAcl -Path $canonical -FailureCode $FailureCode
    try {
        $item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
        if ($item.Length -le 0 -or $item.Length -gt 262144) {
            Throw-SafeError $FailureCode
        }
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError $FailureCode
    }
    return $canonical
}

function Assert-SecureDirectory {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $fullPath = [IO.Path]::GetFullPath($Path)
        Assert-NoReparsePath -Path $fullPath -FailureCode $FailureCode
        $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    }
    catch {
        Throw-SafeError $FailureCode
    }
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Throw-SafeError $FailureCode
    }
    Assert-RestrictedAcl -Path $fullPath -FailureCode $FailureCode
    return $fullPath
}

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Value)

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $builder = [Text.StringBuilder]::new()
    [void] $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes += 1
            continue
        }
        if ($character -eq '"') {
            [void] $builder.Append(('\' * (($backslashes * 2) + 1)))
            [void] $builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void] $builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void] $builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void] $builder.Append(('\' * ($backslashes * 2)))
    }
    [void] $builder.Append('"')
    return $builder.ToString()
}

function Stop-BoundedProcess {
    param([Parameter(Mandatory = $true)][Diagnostics.Process] $Process)

    try {
        if (-not $Process.HasExited) {
            $Process.Kill($true)
        }
    }
    catch {
        # The process may have exited between the state check and Kill().
    }
    try {
        [void] $Process.WaitForExit(2000)
    }
    catch {
        # No unbounded cleanup wait is permitted.
    }
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)][string] $Executable,
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedExecutableSha256,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][Collections.IDictionary] $EnvironmentVariables,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $InputBytes,
        [Parameter(Mandatory = $true)][ValidateRange(1, 300)][int] $TimeoutSeconds,
        [Parameter(Mandatory = $true)][ValidateRange(1, 4194304)][int] $MaximumStdoutBytes,
        [Parameter(Mandatory = $true)][ValidateRange(1, 262144)][int] $MaximumStderrBytes
    )

    $executableLock = Open-VerifiedReadLock `
        -Path $Executable `
        -ExpectedSha256 $ExpectedExecutableSha256 `
        -FailureCode "EXECUTABLE_PIN_MISMATCH"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument -Value $_ }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables.Clear()
    foreach ($entry in $EnvironmentVariables.GetEnumerator()) {
        if (
            $entry.Key -isnot [string] -or
            $entry.Value -isnot [string] -or
            $entry.Key -notmatch "^[A-Za-z_][A-Za-z0-9_]{0,63}$" -or
            $entry.Value.Contains([char] 0)
        ) {
            $executableLock.Stream.Dispose()
            Throw-SafeError "PROCESS_ENVIRONMENT_INVALID"
        }
        $startInfo.EnvironmentVariables[$entry.Key] = $entry.Value
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $stdout = [IO.MemoryStream]::new()
    $stderr = [IO.MemoryStream]::new()
    $stdoutBuffer = New-Object byte[] 8192
    $stderrBuffer = New-Object byte[] 4096
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $failureCode = $null
    try {
        if (-not $process.Start()) {
            Throw-SafeError "PROCESS_START_FAILED"
        }
        $executableLock.Stream.Dispose()
        $executableLock = $null

        $stdoutTask = $process.StandardOutput.BaseStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
        $stderrTask = $process.StandardError.BaseStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
        $stdinTask = $process.StandardInput.BaseStream.WriteAsync($InputBytes, 0, $InputBytes.Length)
        $stdinClosed = $false
        $stdoutClosed = $false
        $stderrClosed = $false

        while (-not ($process.HasExited -and $stdoutClosed -and $stderrClosed)) {
            if ($stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                $failureCode = "PROCESS_TIMEOUT"
                Stop-BoundedProcess -Process $process
                break
            }

            if (-not $stdinClosed -and $stdinTask.IsCompleted) {
                if ($stdinTask.IsFaulted) {
                    $failureCode = "PROCESS_STDIN_FAILED"
                    Stop-BoundedProcess -Process $process
                    break
                }
                $process.StandardInput.BaseStream.Flush()
                $process.StandardInput.Close()
                $stdinClosed = $true
            }

            if (-not $stdoutClosed -and $stdoutTask.IsCompleted) {
                if ($stdoutTask.IsFaulted) {
                    $failureCode = "PROCESS_STDOUT_FAILED"
                    Stop-BoundedProcess -Process $process
                    break
                }
                $count = $stdoutTask.Result
                if ($count -eq 0) {
                    $stdoutClosed = $true
                }
                else {
                    if (($stdout.Length + $count) -gt $MaximumStdoutBytes) {
                        $failureCode = "PROCESS_STDOUT_LIMIT"
                        Stop-BoundedProcess -Process $process
                        break
                    }
                    $stdout.Write($stdoutBuffer, 0, $count)
                    $stdoutTask = $process.StandardOutput.BaseStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
                }
            }

            if (-not $stderrClosed -and $stderrTask.IsCompleted) {
                if ($stderrTask.IsFaulted) {
                    $failureCode = "PROCESS_STDERR_FAILED"
                    Stop-BoundedProcess -Process $process
                    break
                }
                $count = $stderrTask.Result
                if ($count -eq 0) {
                    $stderrClosed = $true
                }
                else {
                    if (($stderr.Length + $count) -gt $MaximumStderrBytes) {
                        $failureCode = "PROCESS_STDERR_LIMIT"
                        Stop-BoundedProcess -Process $process
                        break
                    }
                    $stderr.Write($stderrBuffer, 0, $count)
                    $stderrTask = $process.StandardError.BaseStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
                }
            }

            if ($null -eq $failureCode) {
                [Threading.Thread]::Sleep(10)
            }
        }

        if ($null -ne $failureCode) {
            return [pscustomobject]@{
                FailureCode = $failureCode
                ExitCode = -1
                Stdout = [byte[]]@()
                StderrLength = 0
            }
        }
        if (-not $stdinClosed) {
            $process.StandardInput.Close()
        }
        return [pscustomobject]@{
            FailureCode = $null
            ExitCode = $process.ExitCode
            Stdout = $stdout.ToArray()
            StderrLength = [int] $stderr.Length
        }
    }
    catch {
        Stop-BoundedProcess -Process $process
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError "PROCESS_INTERNAL_ERROR"
    }
    finally {
        if ($null -ne $executableLock) {
            $executableLock.Stream.Dispose()
        }
        $stopwatch.Stop()
        $stdout.Dispose()
        $stderr.Dispose()
        $process.Dispose()
    }
}

function Get-StrictUtf8String {
    param(
        [Parameter(Mandatory = $true)][byte[]] $Bytes,
        [Parameter(Mandatory = $true)][string] $FailureCode,
        [Parameter()][switch] $AllowCrLf
    )

    if ($Bytes.Length -eq 0 -or $Bytes -contains 0) {
        Throw-SafeError $FailureCode
    }
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 239 -and $Bytes[1] -eq 187 -and $Bytes[2] -eq 191) {
        Throw-SafeError $FailureCode
    }
    try {
        $encoding = [Text.UTF8Encoding]::new($false, $true)
        $text = $encoding.GetString($Bytes)
        if ($AllowCrLf) {
            if ($text -match "`r(?!`n)") {
                Throw-SafeError $FailureCode
            }
            return $text.Replace("`r`n", "`n")
        }
        if ($text.Contains("`r")) {
            Throw-SafeError $FailureCode
        }
        return $text
    }
    catch {
        Throw-SafeError $FailureCode
    }
}

function ConvertFrom-ExactJson {
    param(
        [Parameter(Mandatory = $true)][byte[]] $Bytes,
        [Parameter(Mandatory = $true)][string] $FailureCode,
        [Parameter()][switch] $AllowCrLf
    )

    $text = Get-StrictUtf8String -Bytes $Bytes -FailureCode $FailureCode -AllowCrLf:$AllowCrLf
    try {
        return $text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Throw-SafeError $FailureCode
    }
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)] $Object,
        [Parameter(Mandatory = $true)][string[]] $Properties,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    if ($null -eq $Object -or $Object -is [Array] -or $Object -isnot [psobject]) {
        Throw-SafeError $FailureCode
    }
    $actual = @($Object.PSObject.Properties.Name | Sort-Object)
    $expected = @($Properties | Sort-Object)
    if (($actual.Count -ne $expected.Count) -or (@(Compare-Object $actual $expected).Count -ne 0)) {
        Throw-SafeError $FailureCode
    }
}

function Invoke-AwsJson {
    param(
        [Parameter(Mandatory = $true)][string] $AwsExecutable,
        [Parameter(Mandatory = $true)][string] $AwsExecutableSha256,
        [Parameter(Mandatory = $true)][Collections.IDictionary] $AwsEnvironment,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][int] $TimeoutSeconds,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $result = Invoke-BoundedProcess `
        -Executable $AwsExecutable `
        -ExpectedExecutableSha256 $AwsExecutableSha256 `
        -Arguments $Arguments `
        -EnvironmentVariables $AwsEnvironment `
        -InputBytes ([byte[]]@()) `
        -TimeoutSeconds $TimeoutSeconds `
        -MaximumStdoutBytes $MaximumAwsOutputBytes `
        -MaximumStderrBytes $MaximumDiagnosticBytes
    if ($null -ne $result.FailureCode -or $result.ExitCode -ne 0 -or $result.StderrLength -ne 0) {
        Throw-SafeError $FailureCode
    }
    return ConvertFrom-ExactJson -Bytes $result.Stdout -FailureCode $FailureCode -AllowCrLf
}

function Get-AwsIdentity {
    param(
        [string] $AwsExecutable,
        [string] $AwsExecutableSha256,
        [Collections.IDictionary] $AwsEnvironment,
        [int] $TimeoutSeconds
    )

    $value = Invoke-AwsJson -AwsExecutable $AwsExecutable -AwsExecutableSha256 $AwsExecutableSha256 -AwsEnvironment $AwsEnvironment -TimeoutSeconds $TimeoutSeconds -FailureCode "AWS_IDENTITY_INVALID" -Arguments @(
        "sts", "get-caller-identity", "--region", $ExpectedAwsRegion,
        "--query", "{account:Account}", "--output", "json", "--no-cli-pager"
    )
    Assert-ExactProperties -Object $value -Properties @("account") -FailureCode "AWS_IDENTITY_INVALID"
    if ($value.account -isnot [string] -or $value.account -cne $ExpectedAwsAccount) {
        Throw-SafeError "AWS_ACCOUNT_MISMATCH"
    }
    return $value
}

function Get-AwsInstance {
    param(
        [string] $AwsExecutable,
        [string] $AwsExecutableSha256,
        [Collections.IDictionary] $AwsEnvironment,
        [int] $TimeoutSeconds
    )

    $value = Invoke-AwsJson -AwsExecutable $AwsExecutable -AwsExecutableSha256 $AwsExecutableSha256 -AwsEnvironment $AwsEnvironment -TimeoutSeconds $TimeoutSeconds -FailureCode "AWS_INSTANCE_INVALID" -Arguments @(
        "lightsail", "get-instance", "--region", $ExpectedAwsRegion, "--instance-name", $ExpectedInstanceName,
        "--query", "{name:instance.name,state:instance.state.name,publicIpAddress:instance.publicIpAddress}",
        "--output", "json", "--no-cli-pager"
    )
    Assert-ExactProperties -Object $value -Properties @("name", "state", "publicIpAddress") -FailureCode "AWS_INSTANCE_INVALID"
    if ($value.name -isnot [string] -or $value.name -cne $ExpectedInstanceName) {
        Throw-SafeError "AWS_INSTANCE_MISMATCH"
    }
    if ($value.state -isnot [string] -or $value.state -cne "running") {
        Throw-SafeError "AWS_INSTANCE_NOT_RUNNING"
    }
    if ($value.publicIpAddress -isnot [string]) {
        Throw-SafeError "AWS_INSTANCE_INVALID"
    }
    $parsedAddress = $null
    if (
        -not [Net.IPAddress]::TryParse($value.publicIpAddress, [ref] $parsedAddress) -or
        $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork
    ) {
        Throw-SafeError "AWS_INSTANCE_INVALID"
    }
    return $value
}

function Assert-StringArray {
    param($Value, [string] $Pattern, [string] $FailureCode)

    if ($null -eq $Value -or $Value -isnot [Array]) {
        Throw-SafeError $FailureCode
    }
    foreach ($entry in $Value) {
        if ($entry -isnot [string] -or $entry -notmatch $Pattern) {
            Throw-SafeError $FailureCode
        }
    }
}

function Assert-ExactFirewallClosed {
    param(
        [Parameter(Mandatory = $true)][Array] $PortStates,
        [Parameter(Mandatory = $true)][string] $ExpectedSshCidr
    )

    $openRules = @($PortStates | Where-Object { $_.state -ceq "open" })
    if ($openRules.Count -ne 1) {
        Throw-SafeError "AWS_FIREWALL_POLICY_INVALID"
    }
    $openRule = $openRules[0]
    if (
        $openRule.protocol -cne "tcp" -or
        $openRule.fromPort -ne 22 -or
        $openRule.toPort -ne 22 -or
        $openRule.cidrs.Count -ne 1 -or
        $openRule.cidrs[0] -cne $ExpectedSshCidr -or
        $openRule.ipv6Cidrs.Count -ne 0 -or
        $openRule.cidrListAliases.Count -ne 0
    ) {
        Throw-SafeError "AWS_FIREWALL_POLICY_INVALID"
    }
}

function Get-AwsFirewall {
    param(
        [string] $AwsExecutable,
        [string] $AwsExecutableSha256,
        [Collections.IDictionary] $AwsEnvironment,
        [string] $ExpectedSshCidr,
        [int] $TimeoutSeconds
    )

    $value = Invoke-AwsJson -AwsExecutable $AwsExecutable -AwsExecutableSha256 $AwsExecutableSha256 -AwsEnvironment $AwsEnvironment -TimeoutSeconds $TimeoutSeconds -FailureCode "AWS_FIREWALL_INVALID" -Arguments @(
        "lightsail", "get-instance-port-states", "--region", $ExpectedAwsRegion, "--instance-name", $ExpectedInstanceName,
        "--query", "{portStates:portStates[].{fromPort:fromPort,toPort:toPort,protocol:protocol,state:state,cidrs:cidrs,ipv6Cidrs:ipv6Cidrs,cidrListAliases:cidrListAliases}}",
        "--output", "json", "--no-cli-pager"
    )
    Assert-ExactProperties -Object $value -Properties @("portStates") -FailureCode "AWS_FIREWALL_INVALID"
    if ($null -eq $value.portStates -or $value.portStates -isnot [Array]) {
        Throw-SafeError "AWS_FIREWALL_INVALID"
    }
    $canonicalRules = @()
    foreach ($rule in $value.portStates) {
        Assert-ExactProperties -Object $rule -Properties @(
            "fromPort", "toPort", "protocol", "state", "cidrs", "ipv6Cidrs", "cidrListAliases"
        ) -FailureCode "AWS_FIREWALL_INVALID"
        if (
            $rule.fromPort -isnot [int] -or $rule.toPort -isnot [int] -or
            $rule.fromPort -lt -1 -or $rule.toPort -gt 65535 -or $rule.fromPort -gt $rule.toPort
        ) {
            Throw-SafeError "AWS_FIREWALL_INVALID"
        }
        if ($rule.protocol -isnot [string] -or @("tcp", "udp", "all", "icmp", "icmpv6") -cnotcontains $rule.protocol) {
            Throw-SafeError "AWS_FIREWALL_INVALID"
        }
        if ($rule.state -isnot [string] -or @("open", "closed") -cnotcontains $rule.state) {
            Throw-SafeError "AWS_FIREWALL_INVALID"
        }
        Assert-StringArray -Value $rule.cidrs -Pattern "^[0-9.]+/[0-9]{1,2}$" -FailureCode "AWS_FIREWALL_INVALID"
        Assert-StringArray -Value $rule.ipv6Cidrs -Pattern "^[0-9A-Fa-f:]+/[0-9]{1,3}$" -FailureCode "AWS_FIREWALL_INVALID"
        Assert-StringArray -Value $rule.cidrListAliases -Pattern "^[a-z0-9-]{1,64}$" -FailureCode "AWS_FIREWALL_INVALID"
        $canonicalRules += [pscustomobject][ordered]@{
            fromPort = $rule.fromPort
            toPort = $rule.toPort
            protocol = $rule.protocol
            state = $rule.state
            cidrs = @($rule.cidrs | Sort-Object)
            ipv6Cidrs = @($rule.ipv6Cidrs | Sort-Object)
            cidrListAliases = @($rule.cidrListAliases | Sort-Object)
        }
    }
    Assert-ExactFirewallClosed -PortStates $value.portStates -ExpectedSshCidr $ExpectedSshCidr
    $serializedRules = @($canonicalRules | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Sort-Object) -join "`n"
    return [pscustomobject]@{
        Digest = Get-Sha256Hex -Bytes ([Text.Encoding]::UTF8.GetBytes($serializedRules))
        Closed = $true
    }
}

function Resolve-PinnedApplication {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedSha256,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $canonical = Get-CanonicalFile -Path $Path -FailureCode $FailureCode
    if ($canonical -cne $Path) {
        Throw-SafeError $FailureCode
    }
    $lock = Open-VerifiedReadLock -Path $canonical -ExpectedSha256 $ExpectedSha256 -FailureCode $FailureCode
    $lock.Stream.Dispose()
    return $canonical
}

function Resolve-FixtureApplication {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $command = Get-Command -Name $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
        return Get-CanonicalFile -Path $command.Source -FailureCode $FailureCode
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError $FailureCode
    }
}

function Set-ExplicitEvidenceAcl {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $security = [Security.AccessControl.FileSecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($currentSid)
        foreach ($sid in @(
            $currentSid,
            [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
            [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
        )) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow
            )
            [void] $security.AddAccessRule($rule)
        }
        [IO.File]::SetAccessControl($Path, $security)
    }
    catch {
        Throw-SafeError $FailureCode
    }
}

function Assert-ExactEvidenceAcl {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $canonical = Get-CanonicalFile -Path $Path -FailureCode $FailureCode
        if ($canonical -cne [IO.Path]::GetFullPath($Path)) {
            Throw-SafeError $FailureCode
        }
        $acl = Get-Acl -LiteralPath $canonical -ErrorAction Stop
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $requiredSids = @($currentSid, "S-1-5-18", "S-1-5-32-544")
        if (-not $acl.AreAccessRulesProtected) {
            Throw-SafeError $FailureCode
        }
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $currentSid) {
            Throw-SafeError $FailureCode
        }
        $rules = @($acl.Access)
        if ($rules.Count -ne 3) {
            Throw-SafeError $FailureCode
        }
        $observedSids = @()
        foreach ($rule in $rules) {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if (
                $rule.IsInherited -or
                $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                $requiredSids -notcontains $sid -or
                $observedSids -contains $sid
            ) {
                Throw-SafeError $FailureCode
            }
            $observedSids += $sid
        }
        foreach ($sid in $requiredSids) {
            if ($observedSids -notcontains $sid) {
                Throw-SafeError $FailureCode
            }
        }
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError $FailureCode
    }
}

function Write-EvidenceCreateNew {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][byte[]] $Bytes)

    $stream = $null
    $created = $false
    try {
        $stream = [IO.FileStream]::new(
            $Path,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        $created = $true
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    catch {
        if ($null -ne $stream) {
            $stream.Dispose()
            $stream = $null
        }
        if ($created) {
            try {
                [IO.File]::Delete($Path)
            }
            catch {
                # A partial file is never reported as evidence.
            }
        }
        Throw-SafeError "EVIDENCE_CREATE_FAILED"
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
    try {
        Set-ExplicitEvidenceAcl -Path $Path -FailureCode "EVIDENCE_ACL_FAILED"
        Assert-ExactEvidenceAcl -Path $Path -FailureCode "EVIDENCE_ACL_FAILED"
    }
    catch {
        $aclFailure = $_
        try {
            [IO.File]::Delete($Path)
        }
        catch {
            # A file with an unverified ACL is never reported as evidence.
        }
        throw $aclFailure
    }
}

function Assert-IsolatedAwsHome {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $canonical = Assert-SecureDirectory -Path $Path -FailureCode $FailureCode
        $directory = [IO.DirectoryInfo]::new($canonical)
        foreach ($entry in $directory.EnumerateFileSystemInfos()) {
            if ([string]::Equals($entry.Name, ".aws", [StringComparison]::OrdinalIgnoreCase)) {
                Throw-SafeError $FailureCode
            }
        }
        return $canonical
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError $FailureCode
    }
}

function Assert-IsolatedSshHome {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    try {
        $canonical = Assert-SecureDirectory -Path $Path -FailureCode $FailureCode
        $directory = [IO.DirectoryInfo]::new($canonical)
        foreach ($entry in $directory.EnumerateFileSystemInfos()) {
            if (
                [string]::Equals($entry.Name, ".ssh", [StringComparison]::OrdinalIgnoreCase) -or
                [string]::Equals($entry.Name, "ssh", [StringComparison]::OrdinalIgnoreCase)
            ) {
                Throw-SafeError $FailureCode
            }
        }
        return $canonical
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") {
            throw
        }
        Throw-SafeError $FailureCode
    }
}

function New-ChildEnvironment {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("AWS", "SSH", "NODE")][string] $Kind,
        [Parameter()][string] $AwsCredentialPath,
        [Parameter()][string] $AwsHomePath,
        [Parameter()][string] $SshHomePath,
        [Parameter()][Collections.IDictionary] $FixtureValues
    )

    $values = [ordered]@{
        SystemRoot = "C:\Windows"
        WINDIR = "C:\Windows"
        PATH = "C:\Windows\System32"
        LC_ALL = "C"
        TZ = "UTC"
    }
    if ($Kind -ceq "AWS") {
        if (
            [string]::IsNullOrWhiteSpace($AwsCredentialPath) -or
            [string]::IsNullOrWhiteSpace($AwsHomePath) -or
            -not [IO.Path]::IsPathRooted($AwsCredentialPath) -or
            -not [IO.Path]::IsPathRooted($AwsHomePath)
        ) {
            Throw-SafeError "AWS_CREDENTIAL_FILE_INVALID"
        }
        $values["HOME"] = $AwsHomePath
        $values["USERPROFILE"] = $AwsHomePath
        $values["AWS_SHARED_CREDENTIALS_FILE"] = $AwsCredentialPath
        $values["AWS_CONFIG_FILE"] = "NUL"
        $values["AWS_DEFAULT_REGION"] = $ExpectedAwsRegion
        $values["AWS_REGION"] = $ExpectedAwsRegion
        $values["AWS_EC2_METADATA_DISABLED"] = "true"
        $values["AWS_CLI_AUTO_PROMPT"] = "off"
        $values["AWS_PAGER"] = ""
    }
    elseif ($Kind -ceq "SSH") {
        if ([string]::IsNullOrWhiteSpace($SshHomePath) -or -not [IO.Path]::IsPathRooted($SshHomePath)) {
            Throw-SafeError "SSH_HOME_NOT_ISOLATED"
        }
        $values["HOME"] = $SshHomePath
        $values["USERPROFILE"] = $SshHomePath
        $values["PROGRAMDATA"] = $SshHomePath
    }
    elseif ($Kind -ceq "NODE") {
        $values["GIT_CONFIG_NOSYSTEM"] = "1"
        $values["GIT_CONFIG_GLOBAL"] = "NUL"
        $values["GIT_NO_REPLACE_OBJECTS"] = "1"
        $values["GIT_TERMINAL_PROMPT"] = "0"
    }
    if ($null -ne $FixtureValues) {
        foreach ($entry in $FixtureValues.GetEnumerator()) {
            $values[$entry.Key] = $entry.Value
        }
    }
    return $values
}



function Open-BoundedEvidenceLock {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][ValidateRange(1, 1048576)][int] $MaximumBytes,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $canonical = Get-CanonicalFile -Path $Path -FailureCode $FailureCode
    Assert-ExactEvidenceAcl -Path $canonical -FailureCode $FailureCode
    $stream = $null
    $memory = $null
    try {
        $stream = [IO.FileStream]::new(
            $canonical, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read,
            65536, [IO.FileOptions]::SequentialScan
        )
        if ($stream.Length -le 0 -or $stream.Length -gt $MaximumBytes) {
            Throw-SafeError $FailureCode
        }
        $memory = [IO.MemoryStream]::new([int] $stream.Length)
        $buffer = New-Object byte[] 65536
        while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if (($memory.Length + $count) -gt $MaximumBytes) {
                Throw-SafeError $FailureCode
            }
            $memory.Write($buffer, 0, $count)
        }
        $bytes = $memory.ToArray()
        return [pscustomobject]@{
            Path = $canonical
            Stream = $stream
            Bytes = $bytes
            Sha256 = Get-Sha256Hex -Bytes $bytes
        }
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
    finally {
        if ($null -ne $memory) { $memory.Dispose() }
    }
}

function Assert-ExactArray {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()] $Actual,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]] $Expected,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $actualValues = @($Actual)
    if ($actualValues.Count -ne $Expected.Count) { Throw-SafeError $FailureCode }
    for ($index = 0; $index -lt $Expected.Count; $index += 1) {
        if ($actualValues[$index] -isnot [string] -or $actualValues[$index] -cne $Expected[$index]) {
            Throw-SafeError $FailureCode
        }
    }
}

function ConvertFrom-UtcTimestamp {
    param([Parameter(Mandatory = $true)] $Value, [Parameter(Mandatory = $true)][string] $FailureCode)

    if ($Value -isnot [string]) { Throw-SafeError $FailureCode }
    try {
        return [DateTime]::ParseExact(
            $Value, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        )
    }
    catch { Throw-SafeError $FailureCode }
}

function Assert-AllFalse {
    param(
        [Parameter(Mandatory = $true)] $Value,
        [Parameter(Mandatory = $true)][string[]] $Properties,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    Assert-ExactProperties -Object $Value -Properties $Properties -FailureCode $FailureCode
    foreach ($property in $Properties) {
        if ($Value.$property -isnot [bool] -or $Value.$property -ne $false) {
            Throw-SafeError $FailureCode
        }
    }
}

function Assert-PostflightCapture {
    param(
        [Parameter(Mandatory = $true)] $Capture,
        [Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][string] $ExpectedRepositoryHead,
        [Parameter(Mandatory = $true)][AllowNull()] $ExpectedPostflightSources,
        [Parameter(Mandatory = $true)][bool] $FixtureOnly
    )

    $failureCode = "PREFLIGHT_EVIDENCE_INVALID"
    Assert-ExactProperties -Object $Capture -Properties @(
        "schemaVersion", "kind", "result", "admission", "posture", "capturedAt", "validUntil",
        "remote", "awsControlPlane", "provenance", "redaction"
    ) -FailureCode $failureCode
    if (
        $Capture.schemaVersion -ne 1 -or
        $Capture.kind -cne "refunddesk.lightsail.host-postflight.capture" -or
        ($FixtureOnly -and $Capture.admission -cne "FIXTURE_ONLY") -or
        (-not $FixtureOnly -and $Capture.admission -cne "ADMISSIBLE_READ_ONLY")
    ) { Throw-SafeError $failureCode }

    $capturedAt = ConvertFrom-UtcTimestamp -Value $Capture.capturedAt -FailureCode $failureCode
    $validUntil = ConvertFrom-UtcTimestamp -Value $Capture.validUntil -FailureCode $failureCode
    $now = [DateTime]::UtcNow
    if (
        $capturedAt -gt $now.AddMinutes(2) -or
        ($validUntil - $capturedAt).TotalSeconds -ne 900 -or
        ($validUntil - $now).TotalSeconds -lt 720
    ) { Throw-SafeError "PREFLIGHT_VALIDITY_INSUFFICIENT" }

    Assert-ExactProperties -Object $Capture.awsControlPlane -Properties @(
        "targetId", "accountMatches", "regionMatches", "instanceMatches", "instanceRunning",
        "firewallClosedBefore", "firewallClosedAfter", "firewallUnchanged"
    ) -FailureCode $failureCode
    if (
        $Capture.awsControlPlane.targetId -cne "$ExpectedInstanceName@$ExpectedAwsRegion" -or
        $Capture.awsControlPlane.accountMatches -ne $true -or
        $Capture.awsControlPlane.regionMatches -ne $true -or
        $Capture.awsControlPlane.instanceMatches -ne $true -or
        $Capture.awsControlPlane.instanceRunning -ne $true -or
        $Capture.awsControlPlane.firewallClosedBefore -ne $true -or
        $Capture.awsControlPlane.firewallClosedAfter -ne $true -or
        $Capture.awsControlPlane.firewallUnchanged -ne $true
    ) { Throw-SafeError $failureCode }

    Assert-ExactProperties -Object $Capture.provenance -Properties @(
        "remoteDocumentSha256", "observer", "validator", "wrapper", "schema", "repositoryHead",
        "revisionComposeVerified", "transportInputsPinned", "fixtureOnly"
    ) -FailureCode $failureCode
    if (
        $Capture.provenance.remoteDocumentSha256 -isnot [string] -or
        $Capture.provenance.remoteDocumentSha256 -notmatch "^[0-9a-f]{64}$" -or
        $Capture.provenance.revisionComposeVerified -ne $true -or
        $Capture.provenance.transportInputsPinned -ne $true -or
        $Capture.provenance.fixtureOnly -ne $FixtureOnly
    ) { Throw-SafeError $failureCode }
    $remoteCanonicalBytes = [Text.UTF8Encoding]::new($false).GetBytes(
        (($Capture.remote | ConvertTo-Json -Compress -Depth 100) + [char] 10)
    )
    if ((Get-Sha256Hex -Bytes $remoteCanonicalBytes) -cne $Capture.provenance.remoteDocumentSha256) {
        Throw-SafeError "PREFLIGHT_REMOTE_HASH_MISMATCH"
    }
    foreach ($sourceName in @("observer", "validator", "wrapper", "schema")) {
        $source = $Capture.provenance.$sourceName
        Assert-ExactProperties -Object $source -Properties @("gitObject", "sha256") -FailureCode $failureCode
        if ($source.sha256 -isnot [string] -or $source.sha256 -notmatch "^[0-9a-f]{64}$") {
            Throw-SafeError $failureCode
        }
        if ($FixtureOnly) {
            if ($null -ne $source.gitObject) { Throw-SafeError $failureCode }
        }
        elseif (
            $source.gitObject -isnot [string] -or
            $source.gitObject -cne $ExpectedPostflightSources[$sourceName].GitObject -or
            $source.sha256 -cne $ExpectedPostflightSources[$sourceName].Sha256
        ) {
            Throw-SafeError "PREFLIGHT_SOURCE_MISMATCH"
        }
    }
    if ($FixtureOnly) {
        if ($null -ne $Capture.provenance.repositoryHead) { Throw-SafeError $failureCode }
    }
    elseif (
        $Capture.provenance.repositoryHead -isnot [string] -or
        $Capture.provenance.repositoryHead -cne $ExpectedRepositoryHead
    ) { Throw-SafeError "PREFLIGHT_HEAD_MISMATCH" }

    Assert-AllFalse -Value $Capture.redaction -Properties @(
        "rawSecretPresent", "rawApiKeyPresent", "rawSignaturePresent", "rawPayloadPresent",
        "customerDataPresent", "arbitraryPathPresent", "ipAddressPresent", "stderrPresent",
        "keyDigestPresent"
    ) -FailureCode $failureCode

    $remote = $Capture.remote
    Assert-ExactProperties -Object $remote -Properties @(
        "schemaVersion", "kind", "nonce", "startedAt", "completedAt", "exitCode", "result", "code",
        "posture", "diagnostics", "captures", "containment", "availability", "financial", "redaction"
    ) -FailureCode $failureCode
    if (
        $remote.schemaVersion -ne 1 -or $remote.kind -cne "refunddesk.lightsail.host-postflight" -or
        $remote.nonce -isnot [string] -or $remote.nonce -notmatch "^[0-9a-f]{64}$" -or
        $Capture.result -cne $remote.result -or $Capture.posture -cne $remote.posture
    ) { Throw-SafeError $failureCode }
    [void] (ConvertFrom-UtcTimestamp -Value $remote.startedAt -FailureCode $failureCode)
    [void] (ConvertFrom-UtcTimestamp -Value $remote.completedAt -FailureCode $failureCode)

    $profile = $null

    Assert-ExactProperties -Object $remote.captures -Properties @("a", "b") -FailureCode $failureCode
    foreach ($captureName in @("a", "b")) {
        $snapshot = $remote.captures.$captureName
        Assert-ExactProperties -Object $snapshot -Properties @(
            "capturedAt", "identity", "containers", "control", "surface", "database"
        ) -FailureCode $failureCode
        Assert-ExactProperties -Object $snapshot.identity -Properties @(
            "activeRevision", "currentRevision", "sourceRevision", "releaseEnvironmentRevision",
            "manifestRevision", "composeSha256", "installedManifestSha256", "manifestSchemaValid"
        ) -FailureCode $failureCode
        foreach ($property in @(
            "activeRevision", "currentRevision", "sourceRevision", "releaseEnvironmentRevision", "manifestRevision"
        )) {
            if ($snapshot.identity.$property -cne $ExpectedRevision) { Throw-SafeError $failureCode }
        }
        if (
            $snapshot.identity.composeSha256 -cne $ExpectedComposeSha256 -or
            $snapshot.identity.installedManifestSha256 -cne $ExpectedManifestSha256 -or
            $snapshot.identity.manifestSchemaValid -ne $true
        ) { Throw-SafeError $failureCode }
        $containers = @($snapshot.containers)
        Assert-ExactArray -Actual @($containers | ForEach-Object { $_.service }) `
            -Expected @("postgres", "verifier", "worker", "web", "caddy") -FailureCode $failureCode
        foreach ($container in $containers) {
            Assert-ExactProperties -Object $container -Properties @(
                "service", "presentCount", "containerId", "imageId", "expectedImageId",
                "imageReferenceMatches", "noPublishedPorts", "effectiveGlobalLiveDisabled",
                "effectiveLiveWebhookDisabled", "status", "health", "projectLabelMatches",
                "serviceLabelMatches", "revisionLabel"
            ) -FailureCode $failureCode
            if (
                $container.presentCount -ne 1 -or
                $container.containerId -isnot [string] -or
                $container.containerId -notmatch "^[0-9a-f]{64}$" -or
                $container.imageId -cne $ExpectedImageIds[$container.service] -or
                $container.expectedImageId -cne $ExpectedImageIds[$container.service] -or
                $container.imageReferenceMatches -ne $true -or
                $container.projectLabelMatches -ne $true -or
                $container.serviceLabelMatches -ne $true -or
                ($container.service -ne "postgres" -and $container.revisionLabel -cne $ExpectedRevision) -or
                ($container.service -eq "postgres" -and $null -ne $container.revisionLabel)
            ) { Throw-SafeError $failureCode }
        }
        if (
            $snapshot.control.operatorLockShared -ne $true -or
            $snapshot.control.transitionJournalPresent -ne $false -or
            $snapshot.control.transitionCommitMarkerValid -ne $true -or
            $snapshot.control.backupJournalPresent -ne $false -or
            $snapshot.control.legacyAppIdJournalPresent -ne $false -or
            $snapshot.control.managedTransitionInFlightPresent -ne $false -or
            $snapshot.control.managedTransitionCompletion -cne "VALID_PASS_CONTAINED" -or
            $snapshot.control.activeReleaseUnitCount -ne 0 -or
            $snapshot.control.activeFenceUnitCount -ne 0 -or
            $snapshot.control.releaseRuntimeMarkerCount -ne 0 -or
            $snapshot.control.dockerInventoryAvailable -ne $true -or
            $snapshot.control.expectedImagesAvailable -ne $true -or
            $snapshot.control.sensitiveModesSafe -ne $true
        ) { Throw-SafeError $failureCode }
        if (
            $snapshot.surface.platformLiveDisabled -ne $true -or
            $snapshot.surface.workerLiveDisabled -ne $true -or
            $snapshot.surface.liveWebhookDisabled -ne $true -or
            $snapshot.surface.backupServiceActive -ne $false -or
            $snapshot.surface.retentionServiceActive -ne $false -or
            $snapshot.surface.quiesceRecoveryActive -ne $false -or
            $snapshot.surface.systemdInventoryAvailable -ne $true -or
            $snapshot.surface.listenerInventoryAvailable -ne $true -or
            $snapshot.surface.liveInterlocksAvailable -ne $true -or
            $snapshot.surface.runtimeLiveInterlocksAvailable -ne $true
        ) { Throw-SafeError $failureCode }
        if (
            $snapshot.database.snapshotAvailable -ne $true -or
            $snapshot.database.systemIdentifier -isnot [string] -or
            $snapshot.database.systemIdentifier -notmatch "^[1-9][0-9]{0,30}$" -or
            $snapshot.database.activeWorkflows -ne 0 -or
            $snapshot.database.unreleasedPaymentGuards -ne 0 -or
            $snapshot.database.activeFinancialJobs -ne 0 -or
            $snapshot.database.liveTenants -ne 0 -or
            $snapshot.database.liveInstallations -ne 0 -or
            $snapshot.database.preparedTransactions -ne 0
        ) { Throw-SafeError $failureCode }
    }

    foreach ($field in @(
        "systemIdentifier", "activeWorkflows", "unreleasedPaymentGuards", "activeFinancialJobs",
        "liveTenants", "liveInstallations", "preparedTransactions", "refundRequests", "auditEvents"
    )) {
        if ($remote.captures.a.database.$field -cne $remote.captures.b.database.$field) {
            Throw-SafeError $failureCode
        }
    }
    for ($containerIndex = 0; $containerIndex -lt 5; $containerIndex += 1) {
        if (
            $remote.captures.a.containers[$containerIndex].containerId -cne $remote.captures.b.containers[$containerIndex].containerId -or
            $remote.captures.a.containers[$containerIndex].imageId -cne $remote.captures.b.containers[$containerIndex].imageId
        ) { Throw-SafeError $failureCode }
    }
    if (
        $remote.financial.snapshotAvailable -ne $true -or $remote.financial.stable -ne $true -or
        $remote.financial.quiescent -ne $true -or $remote.availability.capturesStable -ne $true -or
        $remote.availability.metadataCoherent -ne $true -or $remote.availability.containersCoherent -ne $true -or
        $remote.availability.coreHealthy -ne $true -or $remote.containment.liveDisabled -ne $true -or
        $remote.containment.fenceClosed -ne $true -or $remote.containment.sensitiveModesSafe -ne $true
    ) { Throw-SafeError $failureCode }

    foreach ($stableProperty in @("identity", "containers", "control", "surface", "database")) {
        $captureAValue = $remote.captures.a.$stableProperty | ConvertTo-Json -Compress -Depth 100
        $captureBValue = $remote.captures.b.$stableProperty | ConvertTo-Json -Compress -Depth 100
        if ($captureAValue -cne $captureBValue) { Throw-SafeError $failureCode }
    }

    $snapshot = $remote.captures.b
    $postgres = @($snapshot.containers | Where-Object { $_.service -ceq "postgres" })[0]
    $verifier = @($snapshot.containers | Where-Object { $_.service -ceq "verifier" })[0]
    $worker = @($snapshot.containers | Where-Object { $_.service -ceq "worker" })[0]
    $web = @($snapshot.containers | Where-Object { $_.service -ceq "web" })[0]
    $caddy = @($snapshot.containers | Where-Object { $_.service -ceq "caddy" })[0]
    foreach ($core in @($postgres, $verifier, $web)) {
        if ($core.status -cne "RUNNING" -or $core.health -cne "HEALTHY") { Throw-SafeError $failureCode }
    }
    if (
        $worker.effectiveGlobalLiveDisabled -ne $true -or
        $web.effectiveGlobalLiveDisabled -ne $true -or
        $web.effectiveLiveWebhookDisabled -ne $true
    ) { Throw-SafeError $failureCode }
    foreach ($container in @($postgres, $verifier, $worker, $web)) {
        if ($container.noPublishedPorts -ne $true) { Throw-SafeError $failureCode }
    }
    if ($caddy.noPublishedPorts -ne $false) { Throw-SafeError $failureCode }

    $workerRunning = $worker.status -ceq "RUNNING" -and $worker.health -ceq "HEALTHY"
    $caddyRunning = $caddy.status -ceq "RUNNING" -and $caddy.health -ceq "HEALTHY"
    $workerStopped = $worker.status -in @("CREATED", "EXITED")
    $caddyStopped = $caddy.status -in @("CREATED", "EXITED")
    if ((-not $workerRunning -and -not $workerStopped) -or (-not $caddyRunning -and -not $caddyStopped)) {
        Throw-SafeError $failureCode
    }

    foreach ($booleanProperty in @(
        "backupTimerActive", "retentionTimerActive", "tcp80Listening", "tcp443Listening",
        "udp80Listening", "udp443Listening"
    )) {
        if ($snapshot.surface.$booleanProperty -isnot [bool]) { Throw-SafeError $failureCode }
    }
    $backupTimerActive = $snapshot.surface.backupTimerActive
    $retentionTimerActive = $snapshot.surface.retentionTimerActive
    $tcp80Listening = $snapshot.surface.tcp80Listening
    $tcp443Listening = $snapshot.surface.tcp443Listening
    $maintenanceActive = $backupTimerActive -or $retentionTimerActive
    $publicListenerActive = $tcp80Listening -or $tcp443Listening
    if ($snapshot.surface.udp80Listening -ne $false -or $snapshot.surface.udp443Listening -ne $false) {
        Throw-SafeError $failureCode
    }
    if (
        ($maintenanceActive -and (-not $workerRunning -or -not $caddyRunning -or -not $tcp80Listening -or -not $tcp443Listening)) -or
        ($caddyRunning -and (-not $workerRunning -or -not $tcp80Listening -or -not $tcp443Listening)) -or
        ($caddyStopped -and ($maintenanceActive -or $publicListenerActive)) -or
        ($workerStopped -and -not $caddyStopped)
    ) { Throw-SafeError $failureCode }
    $unexpectedRunningCount = [int] $workerRunning + [int] $caddyRunning
    if ($snapshot.surface.unexpectedRunningContainerCount -ne $unexpectedRunningCount) {
        Throw-SafeError $failureCode
    }
    $journalPresent = $snapshot.control.runtimeQuiesceJournalPresent -eq $true

    if ($journalPresent) {
        $derivedDiagnostics = @()
        if ($caddyRunning) { $derivedDiagnostics += "CADDY_RUNNING" }
        if ($maintenanceActive) { $derivedDiagnostics += "MAINTENANCE_ACTIVE" }
        if ($publicListenerActive) { $derivedDiagnostics += "PUBLIC_LISTENER_ACTIVE" }
        if ($unexpectedRunningCount -gt 0) { $derivedDiagnostics += "UNEXPECTED_RUNNING_CONTAINER" }
        $derivedDiagnostics += "UNRESOLVED_JOURNAL"
        if ($workerRunning) { $derivedDiagnostics += "WORKER_RUNNING" }
        $initial = (
            $workerRunning -and $caddyRunning -and
            $backupTimerActive -and $retentionTimerActive -and
            $tcp80Listening -and $tcp443Listening
        )
        $expectedPosture = if ($initial) { "COHERENT_RUNNING" } else { "DIVERGENT" }
        if (
            $remote.result -cne "FAIL" -or $remote.exitCode -ne 20 -or
            $remote.code -cne $derivedDiagnostics[0] -or
            $remote.posture -cne $expectedPosture -or
            $remote.containment.workerStopped -ne (-not $workerRunning) -or
            $remote.containment.caddyStopped -ne (-not $caddyRunning) -or
            $remote.containment.maintenanceStopped -ne (-not $maintenanceActive) -or
            $remote.containment.publicListenersClosed -ne (-not $publicListenerActive) -or
            $remote.containment.journalsClosed -ne $false
        ) { Throw-SafeError $failureCode }
        Assert-ExactArray -Actual $remote.diagnostics -Expected $derivedDiagnostics -FailureCode $failureCode
        $profile = if ($initial) { "INITIAL_COHERENT_RUNNING" } else { "RESUME_JOURNAL_PARTIAL" }
    }
    else {
        if (
            $remote.result -cne "PASS" -or $remote.exitCode -ne 0 -or
            $remote.code -cne "PASS_CONTAINED" -or $remote.posture -cne "COHERENT_CONTAINED" -or
            -not $workerStopped -or -not $caddyStopped -or $maintenanceActive -or $publicListenerActive -or
            $unexpectedRunningCount -ne 0 -or
            $remote.containment.workerStopped -ne $true -or $remote.containment.caddyStopped -ne $true -or
            $remote.containment.maintenanceStopped -ne $true -or $remote.containment.publicListenersClosed -ne $true -or
            $remote.containment.journalsClosed -ne $true
        ) { Throw-SafeError $failureCode }
        Assert-ExactArray -Actual $remote.diagnostics -Expected @() -FailureCode $failureCode
        $profile = "RESUME_JOURNAL_CLEARED"
    }
    if ($remote.availability.recoverableRuntimeStopped -ne $false) { Throw-SafeError $failureCode }

    Assert-AllFalse -Value $remote.redaction -Properties @(
        "rawSecretPresent", "rawApiKeyPresent", "rawSignaturePresent", "rawPayloadPresent",
        "customerDataPresent", "arbitraryPathPresent", "stderrPresent"
    ) -FailureCode $failureCode
    return [pscustomobject]@{ Profile = $profile; CapturedAt = $capturedAt; ValidUntil = $validUntil }
}

function Invoke-GitBytes {
    param(
        [string] $GitExecutable, [string] $GitExecutableSha256,
        [Collections.IDictionary] $Environment, [string[]] $Arguments,
        [int] $MaximumBytes, [string] $FailureCode
    )

    $result = Invoke-BoundedProcess -Executable $GitExecutable -ExpectedExecutableSha256 $GitExecutableSha256 `
        -Arguments $Arguments -EnvironmentVariables $Environment -InputBytes ([byte[]]@()) `
        -TimeoutSeconds 30 -MaximumStdoutBytes $MaximumBytes -MaximumStderrBytes $MaximumDiagnosticBytes
    if ($null -ne $result.FailureCode) { Throw-SafeError ("{0}_PROCESS" -f $FailureCode) }
    if ($result.ExitCode -ne 0) { Throw-SafeError ("{0}_EXIT" -f $FailureCode) }
    if ($result.StderrLength -ne 0) { Throw-SafeError ("{0}_STDERR" -f $FailureCode) }
    return [byte[]] $result.Stdout
}

function Get-SingleLine {
    param([byte[]] $Bytes, [string] $FailureCode)

    $text = Get-StrictUtf8String -Bytes $Bytes -FailureCode $FailureCode -AllowCrLf
    $lines = @($text.TrimEnd("`n").Split("`n"))
    if ($lines.Count -ne 1 -or [string]::IsNullOrWhiteSpace($lines[0])) { Throw-SafeError $FailureCode }
    return $lines[0]
}

function Get-SourceRecord {
    param(
        [string] $Repository, [string] $RelativePath, [string] $WorktreePath,
        [string] $GitExecutable, [string] $GitExecutableSha256,
        [Collections.IDictionary] $GitEnvironment, [bool] $FixtureOnly, [int] $MaximumBytes,
        [AllowNull()][string] $CommitOid
    )

    $canonicalWorktreePath = Get-CanonicalFile -Path $WorktreePath -FailureCode "SOURCE_INVALID"
    [byte[]] $worktreeBytes = Read-LockedFileBytes -Path $canonicalWorktreePath -MaximumBytes $MaximumBytes -FailureCode "SOURCE_INVALID"
    $worktreeSha256 = Get-Sha256Hex -Bytes $worktreeBytes
    if ($FixtureOnly) {
        return [pscustomobject]@{
            Bytes = $worktreeBytes; GitObject = $null; Sha256 = $worktreeSha256
            WorktreeSha256 = $worktreeSha256; IndexSha256 = $null; CommitSha256 = $null
        }
    }
    if ($CommitOid -isnot [string] -or $CommitOid -notmatch "^(?:[0-9a-f]{40}|[0-9a-f]{64})$") {
        Throw-SafeError "SOURCE_COMMIT_INVALID"
    }
    $commitPath = "{0}:{1}" -f $CommitOid, $RelativePath
    $indexPath = ":{0}" -f $RelativePath
    $commitObjectBytes = Invoke-GitBytes -GitExecutable $GitExecutable -GitExecutableSha256 $GitExecutableSha256 `
        -Environment $GitEnvironment -Arguments @("-C", $Repository, "rev-parse", $commitPath) `
        -MaximumBytes 256 -FailureCode "SOURCE_COMMIT_OBJECT_INVALID"
    $indexObjectBytes = Invoke-GitBytes -GitExecutable $GitExecutable -GitExecutableSha256 $GitExecutableSha256 `
        -Environment $GitEnvironment -Arguments @("-C", $Repository, "rev-parse", $indexPath) `
        -MaximumBytes 256 -FailureCode "SOURCE_INDEX_OBJECT_INVALID"
    $gitObject = Get-SingleLine -Bytes $commitObjectBytes -FailureCode "SOURCE_COMMIT_OBJECT_INVALID"
    $indexObject = Get-SingleLine -Bytes $indexObjectBytes -FailureCode "SOURCE_INDEX_OBJECT_INVALID"
    if ($gitObject -notmatch "^(?:[0-9a-f]{40}|[0-9a-f]{64})$") { Throw-SafeError "SOURCE_NOT_AT_HEAD" }
    if ($indexObject -cne $gitObject) { Throw-SafeError "SOURCE_NOT_AT_HEAD" }
    [byte[]] $commitBytes = Invoke-GitBytes -GitExecutable $GitExecutable -GitExecutableSha256 $GitExecutableSha256 `
        -Environment $GitEnvironment -Arguments @("-C", $Repository, "cat-file", "blob", $gitObject) `
        -MaximumBytes $MaximumBytes -FailureCode "SOURCE_COMMIT_READ_INVALID"
    [byte[]] $indexBytes = Invoke-GitBytes -GitExecutable $GitExecutable -GitExecutableSha256 $GitExecutableSha256 `
        -Environment $GitEnvironment -Arguments @("-C", $Repository, "cat-file", "blob", $indexObject) `
        -MaximumBytes $MaximumBytes -FailureCode "SOURCE_INDEX_READ_INVALID"
    $commitSha256 = Get-Sha256Hex -Bytes $commitBytes
    $indexSha256 = Get-Sha256Hex -Bytes $indexBytes
    if (
        $commitBytes.Length -ne $indexBytes.Length -or $commitSha256 -cne $indexSha256 -or
        $commitBytes.Length -ne $worktreeBytes.Length -or $commitSha256 -cne $worktreeSha256
    ) {
        Throw-SafeError "SOURCE_NOT_AT_HEAD"
    }
    return [pscustomobject]@{
        Bytes = $commitBytes; GitObject = $gitObject; Sha256 = $commitSha256
        WorktreeSha256 = $worktreeSha256; IndexSha256 = $indexSha256; CommitSha256 = $commitSha256
    }
}

function Get-RepositoryHead {
    param(
        [string] $Repository, [string] $GitExecutable, [string] $GitExecutableSha256,
        [Collections.IDictionary] $GitEnvironment
    )

    $headBytes = Invoke-GitBytes -GitExecutable $GitExecutable -GitExecutableSha256 $GitExecutableSha256 `
        -Environment $GitEnvironment -Arguments @("-C", $Repository, "rev-parse", "--verify", "HEAD") `
        -MaximumBytes 256 -FailureCode "REPOSITORY_HEAD_INVALID"
    $head = Get-SingleLine -Bytes $headBytes -FailureCode "REPOSITORY_HEAD_INVALID"
    if ($head -notmatch "^(?:[0-9a-f]{40}|[0-9a-f]{64})$") { Throw-SafeError "REPOSITORY_HEAD_INVALID" }
    return $head
}

function Assert-RepositorySourcesAtCommit {
    param(
        [string] $Repository,
        [ValidatePattern("^(?:[0-9a-f]{40}|[0-9a-f]{64})$")][string] $CommitOid,
        [object[]] $Bindings,
        [string] $GitExecutable,
        [string] $GitExecutableSha256,
        [Collections.IDictionary] $GitEnvironment
    )

    $headBefore = Get-RepositoryHead -Repository $Repository -GitExecutable $GitExecutable `
        -GitExecutableSha256 $GitExecutableSha256 -GitEnvironment $GitEnvironment
    if ($headBefore -cne $CommitOid) { Throw-SafeError "REPOSITORY_HEAD_CHANGED" }
    foreach ($binding in @($Bindings)) {
        try {
            $current = Get-SourceRecord -Repository $Repository -RelativePath $binding.RelativePath `
                -WorktreePath $binding.WorktreePath -GitExecutable $GitExecutable `
                -GitExecutableSha256 $GitExecutableSha256 -GitEnvironment $GitEnvironment `
                -FixtureOnly $false -MaximumBytes $binding.MaximumBytes -CommitOid $CommitOid
        }
        catch {
            if ($_.Exception.Message -match "^REFUNDDESK_SOURCE_") { throw }
            Throw-SafeError ("SOURCE_{0}_CHANGED" -f $binding.Name.ToUpperInvariant())
        }
        if (
            $current.GitObject -cne $binding.Record.GitObject -or
            $current.Sha256 -cne $binding.Record.Sha256 -or
            $current.WorktreeSha256 -cne $binding.Record.WorktreeSha256 -or
            $current.IndexSha256 -cne $binding.Record.IndexSha256 -or
            $current.CommitSha256 -cne $binding.Record.CommitSha256 -or
            $current.Bytes.Length -ne $binding.Record.Bytes.Length
        ) { Throw-SafeError "SOURCE_PROVENANCE_CHANGED" }
    }
    $headAfter = Get-RepositoryHead -Repository $Repository -GitExecutable $GitExecutable `
        -GitExecutableSha256 $GitExecutableSha256 -GitEnvironment $GitEnvironment
    if ($headAfter -cne $CommitOid) { Throw-SafeError "REPOSITORY_HEAD_CHANGED" }
}

function Invoke-ContractHeadRace {
    param(
        [string] $Repository,
        [string] $Mode,
        [AllowNull()][string] $AlternateCommitOid
    )

    if ($Mode -cne "git-race-source-head") { return }
    if ($AlternateCommitOid -isnot [string] -or $AlternateCommitOid -notmatch "^(?:[0-9a-f]{40}|[0-9a-f]{64})$") {
        Throw-SafeError "FIXTURE_GIT_ALTERNATE_HEAD_INVALID"
    }
    $gitDirectory = [IO.Path]::GetFullPath((Join-Path $Repository ".git"))
    if (-not [IO.Directory]::Exists($gitDirectory)) { Throw-SafeError "FIXTURE_GIT_REPOSITORY_INVALID" }
    $headPath = Get-CanonicalFile -Path (Join-Path $gitDirectory "HEAD") -FailureCode "FIXTURE_GIT_REPOSITORY_INVALID"
    try {
        [IO.File]::WriteAllText($headPath, $AlternateCommitOid + [char] 10, [Text.UTF8Encoding]::new($false))
    }
    catch {
        Throw-SafeError "FIXTURE_GIT_HEAD_RACE_FAILED"
    }
}


$preflightLock = $null
$identityLock = $null
$knownHostsLock = $null
$awsCredentialLock = $null
try {
    $expectedSshCidrValue = Assert-CanonicalIpv4HostCidr -Value $ExpectedSshCidr -FailureCode "EXPECTED_SSH_CIDR_INVALID"
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    $runnerPath = Get-CanonicalFile -Path (Join-Path $repository "deploy/lightsail/scripts/reconcile-host-containment.sh") -FailureCode "RUNNER_INVALID"
    $validatorPath = Get-CanonicalFile -Path (Join-Path $repository "scripts/validate-lightsail-containment-reconciliation.mjs") -FailureCode "VALIDATOR_INVALID"
    $wrapperPath = Get-CanonicalFile -Path $PSCommandPath -FailureCode "WRAPPER_INVALID"
    $schemaPath = Get-CanonicalFile -Path (Join-Path $repository "docs/schemas/refunddesk-lightsail-containment-reconciliation-v1.schema.json") -FailureCode "SCHEMA_INVALID"

    $contractMode = $ContractFixture.IsPresent
    $sourceProvenanceFixture = $false
    $fixtureGitAlternateHead = $null
    if ($contractMode) {
        if ($env:REFUNDDESK_CONTAINMENT_RECONCILIATION_CONTRACT_MODE -cne "1") {
            Throw-SafeError "FIXTURE_MODE_NOT_ADMITTED"
        }
        Assert-FixtureDocumentationCidr -Value $expectedSshCidrValue -FailureCode "FIXTURE_SSH_CIDR_INVALID"
        if ([string]::IsNullOrWhiteSpace($FixtureToolDirectory) -or [string]::IsNullOrWhiteSpace($FixtureEvidencePath)) {
            Throw-SafeError "FIXTURE_ARGUMENT_INVALID"
        }
        $toolDirectory = Assert-SecureDirectory -Path $FixtureToolDirectory -FailureCode "FIXTURE_TOOL_DIRECTORY_INVALID"
        $awsExecutable = Get-CanonicalFile -Path (Join-Path $toolDirectory "aws.exe") -FailureCode "FIXTURE_AWS_INVALID"
        $sshExecutable = Get-CanonicalFile -Path (Join-Path $toolDirectory "ssh.exe") -FailureCode "FIXTURE_SSH_INVALID"
        $awsExecutableSha256 = Get-LockedFileSha256 -Path $awsExecutable -FailureCode "FIXTURE_AWS_INVALID"
        $sshExecutableSha256 = Get-LockedFileSha256 -Path $sshExecutable -FailureCode "FIXTURE_SSH_INVALID"
        $identityCandidate = Get-CanonicalFile -Path (Join-Path $toolDirectory "identity.fixture") -FailureCode "FIXTURE_IDENTITY_INVALID"
        $knownHostsCandidate = Get-CanonicalFile -Path (Join-Path $toolDirectory "known_hosts.fixture") -FailureCode "FIXTURE_KNOWN_HOSTS_INVALID"
        $identityExpected = Get-Sha256Hex -Bytes ([IO.File]::ReadAllBytes($identityCandidate))
        $knownHostsExpected = Get-Sha256Hex -Bytes ([IO.File]::ReadAllBytes($knownHostsCandidate))
        $awsCredentialCandidate = Join-Path $toolDirectory "aws-credentials.fixture"
        $identityFailureCode = "FIXTURE_IDENTITY_INVALID"
        $knownHostsFailureCode = "FIXTURE_KNOWN_HOSTS_INVALID"
        $credentialFailureCode = "FIXTURE_AWS_CREDENTIAL_FILE_INVALID"
        $evidenceParent = Assert-SecureDirectory -Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($FixtureEvidencePath))) -FailureCode "FIXTURE_EVIDENCE_DIRECTORY_INVALID"
        $evidencePath = [IO.Path]::GetFullPath($FixtureEvidencePath)
        $repositoryPrefix = $repository.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (
            [IO.Path]::GetDirectoryName($evidencePath) -cne $evidenceParent -or
            $evidencePath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)
        ) { Throw-SafeError "FIXTURE_EVIDENCE_PATH_INVALID" }
        $fixtureEnvironmentValues = [ordered]@{
            REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_MODE = $env:REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_MODE
            REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_REMOTE_TEMPLATE = $env:REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_REMOTE_TEMPLATE
            REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_STATE = $env:REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_STATE
        }
        foreach ($fixtureValue in $fixtureEnvironmentValues.Values) {
            if ([string]::IsNullOrWhiteSpace($fixtureValue)) { Throw-SafeError "FIXTURE_ENVIRONMENT_INVALID" }
        }
        if (-not [string]::IsNullOrEmpty($env:REFUNDDESK_CONTAINMENT_RECONCILIATION_GIT_PROVENANCE_FIXTURE)) {
            if ($env:REFUNDDESK_CONTAINMENT_RECONCILIATION_GIT_PROVENANCE_FIXTURE -cne "1") {
                Throw-SafeError "FIXTURE_GIT_PROVENANCE_INVALID"
            }
            if (
                [string]::IsNullOrWhiteSpace($env:REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_REPOSITORY) -or
                [string]::IsNullOrWhiteSpace($env:REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_ALTERNATE_HEAD)
            ) { Throw-SafeError "FIXTURE_GIT_REPOSITORY_INVALID" }
            $fixtureRepository = [IO.Path]::GetFullPath($env:REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_REPOSITORY)
            Assert-NoReparsePath -Path $fixtureRepository -FailureCode "FIXTURE_GIT_REPOSITORY_INVALID"
            $fixtureRoot = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($toolDirectory))
            $fixtureRootPrefix = $fixtureRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
            if (
                $fixtureRepository -cne $repository -or
                -not $repository.StartsWith($fixtureRootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
                -not [IO.Directory]::Exists((Join-Path $repository ".git"))
            ) { Throw-SafeError "FIXTURE_GIT_REPOSITORY_INVALID" }
            $fixtureGitAlternateHead = $env:REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_ALTERNATE_HEAD
            if ($fixtureGitAlternateHead -notmatch "^(?:[0-9a-f]{40}|[0-9a-f]{64})$") {
                Throw-SafeError "FIXTURE_GIT_ALTERNATE_HEAD_INVALID"
            }
            $sourceProvenanceFixture = $true
            $fixtureEnvironmentValues["REFUNDDESK_CONTAINMENT_RECONCILIATION_GIT_PROVENANCE_FIXTURE"] = "1"
            $fixtureEnvironmentValues["REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_REPOSITORY"] = $fixtureRepository
            $fixtureEnvironmentValues["REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_ALTERNATE_HEAD"] = $fixtureGitAlternateHead
        }
        $nodeExecutable = Resolve-FixtureApplication -Name "node.exe" -FailureCode "FIXTURE_NODE_INVALID"
        $gitExecutable = Resolve-FixtureApplication -Name "git.exe" -FailureCode "FIXTURE_GIT_INVALID"
        $nodeExecutableSha256 = Get-LockedFileSha256 -Path $nodeExecutable -FailureCode "FIXTURE_NODE_INVALID"
        $gitExecutableSha256 = Get-LockedFileSha256 -Path $gitExecutable -FailureCode "FIXTURE_GIT_INVALID"
        $awsTimeout = $FixtureTimeoutSeconds
        $sshTimeout = $FixtureTimeoutSeconds
        $validatorTimeout = $FixtureTimeoutSeconds
    }
    else {
        if (-not [string]::IsNullOrEmpty($FixtureToolDirectory) -or -not [string]::IsNullOrEmpty($FixtureEvidencePath)) {
            Throw-SafeError "FIXTURE_ARGUMENT_FORBIDDEN"
        }
        $awsExecutable = Resolve-PinnedApplication -Path $PinnedAwsPath -ExpectedSha256 $PinnedAwsSha256 -FailureCode "AWS_EXECUTABLE_INVALID"
        $sshExecutable = Resolve-PinnedApplication -Path $PinnedSshPath -ExpectedSha256 $PinnedSshSha256 -FailureCode "SSH_EXECUTABLE_INVALID"
        $nodeExecutable = Resolve-PinnedApplication -Path $PinnedNodePath -ExpectedSha256 $PinnedNodeSha256 -FailureCode "NODE_EXECUTABLE_INVALID"
        $gitExecutable = Resolve-PinnedApplication -Path $PinnedGitPath -ExpectedSha256 $PinnedGitSha256 -FailureCode "GIT_EXECUTABLE_INVALID"
        $awsExecutableSha256 = $PinnedAwsSha256
        $sshExecutableSha256 = $PinnedSshSha256
        $nodeExecutableSha256 = $PinnedNodeSha256
        $gitExecutableSha256 = $PinnedGitSha256
        $identityCandidate = Join-Path $repository "sandbox-evidence.local/aws/refunddesk-sandbox-lightsail-rsa"
        $knownHostsCandidate = Join-Path $repository "sandbox-evidence.local/aws/known_hosts.refunddesk-sandbox"
        $identityExpected = $ExpectedIdentitySha256
        $knownHostsExpected = $ExpectedKnownHostsSha256
        $defaultCredentialPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) ".aws/credentials"
        $awsCredentialCandidate = $defaultCredentialPath
        $identityFailureCode = "IDENTITY_FILE_INVALID"
        $knownHostsFailureCode = "KNOWN_HOSTS_FILE_INVALID"
        $credentialFailureCode = "AWS_CREDENTIAL_FILE_INVALID"
        $evidenceParent = Assert-SecureDirectory -Path (Join-Path $repository "sandbox-evidence.local/aws") -FailureCode "EVIDENCE_DIRECTORY_INVALID"
        $evidencePath = Join-Path $evidenceParent ("containment-reconciliation-{0}-{1}.local.json" -f `
            ([DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")), (Get-RandomNonce).Substring(0, 12))
        $fixtureEnvironmentValues = $null
        $awsTimeout = 30
        $sshTimeout = 300
        $validatorTimeout = 30
    }
    $sourceProvenanceEnabled = -not $contractMode -or $sourceProvenanceFixture

    $identityLock = Open-PinnedTransportLock -Path $identityCandidate -ExpectedSha256 $identityExpected -FailureCode $identityFailureCode
    $knownHostsLock = Open-PinnedTransportLock -Path $knownHostsCandidate -ExpectedSha256 $knownHostsExpected -FailureCode $knownHostsFailureCode
    $awsCredentialLock = Open-RestrictedCredentialLock -Path $awsCredentialCandidate -FailureCode $credentialFailureCode
    $identityPath = $identityLock.Path
    $knownHostsPath = $knownHostsLock.Path
    $awsCredentialPath = $awsCredentialLock.Path

    $awsHomePath = Assert-IsolatedAwsHome -Path $evidenceParent -FailureCode "AWS_HOME_NOT_ISOLATED"
    $sshHomePath = Assert-IsolatedSshHome -Path $evidenceParent -FailureCode "SSH_HOME_NOT_ISOLATED"
    $awsEnvironment = New-ChildEnvironment -Kind "AWS" -AwsCredentialPath $awsCredentialPath -AwsHomePath $awsHomePath -FixtureValues $fixtureEnvironmentValues
    $sshEnvironment = New-ChildEnvironment -Kind "SSH" -SshHomePath $sshHomePath -FixtureValues $fixtureEnvironmentValues
    $nodeEnvironment = New-ChildEnvironment -Kind "NODE"
    $gitEnvironment = New-ChildEnvironment -Kind "NODE"

    $repositoryHead = if ($sourceProvenanceEnabled) {
        Get-RepositoryHead -Repository $repository -GitExecutable $gitExecutable -GitExecutableSha256 $gitExecutableSha256 -GitEnvironment $gitEnvironment
    }
    else { $null }

    $sourceSpecifications = @(
        [pscustomobject]@{
            Name = "runner"; RelativePath = "deploy/lightsail/scripts/reconcile-host-containment.sh"
            WorktreePath = $runnerPath; MaximumBytes = 262144
        },
        [pscustomobject]@{
            Name = "validator"; RelativePath = "scripts/validate-lightsail-containment-reconciliation.mjs"
            WorktreePath = $validatorPath; MaximumBytes = 1048576
        },
        [pscustomobject]@{
            Name = "wrapper"; RelativePath = "scripts/invoke-lightsail-containment-reconciliation.ps1"
            WorktreePath = $wrapperPath; MaximumBytes = 1048576
        },
        [pscustomobject]@{
            Name = "schema"; RelativePath = "docs/schemas/refunddesk-lightsail-containment-reconciliation-v1.schema.json"
            WorktreePath = $schemaPath; MaximumBytes = 1048576
        }
    )
    if ($sourceProvenanceEnabled) {
        $sourceSpecifications += @(
            [pscustomobject]@{
                Name = "postflightObserver"; RelativePath = "deploy/lightsail/scripts/observe-host-postflight.sh"
                WorktreePath = (Join-Path $repository "deploy/lightsail/scripts/observe-host-postflight.sh"); MaximumBytes = 262144
            },
            [pscustomobject]@{
                Name = "postflightValidator"; RelativePath = "scripts/validate-lightsail-postflight.mjs"
                WorktreePath = (Join-Path $repository "scripts/validate-lightsail-postflight.mjs"); MaximumBytes = 1048576
            },
            [pscustomobject]@{
                Name = "postflightWrapper"; RelativePath = "scripts/invoke-lightsail-postflight.ps1"
                WorktreePath = (Join-Path $repository "scripts/invoke-lightsail-postflight.ps1"); MaximumBytes = 1048576
            },
            [pscustomobject]@{
                Name = "postflightSchema"; RelativePath = "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json"
                WorktreePath = (Join-Path $repository "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json"); MaximumBytes = 1048576
            }
        )
    }
    $sourceRecords = [ordered]@{}
    $sourceBindings = [Collections.Generic.List[object]]::new()
    for ($sourceIndex = 0; $sourceIndex -lt $sourceSpecifications.Count; $sourceIndex += 1) {
        $specification = $sourceSpecifications[$sourceIndex]
        try {
            $record = Get-SourceRecord -Repository $repository -RelativePath $specification.RelativePath `
                -WorktreePath $specification.WorktreePath -GitExecutable $gitExecutable `
                -GitExecutableSha256 $gitExecutableSha256 -GitEnvironment $gitEnvironment `
                -FixtureOnly (-not $sourceProvenanceEnabled) -MaximumBytes $specification.MaximumBytes `
                -CommitOid $repositoryHead
        }
        catch {
            if ($_.Exception.Message -match "^REFUNDDESK_SOURCE_") { throw }
            Throw-SafeError ("SOURCE_{0}_INVALID" -f $specification.Name.ToUpperInvariant())
        }
        $sourceRecords[$specification.Name] = $record
        $sourceBindings.Add([pscustomobject]@{
            Name = $specification.Name
            RelativePath = $specification.RelativePath
            WorktreePath = $specification.WorktreePath
            MaximumBytes = $specification.MaximumBytes
            Record = $record
        })
        if ($sourceProvenanceFixture -and $sourceIndex -eq 0) {
            Invoke-ContractHeadRace -Repository $repository `
                -Mode $env:REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_MODE `
                -AlternateCommitOid $fixtureGitAlternateHead
        }
    }
    $runnerSource = $sourceRecords.runner
    $validatorSource = $sourceRecords.validator
    $wrapperSource = $sourceRecords.wrapper
    $schemaSource = $sourceRecords.schema
    $expectedPostflightSources = $null
    if (-not $contractMode) {
        $expectedPostflightSources = [ordered]@{
            observer = $sourceRecords.postflightObserver
            validator = $sourceRecords.postflightValidator
            wrapper = $sourceRecords.postflightWrapper
            schema = $sourceRecords.postflightSchema
        }
    }
    if ($sourceProvenanceEnabled) {
        Assert-RepositorySourcesAtCommit -Repository $repository -CommitOid $repositoryHead `
            -Bindings $sourceBindings.ToArray() -GitExecutable $gitExecutable `
            -GitExecutableSha256 $gitExecutableSha256 -GitEnvironment $gitEnvironment
    }


    if (
        $runnerSource.Bytes.Length -eq 0 -or $runnerSource.Bytes[0] -eq 239 -or
        $runnerSource.Bytes -contains 0 -or $runnerSource.Bytes -contains 13 -or
        $runnerSource.Bytes[$runnerSource.Bytes.Length - 1] -ne 10
    ) { Throw-SafeError "RUNNER_ENCODING_INVALID" }

    $preflightLock = Open-BoundedEvidenceLock -Path $PreflightEvidencePath -MaximumBytes $MaximumPreflightBytes -FailureCode "PREFLIGHT_EVIDENCE_INVALID"
    $preflightDocument = ConvertFrom-ExactJson -Bytes $preflightLock.Bytes -FailureCode "PREFLIGHT_EVIDENCE_INVALID"
    $preflightAdmission = Assert-PostflightCapture -Capture $preflightDocument -ExpectedRepositoryHead $repositoryHead `
        -ExpectedPostflightSources $expectedPostflightSources -FixtureOnly $contractMode
    if ($sourceProvenanceEnabled) {
        Assert-RepositorySourcesAtCommit -Repository $repository -CommitOid $repositoryHead `
            -Bindings $sourceBindings.ToArray() -GitExecutable $gitExecutable `
            -GitExecutableSha256 $gitExecutableSha256 -GitEnvironment $gitEnvironment
    }

    $nonce = Get-RandomNonce
    $localStartedAt = Get-UtcTimestamp
    $identityBefore = Get-AwsIdentity -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -TimeoutSeconds $awsTimeout
    $instanceBefore = Get-AwsInstance -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -TimeoutSeconds $awsTimeout
    $firewallBefore = Get-AwsFirewall -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -ExpectedSshCidr $expectedSshCidrValue -TimeoutSeconds $awsTimeout
    if ($sourceProvenanceEnabled) {
        Assert-RepositorySourcesAtCommit -Repository $repository -CommitOid $repositoryHead `
            -Bindings $sourceBindings.ToArray() -GitExecutable $gitExecutable `
            -GitExecutableSha256 $gitExecutableSha256 -GitEnvironment $gitEnvironment
    }

    $sshArguments = @(
        "-F", "NUL",
        "-o", "BatchMode=yes",
        "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no",
        "-o", "PreferredAuthentications=publickey",
        "-o", "IdentitiesOnly=yes",
        "-o", "IdentityAgent=none",
        "-o", "GSSAPIAuthentication=no",
        "-o", "StrictHostKeyChecking=yes",
        "-o", ("UserKnownHostsFile={0}" -f $knownHostsPath),
        "-o", "GlobalKnownHostsFile=NUL",
        "-o", "CheckHostIP=yes",
        "-o", "UpdateHostKeys=no",
        "-o", "ForwardAgent=no",
        "-o", "ClearAllForwardings=yes",
        "-o", "PermitLocalCommand=no",
        "-o", "RequestTTY=no",
        "-o", "ConnectTimeout=15",
        "-o", "ConnectionAttempts=1",
        "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=2",
        "-i", $identityPath,
        ("ubuntu@{0}" -f $instanceBefore.publicIpAddress),
        "sudo", "--non-interactive", "--",
        "/usr/bin/env", "-i",
        "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
        "LC_ALL=C", "TZ=UTC",
        "/bin/bash", "--noprofile", "--norc", "-s", "--",
        "--nonce", $nonce,
        "--expected-revision", $ExpectedRevision,
        "--runner-sha256", $runnerSource.Sha256
    )
    $remoteNotBefore = Get-UtcTimestamp
    $sshResult = Invoke-BoundedProcess -Executable $sshExecutable -ExpectedExecutableSha256 $sshExecutableSha256 `
        -Arguments $sshArguments -EnvironmentVariables $sshEnvironment -InputBytes $runnerSource.Bytes `
        -TimeoutSeconds $sshTimeout -MaximumStdoutBytes $MaximumSshOutputBytes -MaximumStderrBytes $MaximumDiagnosticBytes
    $remoteNotAfter = Get-UtcTimestamp
    [void] (Assert-IsolatedSshHome -Path $sshHomePath -FailureCode "SSH_HOME_NOT_ISOLATED")
    if ($sourceProvenanceEnabled) {
        Assert-RepositorySourcesAtCommit -Repository $repository -CommitOid $repositoryHead `
            -Bindings $sourceBindings.ToArray() -GitExecutable $gitExecutable `
            -GitExecutableSha256 $gitExecutableSha256 -GitEnvironment $gitEnvironment
    }

    $identityAfter = Get-AwsIdentity -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -TimeoutSeconds $awsTimeout
    $instanceAfter = Get-AwsInstance -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -TimeoutSeconds $awsTimeout
    $firewallAfter = Get-AwsFirewall -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -ExpectedSshCidr $expectedSshCidrValue -TimeoutSeconds $awsTimeout
    [void] (Assert-IsolatedAwsHome -Path $awsHomePath -FailureCode "AWS_HOME_NOT_ISOLATED")
    Assert-PinnedTransportLockUnchanged -Lock $identityLock -FailureCode $identityFailureCode
    Assert-PinnedTransportLockUnchanged -Lock $knownHostsLock -FailureCode $knownHostsFailureCode
    Assert-RestrictedCredentialLockUnchanged -Lock $awsCredentialLock -FailureCode $credentialFailureCode

    if ($null -ne $sshResult.FailureCode) { Throw-SafeError $sshResult.FailureCode }
    if ($sshResult.StderrLength -ne 0) { Throw-SafeError "SSH_STDERR_FORBIDDEN" }
    if ($identityBefore.account -cne $identityAfter.account) { Throw-SafeError "AWS_ACCOUNT_CHANGED" }
    if (
        $instanceBefore.name -cne $instanceAfter.name -or
        $instanceBefore.state -cne $instanceAfter.state -or
        $instanceBefore.publicIpAddress -cne $instanceAfter.publicIpAddress
    ) { Throw-SafeError "AWS_INSTANCE_CHANGED" }
    if ($firewallBefore.Digest -cne $firewallAfter.Digest) { Throw-SafeError "AWS_FIREWALL_CHANGED" }
    if (@(0, 20, 21) -notcontains $sshResult.ExitCode) { Throw-SafeError "REMOTE_EXIT_CODE_INVALID" }

    $validatorArguments = @(
        $validatorPath,
        "--expected-nonce", $nonce,
        "--expected-runner-sha256", $runnerSource.Sha256,
        "--process-exit-code", ([string] $sshResult.ExitCode),
        "--not-before", $remoteNotBefore,
        "--not-after", $remoteNotAfter
    )
    $validatorExecutionLock = $null
    $schemaExecutionLock = $null
    try {
        $validatorExecutionLock = Open-VerifiedReadLock -Path $validatorPath -ExpectedSha256 $validatorSource.Sha256 -FailureCode "VALIDATOR_CHANGED"
        $schemaExecutionLock = Open-VerifiedReadLock -Path $schemaPath -ExpectedSha256 $schemaSource.Sha256 -FailureCode "SCHEMA_CHANGED"
        $validationResult = Invoke-BoundedProcess -Executable $nodeExecutable -ExpectedExecutableSha256 $nodeExecutableSha256 `
            -Arguments $validatorArguments -EnvironmentVariables $nodeEnvironment -InputBytes $sshResult.Stdout `
            -TimeoutSeconds $validatorTimeout -MaximumStdoutBytes $MaximumValidatorOutputBytes -MaximumStderrBytes $MaximumDiagnosticBytes
    }
    finally {
        if ($null -ne $schemaExecutionLock) { $schemaExecutionLock.Stream.Dispose() }
        if ($null -ne $validatorExecutionLock) { $validatorExecutionLock.Stream.Dispose() }
    }
    if (
        $null -ne $validationResult.FailureCode -or
        $validationResult.ExitCode -ne 0 -or
        $validationResult.StderrLength -ne 0
    ) { Throw-SafeError "REMOTE_DOCUMENT_INVALID" }

    $validation = ConvertFrom-ExactJson -Bytes $validationResult.Stdout -FailureCode "VALIDATOR_OUTPUT_INVALID"
    Assert-ExactProperties -Object $validation -Properties @(
        "schemaVersion", "kind", "result", "code", "operation", "remote", "redaction"
    ) -FailureCode "VALIDATOR_OUTPUT_INVALID"
    if (
        $validation.schemaVersion -ne 1 -or
        $validation.kind -cne "refunddesk.lightsail.containment-reconciliation.validation" -or
        $validation.result -cne $validation.remote.result -or
        $validation.code -cne $validation.remote.code -or
        $validation.operation -cne $validation.remote.operation -or
        @("PASS", "FAIL", "INCOMPLETE") -cnotcontains $validation.result -or
        $validation.remote.expectedRevision -cne $ExpectedRevision -or
        $validation.remote.nonce -cne $nonce
    ) { Throw-SafeError "VALIDATOR_OUTPUT_INVALID" }
    if ($null -ne $validation.operation -and @("backup", "retention") -cnotcontains $validation.operation) {
        Throw-SafeError "VALIDATOR_OUTPUT_INVALID"
    }
    if (
        $null -ne $validation.remote.marker.runnerSha256 -and
        $validation.remote.marker.runnerSha256 -cne $runnerSource.Sha256
    ) { Throw-SafeError "VALIDATOR_OUTPUT_INVALID" }
    Assert-AllFalse -Value $validation.redaction -Properties @(
        "rawSecretPresent", "rawApiKeyPresent", "rawSignaturePresent", "rawPayloadPresent",
        "customerDataPresent", "arbitraryPathPresent", "ipAddressPresent", "stderrPresent",
        "keyDigestPresent"
    ) -FailureCode "VALIDATOR_OUTPUT_INVALID"
    if ($sourceProvenanceEnabled) {
        Assert-RepositorySourcesAtCommit -Repository $repository -CommitOid $repositoryHead `
            -Bindings $sourceBindings.ToArray() -GitExecutable $gitExecutable `
            -GitExecutableSha256 $gitExecutableSha256 -GitEnvironment $gitEnvironment
    }

    $remoteStarted = ConvertFrom-UtcTimestamp -Value $validation.remote.startedAt -FailureCode "VALIDATOR_OUTPUT_INVALID"
    $localStarted = ConvertFrom-UtcTimestamp -Value $localStartedAt -FailureCode "VALIDATOR_OUTPUT_INVALID"
    $capturedAtDate = if ($remoteStarted -lt $localStarted) { $remoteStarted } else { $localStarted }
    $validUntilDate = $capturedAtDate.AddMinutes(15)
    if ([DateTime]::UtcNow -ge $validUntilDate) { Throw-SafeError "EVIDENCE_EXPIRED_BEFORE_WRITE" }

    $evidence = [ordered]@{
        schemaVersion = 1
        kind = "refunddesk.lightsail.containment-reconciliation.capture"
        result = $validation.result
        code = $validation.code
        admission = if ($contractMode) { "FIXTURE_ONLY" } else { "ADMISSIBLE_EXACT_8DA_CONTAINMENT_RECONCILIATION" }
        operation = $validation.operation
        capturedAt = $capturedAtDate.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
        validUntil = $validUntilDate.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
        preflight = [ordered]@{
            sha256 = $preflightLock.Sha256
            profile = $preflightAdmission.Profile
            capturedAt = $preflightDocument.capturedAt
            validUntil = $preflightDocument.validUntil
            repositoryHead = $preflightDocument.provenance.repositoryHead
        }
        remote = $validation.remote
        awsControlPlane = [ordered]@{
            targetId = "$ExpectedInstanceName@$ExpectedAwsRegion"
            accountMatches = $true
            regionMatches = $true
            instanceMatches = $true
            instanceRunning = $true
            firewallClosedBefore = $firewallBefore.Closed
            firewallClosedAfter = $firewallAfter.Closed
            firewallUnchanged = $true
        }
        provenance = [ordered]@{
            remoteDocumentSha256 = Get-Sha256Hex -Bytes $sshResult.Stdout
            preflightEvidenceSha256 = $preflightLock.Sha256
            runner = [ordered]@{ gitObject = $runnerSource.GitObject; sha256 = $runnerSource.Sha256 }
            validator = [ordered]@{ gitObject = $validatorSource.GitObject; sha256 = $validatorSource.Sha256 }
            wrapper = [ordered]@{ gitObject = $wrapperSource.GitObject; sha256 = $wrapperSource.Sha256 }
            schema = [ordered]@{ gitObject = $schemaSource.GitObject; sha256 = $schemaSource.Sha256 }
            repositoryHead = $repositoryHead
            transportInputsPinned = $true
            fixtureOnly = $contractMode
        }
        redaction = [ordered]@{
            rawSecretPresent = $false
            rawApiKeyPresent = $false
            rawSignaturePresent = $false
            rawPayloadPresent = $false
            customerDataPresent = $false
            arbitraryPathPresent = $false
            ipAddressPresent = $false
            stderrPresent = $false
            keyDigestPresent = $false
        }
    }
    $evidenceText = $evidence | ConvertTo-Json -Compress -Depth 100
    if (
        $evidenceText -match '\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b' -or
        $evidenceText -match '\b(?:whsec|absec)_[A-Za-z0-9_]{12,}\b' -or
        $evidenceText -match '-----BEGIN .*PRIVATE KEY-----' -or
        $evidenceText -match '"(?:[A-Za-z]:\\|\\\\|/)' -or
        $evidenceText -match '"(?:[0-9]{1,3}\.){3}[0-9]{1,3}"'
    ) { Throw-SafeError "EVIDENCE_REDACTION_FAILED" }
    $evidenceBytes = [Text.UTF8Encoding]::new($false).GetBytes($evidenceText + [char] 10)
    if ($sourceProvenanceEnabled) {
        Assert-RepositorySourcesAtCommit -Repository $repository -CommitOid $repositoryHead `
            -Bindings $sourceBindings.ToArray() -GitExecutable $gitExecutable `
            -GitExecutableSha256 $gitExecutableSha256 -GitEnvironment $gitEnvironment
    }
    Write-EvidenceCreateNew -Path $evidencePath -Bytes $evidenceBytes

    if ($contractMode) {
        [Console]::Out.WriteLine("CONTAINMENT_RECONCILIATION_FIXTURE_COMPLETE")
    }
    else {
        [Console]::Out.WriteLine("CONTAINMENT_RECONCILIATION_COMPLETE_{0}" -f $validation.result)
    }
    switch ($validation.result) {
        "PASS" { exit 0 }
        "FAIL" { exit 20 }
        "INCOMPLETE" { exit 21 }
        default { Throw-SafeError "VALIDATOR_OUTPUT_INVALID" }
    }
}
catch {
    $code = "INTERNAL_ERROR"
    if ($_.Exception.Message -match '^REFUNDDESK_([A-Z][A-Z0-9_]{0,63})$') { $code = $Matches[1] }
    [Console]::Error.WriteLine("containment-reconciliation-error:{0}" -f $code)
    exit 1
}
finally {
    if ($null -ne $preflightLock) { $preflightLock.Stream.Dispose() }
    if ($null -ne $awsCredentialLock) { $awsCredentialLock.Stream.Dispose() }
    if ($null -ne $knownHostsLock) { $knownHostsLock.Stream.Dispose() }
    if ($null -ne $identityLock) { $identityLock.Stream.Dispose() }
}
