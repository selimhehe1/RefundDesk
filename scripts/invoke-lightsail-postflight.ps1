[CmdletBinding()]
param(
    [Parameter()]
    [switch] $ContractFixture,

    [Parameter()]
    [string] $FixtureToolDirectory,

    [Parameter()]
    [string] $FixtureEvidencePath,

    [Parameter()]
    [ValidateRange(1, 15)]
    [int] $FixtureTimeoutSeconds = 3,

    [Parameter()]
    [AllowEmptyString()]
    [string] $ExpectedSshCidr
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ExpectedAwsAccount = "633229204288"
$ExpectedAwsRegion = "eu-west-3"
$ExpectedInstanceName = "refunddesk-sandbox-paris"
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
$MaximumSshOutputBytes = 262144
$MaximumDiagnosticBytes = 32768
$MaximumValidatorOutputBytes = 1048576

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

function Assert-PinnedTransportFile {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedSha256,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )

    $canonical = Get-CanonicalFile -Path $Path -FailureCode $FailureCode
    Assert-RestrictedAcl -Path $canonical -FailureCode $FailureCode
    try {
        $bytes = [IO.File]::ReadAllBytes($canonical)
    }
    catch {
        Throw-SafeError $FailureCode
    }
    if ((Get-Sha256Hex -Bytes $bytes) -cne $ExpectedSha256) {
        Throw-SafeError $FailureCode
    }
    return $canonical
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
            $Process.Kill()
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

function New-ChildEnvironment {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("AWS", "SSH", "NODE")][string] $Kind,
        [Parameter()][string] $AwsCredentialPath,
        [Parameter()][string] $AwsHomePath,
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

try {
    $expectedSshCidrValue = Assert-CanonicalIpv4HostCidr -Value $ExpectedSshCidr -FailureCode "EXPECTED_SSH_CIDR_INVALID"
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    $observerPath = Get-CanonicalFile -Path (Join-Path $repository "deploy/lightsail/scripts/observe-host-postflight.sh") -FailureCode "OBSERVER_INVALID"
    $validatorPath = Get-CanonicalFile -Path (Join-Path $repository "scripts/validate-lightsail-postflight.mjs") -FailureCode "VALIDATOR_INVALID"
    $wrapperPath = Get-CanonicalFile -Path $PSCommandPath -FailureCode "WRAPPER_INVALID"
    $schemaPath = Get-CanonicalFile -Path (Join-Path $repository "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json") -FailureCode "SCHEMA_INVALID"
    [byte[]] $observerBytes = Read-LockedFileBytes -Path $observerPath -MaximumBytes 262144 -FailureCode "OBSERVER_INVALID"
    $observerWorktreeSha256 = Get-Sha256Hex -Bytes $observerBytes
    $validatorWorktreeSha256 = Get-LockedFileSha256 -Path $validatorPath -FailureCode "VALIDATOR_INVALID"
    $wrapperWorktreeSha256 = Get-LockedFileSha256 -Path $wrapperPath -FailureCode "WRAPPER_INVALID"
    $schemaWorktreeSha256 = Get-LockedFileSha256 -Path $schemaPath -FailureCode "SCHEMA_INVALID"
    if (
        $observerBytes.Length -eq 0 -or $observerBytes.Length -gt 262144 -or
        $observerBytes[0] -eq 239 -or $observerBytes -contains 0 -or $observerBytes -contains 13 -or
        $observerBytes[$observerBytes.Length - 1] -ne 10
    ) {
        Throw-SafeError "OBSERVER_ENCODING_INVALID"
    }

    $contractMode = $ContractFixture.IsPresent
    if ($contractMode) {
        if ($env:REFUNDDESK_POSTFLIGHT_CONTRACT_MODE -cne "1") {
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
        $awsCredentialCandidate = Join-Path $toolDirectory "aws-credentials.fixture"
        $identityExpected = Get-Sha256Hex -Bytes ([IO.File]::ReadAllBytes($identityCandidate))
        $knownHostsExpected = Get-Sha256Hex -Bytes ([IO.File]::ReadAllBytes($knownHostsCandidate))
        $identityPath = Assert-PinnedTransportFile -Path $identityCandidate -ExpectedSha256 $identityExpected -FailureCode "FIXTURE_IDENTITY_INVALID"
        $knownHostsPath = Assert-PinnedTransportFile -Path $knownHostsCandidate -ExpectedSha256 $knownHostsExpected -FailureCode "FIXTURE_KNOWN_HOSTS_INVALID"
        $awsCredentialPath = Assert-RestrictedCredentialFile -Path $awsCredentialCandidate -FailureCode "FIXTURE_AWS_CREDENTIAL_FILE_INVALID"
        $evidenceParent = Assert-SecureDirectory -Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($FixtureEvidencePath))) -FailureCode "FIXTURE_EVIDENCE_DIRECTORY_INVALID"
        $evidencePath = [IO.Path]::GetFullPath($FixtureEvidencePath)
        $repositoryPrefix = $repository.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (
            [IO.Path]::GetDirectoryName($evidencePath) -cne $evidenceParent -or
            $evidencePath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)
        ) {
            Throw-SafeError "FIXTURE_EVIDENCE_PATH_INVALID"
        }
        $awsTimeout = $FixtureTimeoutSeconds
        $sshTimeout = $FixtureTimeoutSeconds
        $validatorTimeout = $FixtureTimeoutSeconds
        $fixtureEnvironmentValues = [ordered]@{
            REFUNDDESK_POSTFLIGHT_FAKE_MODE = $env:REFUNDDESK_POSTFLIGHT_FAKE_MODE
            REFUNDDESK_POSTFLIGHT_FAKE_REMOTE_TEMPLATE = $env:REFUNDDESK_POSTFLIGHT_FAKE_REMOTE_TEMPLATE
            REFUNDDESK_POSTFLIGHT_FAKE_STATE = $env:REFUNDDESK_POSTFLIGHT_FAKE_STATE
        }
        foreach ($fixtureValue in $fixtureEnvironmentValues.Values) {
            if ([string]::IsNullOrWhiteSpace($fixtureValue)) {
                Throw-SafeError "FIXTURE_ENVIRONMENT_INVALID"
            }
        }
        $nodeExecutable = Resolve-FixtureApplication -Name "node.exe" -FailureCode "FIXTURE_NODE_INVALID"
        $gitExecutable = Resolve-FixtureApplication -Name "git.exe" -FailureCode "FIXTURE_GIT_INVALID"
        $nodeExecutableSha256 = Get-LockedFileSha256 -Path $nodeExecutable -FailureCode "FIXTURE_NODE_INVALID"
        $gitExecutableSha256 = Get-LockedFileSha256 -Path $gitExecutable -FailureCode "FIXTURE_GIT_INVALID"
    }
    else {
        if (
            -not [string]::IsNullOrEmpty($FixtureToolDirectory) -or
            -not [string]::IsNullOrEmpty($FixtureEvidencePath)
        ) {
            Throw-SafeError "FIXTURE_ARGUMENT_FORBIDDEN"
        }
        $awsExecutable = Resolve-PinnedApplication -Path $PinnedAwsPath -ExpectedSha256 $PinnedAwsSha256 -FailureCode "AWS_EXECUTABLE_INVALID"
        $sshExecutable = Resolve-PinnedApplication -Path $PinnedSshPath -ExpectedSha256 $PinnedSshSha256 -FailureCode "SSH_EXECUTABLE_INVALID"
        $awsExecutableSha256 = $PinnedAwsSha256
        $sshExecutableSha256 = $PinnedSshSha256
        $identityPath = Assert-PinnedTransportFile `
            -Path (Join-Path $repository "sandbox-evidence.local/aws/refunddesk-sandbox-lightsail-rsa") `
            -ExpectedSha256 $ExpectedIdentitySha256 `
            -FailureCode "IDENTITY_FILE_INVALID"
        $knownHostsPath = Assert-PinnedTransportFile `
            -Path (Join-Path $repository "sandbox-evidence.local/aws/known_hosts.refunddesk-sandbox") `
            -ExpectedSha256 $ExpectedKnownHostsSha256 `
            -FailureCode "KNOWN_HOSTS_FILE_INVALID"
        $defaultCredentialPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) ".aws/credentials"
        $awsCredentialPath = Assert-RestrictedCredentialFile -Path $defaultCredentialPath -FailureCode "AWS_CREDENTIAL_FILE_INVALID"
        $evidenceParent = Assert-SecureDirectory -Path (Join-Path $repository "sandbox-evidence.local/aws") -FailureCode "EVIDENCE_DIRECTORY_INVALID"
        $nonceForName = Get-RandomNonce
        $evidencePath = Join-Path $evidenceParent ("host-postflight-{0}-{1}.local.json" -f ([DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")), $nonceForName.Substring(0, 12))
        $awsTimeout = 30
        $sshTimeout = 90
        $validatorTimeout = 30
        $fixtureEnvironmentValues = $null
        $nodeExecutable = Resolve-PinnedApplication -Path $PinnedNodePath -ExpectedSha256 $PinnedNodeSha256 -FailureCode "NODE_EXECUTABLE_INVALID"
        $gitExecutable = Resolve-PinnedApplication -Path $PinnedGitPath -ExpectedSha256 $PinnedGitSha256 -FailureCode "GIT_EXECUTABLE_INVALID"
        $nodeExecutableSha256 = $PinnedNodeSha256
        $gitExecutableSha256 = $PinnedGitSha256
    }

    $awsHomePath = Assert-IsolatedAwsHome -Path $evidenceParent -FailureCode "AWS_HOME_NOT_ISOLATED"
    $awsEnvironment = New-ChildEnvironment -Kind "AWS" -AwsCredentialPath $awsCredentialPath -AwsHomePath $awsHomePath -FixtureValues $fixtureEnvironmentValues
    $sshEnvironment = New-ChildEnvironment -Kind "SSH" -FixtureValues $fixtureEnvironmentValues
    $nodeEnvironment = New-ChildEnvironment -Kind "NODE"
    $nonce = Get-RandomNonce
    $localStartedAt = Get-UtcTimestamp

    $identityBefore = Get-AwsIdentity -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -TimeoutSeconds $awsTimeout
    $instanceBefore = Get-AwsInstance -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -TimeoutSeconds $awsTimeout
    $firewallBefore = Get-AwsFirewall -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -ExpectedSshCidr $expectedSshCidrValue -TimeoutSeconds $awsTimeout

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
        "/bin/bash", "--noprofile", "--norc", "-s", "--", "--nonce", $nonce
    )
    $remoteNotBefore = Get-UtcTimestamp
    $sshResult = Invoke-BoundedProcess `
        -Executable $sshExecutable `
        -ExpectedExecutableSha256 $sshExecutableSha256 `
        -Arguments $sshArguments `
        -EnvironmentVariables $sshEnvironment `
        -InputBytes $observerBytes `
        -TimeoutSeconds $sshTimeout `
        -MaximumStdoutBytes $MaximumSshOutputBytes `
        -MaximumStderrBytes $MaximumDiagnosticBytes
    $remoteNotAfter = Get-UtcTimestamp

    $identityAfter = Get-AwsIdentity -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -TimeoutSeconds $awsTimeout
    $instanceAfter = Get-AwsInstance -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -TimeoutSeconds $awsTimeout
    $firewallAfter = Get-AwsFirewall -AwsExecutable $awsExecutable -AwsExecutableSha256 $awsExecutableSha256 -AwsEnvironment $awsEnvironment -ExpectedSshCidr $expectedSshCidrValue -TimeoutSeconds $awsTimeout
    [void] (Assert-IsolatedAwsHome -Path $awsHomePath -FailureCode "AWS_HOME_NOT_ISOLATED")

    if ($null -ne $sshResult.FailureCode) {
        Throw-SafeError $sshResult.FailureCode
    }
    if ($sshResult.StderrLength -ne 0) {
        Throw-SafeError "SSH_STDERR_FORBIDDEN"
    }
    if ($identityBefore.account -cne $identityAfter.account) {
        Throw-SafeError "AWS_ACCOUNT_CHANGED"
    }
    if (
        $instanceBefore.name -cne $instanceAfter.name -or
        $instanceBefore.state -cne $instanceAfter.state -or
        $instanceBefore.publicIpAddress -cne $instanceAfter.publicIpAddress
    ) {
        Throw-SafeError "AWS_INSTANCE_CHANGED"
    }
    if ($firewallBefore.Digest -cne $firewallAfter.Digest) {
        Throw-SafeError "AWS_FIREWALL_CHANGED"
    }

    $validatorArguments = @(
        $validatorPath,
        "--expected-nonce", $nonce,
        "--process-exit-code", ([string] $sshResult.ExitCode),
        "--not-before", $remoteNotBefore,
        "--not-after", $remoteNotAfter,
        "--repository", $repository,
        "--git-executable", $gitExecutable,
        "--expected-git-sha256", $gitExecutableSha256
    )
    if ($contractMode) {
        $validatorArguments += "--fixture-only"
    }
    $gitExecutionLock = Open-VerifiedReadLock -Path $gitExecutable -ExpectedSha256 $gitExecutableSha256 -FailureCode "GIT_EXECUTABLE_INVALID"
    try {
        $validationResult = Invoke-BoundedProcess `
            -Executable $nodeExecutable `
            -ExpectedExecutableSha256 $nodeExecutableSha256 `
            -Arguments $validatorArguments `
            -EnvironmentVariables $nodeEnvironment `
            -InputBytes $sshResult.Stdout `
            -TimeoutSeconds $validatorTimeout `
            -MaximumStdoutBytes $MaximumValidatorOutputBytes `
            -MaximumStderrBytes $MaximumDiagnosticBytes
    }
    finally {
        $gitExecutionLock.Stream.Dispose()
    }
    if (
        $null -ne $validationResult.FailureCode -or
        $validationResult.ExitCode -ne 0 -or
        $validationResult.StderrLength -ne 0
    ) {
        Throw-SafeError "REMOTE_DOCUMENT_INVALID"
    }
    $validation = ConvertFrom-ExactJson -Bytes $validationResult.Stdout -FailureCode "VALIDATOR_OUTPUT_INVALID"
    Assert-ExactProperties -Object $validation -Properties @(
        "schemaVersion", "kind", "result", "posture", "remote", "provenance", "redaction"
    ) -FailureCode "VALIDATOR_OUTPUT_INVALID"
    if (
        $validation.schemaVersion -ne 1 -or
        $validation.kind -cne "refunddesk.lightsail.host-postflight.validation" -or
        $validation.result -cne $validation.remote.result -or
        $validation.posture -cne $validation.remote.posture -or
        @("PASS", "FAIL", "INCOMPLETE") -cnotcontains $validation.result -or
        @("COHERENT_CONTAINED", "RECOVERABLE_RUNTIME_STOPPED", "COHERENT_RUNNING", "DIVERGENT", "UNKNOWN") -cnotcontains $validation.posture
    ) {
        Throw-SafeError "VALIDATOR_OUTPUT_INVALID"
    }
    Assert-ExactProperties -Object $validation.provenance -Properties @(
        "observer", "validator", "wrapper", "schema", "repositoryHead", "revisionComposeVerified"
    ) -FailureCode "VALIDATOR_OUTPUT_INVALID"
    foreach ($sourceName in @("observer", "validator", "wrapper", "schema")) {
        $source = $validation.provenance.$sourceName
        Assert-ExactProperties -Object $source -Properties @("gitObject", "sha256") -FailureCode "VALIDATOR_OUTPUT_INVALID"
        if ($source.sha256 -isnot [string] -or $source.sha256 -notmatch "^[0-9a-f]{64}$") {
            Throw-SafeError "VALIDATOR_OUTPUT_INVALID"
        }
        if ($contractMode) {
            if ($null -ne $source.gitObject) {
                Throw-SafeError "VALIDATOR_OUTPUT_INVALID"
            }
        }
        elseif ($source.gitObject -isnot [string] -or $source.gitObject -notmatch "^(?:[0-9a-f]{40}|[0-9a-f]{64})$") {
            Throw-SafeError "VALIDATOR_OUTPUT_INVALID"
        }
    }
    $expectedSourceHashes = [ordered]@{
        observer = $observerWorktreeSha256
        validator = $validatorWorktreeSha256
        wrapper = $wrapperWorktreeSha256
        schema = $schemaWorktreeSha256
    }
    foreach ($sourceName in $expectedSourceHashes.Keys) {
        if ($validation.provenance.$sourceName.sha256 -cne $expectedSourceHashes[$sourceName]) {
            Throw-SafeError "VALIDATOR_PROVENANCE_MISMATCH"
        }
    }
    if ($contractMode) {
        if ($null -ne $validation.provenance.repositoryHead) {
            Throw-SafeError "VALIDATOR_OUTPUT_INVALID"
        }
    }
    elseif ($validation.provenance.repositoryHead -isnot [string] -or $validation.provenance.repositoryHead -notmatch "^(?:[0-9a-f]{40}|[0-9a-f]{64})$") {
        Throw-SafeError "VALIDATOR_OUTPUT_INVALID"
    }
    if (
        $validation.provenance.revisionComposeVerified -isnot [bool] -or
        ($validation.result -ceq "PASS" -and $validation.provenance.revisionComposeVerified -ne $true)
    ) {
        Throw-SafeError "VALIDATOR_OUTPUT_INVALID"
    }
    Assert-ExactProperties -Object $validation.redaction -Properties @(
        "rawSecretPresent", "arbitraryPathPresent", "stderrPresent"
    ) -FailureCode "VALIDATOR_OUTPUT_INVALID"
    if (
        $validation.redaction.rawSecretPresent -ne $false -or
        $validation.redaction.arbitraryPathPresent -ne $false -or
        $validation.redaction.stderrPresent -ne $false
    ) {
        Throw-SafeError "VALIDATOR_OUTPUT_INVALID"
    }

    $remoteStarted = [DateTime]::ParseExact(
        $validation.remote.startedAt,
        "yyyy-MM-ddTHH:mm:ssZ",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    )
    $localStarted = [DateTime]::ParseExact(
        $localStartedAt,
        "yyyy-MM-ddTHH:mm:ssZ",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    )
    $capturedAtDate = if ($remoteStarted -lt $localStarted) { $remoteStarted } else { $localStarted }
    $validUntilDate = $capturedAtDate.AddMinutes(15)
    if ([DateTime]::UtcNow -ge $validUntilDate) {
        Throw-SafeError "EVIDENCE_EXPIRED_BEFORE_WRITE"
    }

    $evidence = [ordered]@{
        schemaVersion = 1
        kind = "refunddesk.lightsail.host-postflight.capture"
        result = $validation.result
        admission = if ($contractMode) { "FIXTURE_ONLY" } else { "ADMISSIBLE_READ_ONLY" }
        posture = $validation.posture
        capturedAt = $capturedAtDate.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
        validUntil = $validUntilDate.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
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
            observer = $validation.provenance.observer
            validator = $validation.provenance.validator
            wrapper = $validation.provenance.wrapper
            schema = $validation.provenance.schema
            repositoryHead = $validation.provenance.repositoryHead
            revisionComposeVerified = $validation.provenance.revisionComposeVerified
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
    $evidenceText = ($evidence | ConvertTo-Json -Compress -Depth 100)
    if (
        $evidenceText -match '\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b' -or
        $evidenceText -match '\b(?:whsec|absec)_[A-Za-z0-9_]{12,}\b' -or
        $evidenceText -match '-----BEGIN .*PRIVATE KEY-----' -or
        $evidenceText -match '"(?:[A-Za-z]:\\|\\\\|/)' -or
        $evidenceText -match '"(?:[0-9]{1,3}\.){3}[0-9]{1,3}"'
    ) {
        Throw-SafeError "EVIDENCE_REDACTION_FAILED"
    }
    $evidenceBytes = [Text.UTF8Encoding]::new($false).GetBytes("$evidenceText`n")
    Write-EvidenceCreateNew -Path $evidencePath -Bytes $evidenceBytes

    if ($contractMode) {
        [Console]::Out.WriteLine("POSTFLIGHT_FIXTURE_CAPTURE_COMPLETE")
    }
    else {
        [Console]::Out.WriteLine("POSTFLIGHT_CAPTURE_COMPLETE_{0}" -f $validation.result)
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
    if ($_.Exception.Message -match '^REFUNDDESK_([A-Z][A-Z0-9_]{0,63})$') {
        $code = $Matches[1]
    }
    [Console]::Error.WriteLine("postflight-capture-error:{0}" -f $code)
    exit 1
}
