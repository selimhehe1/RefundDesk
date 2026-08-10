[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $PreflightEvidencePath,

    [Parameter(Mandatory = $true)]
    [string] $CandidateProvenancePath,

    [Parameter(Mandatory = $true)]
    [string] $AttestationBundlePath,

    [Parameter(Mandatory = $true)]
    [string] $SourceArchivePath,

    [Parameter(Mandatory = $true)]
    [string] $ArtifactDirectory,

    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string] $ExpectedSshCidr,

    [Parameter()]
    [switch] $ContractFixture,

    [Parameter()]
    [string] $FixturePromotionEvidencePath,

    [Parameter()]
    [string] $FixturePostflightEvidencePath,

    [Parameter()]
    [string] $FixtureOutputPath,

    [Parameter()]
    [ValidateSet(0, 20, 21)]
    [int] $FixturePostflightExitCode = 0
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
$PinnedGhPath = "C:\Program Files\GitHub CLI\gh.exe"
$PinnedGhSha256 = "fdc88cd790510c1367ebd87f57de4d929b409d3483b6f8c6916653fc77d6621a"
$MaximumEvidenceBytes = 65536
$MaximumDiagnosticBytes = 32768
$MinimumPreflightLifetimeSeconds = 720
$TransportTimeoutSeconds = 1800
$RunningOnWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

function Throw-SafeError {
    param([Parameter(Mandatory = $true)][ValidatePattern("^[A-Z][A-Z0-9_]{0,63}$")][string] $Code)
    throw [InvalidOperationException]::new("REFUNDDESK_$Code")
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][byte[]] $Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

function Get-StreamSha256 {
    param([Parameter(Mandatory = $true)][IO.Stream] $Stream)
    $position = $Stream.Position
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $Stream.Position = 0
        return ([BitConverter]::ToString($algorithm.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $Stream.Position = $position
        $algorithm.Dispose()
    }
}

function Get-RandomNonce {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) }
    finally { $generator.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function Assert-NoReparsePath {
    param([string] $Path, [string] $FailureCode)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        $root = [IO.Path]::GetPathRoot($full)
        $relative = $full.Substring($root.Length)
        $current = $root
        foreach ($component in $relative.Split(@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar), [StringSplitOptions]::RemoveEmptyEntries)) {
            $current = Join-Path $current $component
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Throw-SafeError $FailureCode }
        }
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
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

function Get-CanonicalFile {
    param([string] $Path, [string] $FailureCode)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        Assert-NoReparsePath $full $FailureCode
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Throw-SafeError $FailureCode
        }
        return $full
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Get-CanonicalDirectory {
    param([string] $Path, [string] $FailureCode)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        Assert-NoReparsePath $full $FailureCode
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Throw-SafeError $FailureCode
        }
        return $full
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Assert-RestrictedAcl {
    param([string] $Path, [string] $FailureCode)
    if (-not $RunningOnWindows) { return }
    try {
        $acl = Get-Acl -LiteralPath $Path
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $required = @($currentSid, "S-1-5-18", "S-1-5-32-544")
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $currentSid) { Throw-SafeError $FailureCode }
        if (-not $acl.AreAccessRulesProtected) { Throw-SafeError $FailureCode }
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        $expectedInheritance = if ($item.PSIsContainer) {
            [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        else { [Security.AccessControl.InheritanceFlags]::None }
        $rules = @($acl.Access)
        if ($rules.Count -ne 3) { Throw-SafeError $FailureCode }
        $observed = @()
        foreach ($rule in $rules) {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($rule.IsInherited -or
                $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                $rule.InheritanceFlags -ne $expectedInheritance -or
                $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
                $required -notcontains $sid -or $observed -contains $sid) { Throw-SafeError $FailureCode }
            $observed += $sid
        }
        foreach ($sid in $required) {
            if ($observed -notcontains $sid) { Throw-SafeError $FailureCode }
        }
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function New-RestrictedDirectory {
    param([string] $Path, [string] $FailureCode)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        $created = -not (Test-Path -LiteralPath $full)
        if ($created) { [void] [IO.Directory]::CreateDirectory($full) }
        $canonical = Get-CanonicalDirectory $full $FailureCode
        if ($created -and $RunningOnWindows) {
            $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $acl.SetAccessRuleProtection($true, $false)
            $acl.SetOwner($current)
            $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
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
            [IO.Directory]::SetAccessControl($canonical, $acl)
        }
        Assert-RestrictedAcl $canonical $FailureCode
        return $canonical
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Open-FileLock {
    param([string] $Path, [string] $FailureCode, [switch] $RequireRestrictedAcl)
    try {
        $canonical = Get-CanonicalFile $Path $FailureCode
        if ($RequireRestrictedAcl) { Assert-RestrictedAcl $canonical $FailureCode }
        $stream = [IO.FileStream]::new(
            $canonical,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read,
            1048576,
            [IO.FileOptions]::SequentialScan
        )
        if ($stream.Length -le 0) { $stream.Dispose(); Throw-SafeError $FailureCode }
        return [pscustomobject]@{
            Length = $stream.Length
            Path = $canonical
            RequireRestrictedAcl = [bool] $RequireRestrictedAcl
            Sha256 = Get-StreamSha256 $stream
            Stream = $stream
        }
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Open-InputLock {
    param([string] $Path, [string] $FailureCode)
    return Open-FileLock $Path $FailureCode -RequireRestrictedAcl
}

function Open-RestrictedCredentialLock {
    param([string] $Path, [string] $FailureCode)
    $stream = $null
    try {
        $canonical = Get-CanonicalFile $Path $FailureCode
        Assert-RestrictedAcl $canonical $FailureCode
        $item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
        if ($item.Length -le 0 -or $item.Length -gt 262144) { Throw-SafeError $FailureCode }
        # Hold the credential against replacement/writes while allowing the AWS
        # CLI to open it for reading. Its bytes are deliberately never read or
        # hashed by this wrapper.
        $stream = [IO.FileStream]::new($canonical, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1, [IO.FileOptions]::None)
        if ($stream.Length -ne $item.Length) { Throw-SafeError $FailureCode }
        return [pscustomobject]@{ Length = $stream.Length; Path = $canonical; Stream = $stream }
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Assert-RestrictedCredentialLockUnchanged {
    param($Lock, [string] $FailureCode)
    try {
        $canonical = Get-CanonicalFile $Lock.Path $FailureCode
        Assert-RestrictedAcl $canonical $FailureCode
        $item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop
        if ($canonical -cne $Lock.Path -or $item.Length -ne $Lock.Length -or $Lock.Stream.Length -ne $Lock.Length) {
            Throw-SafeError $FailureCode
        }
    }
    catch {
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Open-PinnedExecutableLock {
    param([string] $Path, [string] $ExpectedSha256, [string] $FailureCode)
    $lock = Open-FileLock $Path $FailureCode
    if ($lock.Sha256 -cne $ExpectedSha256) {
        $lock.Stream.Dispose()
        Throw-SafeError $FailureCode
    }
    return $lock
}

function Assert-ExactPropertyNames {
    param($Value, [string[]] $Expected, [string] $FailureCode)
    if ($null -eq $Value) { Throw-SafeError $FailureCode }
    $observed = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($observed -join "|") -cne ($wanted -join "|")) { Throw-SafeError $FailureCode }
}

function Read-BoundedJson {
    param([string] $Path, [int] $MaximumBytes, [string] $FailureCode)
    $lock = Open-InputLock $Path $FailureCode
    try {
        if ($lock.Length -gt $MaximumBytes) { Throw-SafeError $FailureCode }
        $bytes = New-Object byte[] ([int] $lock.Length)
        $lock.Stream.Position = 0
        if ($lock.Stream.Read($bytes, 0, $bytes.Length) -ne $bytes.Length) { Throw-SafeError $FailureCode }
        if ($bytes -contains 0 -or $bytes[0] -eq 239) { Throw-SafeError $FailureCode }
        try { $value = ([Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json) }
        catch { Throw-SafeError $FailureCode }
        return [pscustomobject]@{ Bytes = $bytes; Lock = $lock; Sha256 = $lock.Sha256; Value = $value }
    }
    catch {
        if ($null -ne $lock) { $lock.Stream.Dispose() }
        throw
    }
}

function Assert-CanonicalIpv4HostCidr {
    param([string] $Value)
    if ($Value -notmatch "^(?<address>(?:[0-9]{1,3}\.){3}[0-9]{1,3})/32$") { Throw-SafeError "SSH_CIDR_INVALID" }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($Matches.address, [ref] $address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        ("{0}/32" -f $address) -cne $Value) { Throw-SafeError "SSH_CIDR_INVALID" }
}

function New-CleanEnvironment {
    param([hashtable] $Additional = @{})
    $environment = @{
        SystemRoot = $env:SystemRoot
        WINDIR = $env:WINDIR
        PATH = "$env:SystemRoot\System32"
        LC_ALL = "C"
        TZ = "UTC"
    }
    foreach ($entry in $Additional.GetEnumerator()) { $environment[$entry.Key] = [string] $entry.Value }
    return $environment
}

function Stop-BoundedProcess {
    param([Diagnostics.Process] $Process)
    try { if (-not $Process.HasExited) { $Process.Kill() } } catch {}
    try { [void] $Process.WaitForExit(2000) } catch {}
}

function Invoke-BoundedProcess {
    param(
        [string] $Executable,
        [string[]] $Arguments,
        [hashtable] $Environment,
        [IO.Stream] $InputStream,
        [int] $TimeoutSeconds,
        [int] $MaximumStdoutBytes = 1048576
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
        if ($entry.Key -isnot [string] -or $entry.Value -isnot [string] -or
            $entry.Key -notmatch "^[A-Za-z_][A-Za-z0-9_]{0,63}$" -or $entry.Value.Contains([char] 0)) {
            Throw-SafeError "PROCESS_ENVIRONMENT_INVALID"
        }
        $start.EnvironmentVariables[$entry.Key] = $entry.Value
    }
    $start.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument ([string] $_) }) -join " ")
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $stdoutStream = [IO.MemoryStream]::new()
    $stderrStream = [IO.MemoryStream]::new()
    $stdoutBuffer = New-Object byte[] 8192
    $stderrBuffer = New-Object byte[] 4096
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) { Throw-SafeError "PROCESS_START_FAILED" }
        $stdoutTask = $process.StandardOutput.BaseStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
        $stderrTask = $process.StandardError.BaseStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
        $stdoutClosed = $false
        $stderrClosed = $false
        if ($null -ne $InputStream) {
            $InputStream.Position = 0
            $stdinTask = $InputStream.CopyToAsync($process.StandardInput.BaseStream, 1048576)
            $stdinClosed = $false
        }
        else {
            $process.StandardInput.Close()
            $stdinTask = $null
            $stdinClosed = $true
        }

        while (-not ($process.HasExited -and $stdoutClosed -and $stderrClosed -and $stdinClosed)) {
            if ($stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                Stop-BoundedProcess $process
                Throw-SafeError "PROCESS_TIMEOUT"
            }
            if (-not $stdinClosed -and $stdinTask.IsCompleted) {
                if ($stdinTask.IsFaulted -or $stdinTask.IsCanceled) {
                    Stop-BoundedProcess $process
                    Throw-SafeError "PROCESS_STDIN_FAILED"
                }
                $process.StandardInput.BaseStream.Flush()
                $process.StandardInput.Close()
                $stdinClosed = $true
            }
            if (-not $stdoutClosed -and $stdoutTask.IsCompleted) {
                if ($stdoutTask.IsFaulted -or $stdoutTask.IsCanceled) {
                    Stop-BoundedProcess $process
                    Throw-SafeError "PROCESS_STDOUT_FAILED"
                }
                $count = $stdoutTask.Result
                if ($count -eq 0) { $stdoutClosed = $true }
                else {
                    if (($stdoutStream.Length + $count) -gt $MaximumStdoutBytes) {
                        Stop-BoundedProcess $process
                        Throw-SafeError "PROCESS_OUTPUT_BOUNDS"
                    }
                    $stdoutStream.Write($stdoutBuffer, 0, $count)
                    $stdoutTask = $process.StandardOutput.BaseStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
                }
            }
            if (-not $stderrClosed -and $stderrTask.IsCompleted) {
                if ($stderrTask.IsFaulted -or $stderrTask.IsCanceled) {
                    Stop-BoundedProcess $process
                    Throw-SafeError "PROCESS_STDERR_FAILED"
                }
                $count = $stderrTask.Result
                if ($count -eq 0) { $stderrClosed = $true }
                else {
                    if (($stderrStream.Length + $count) -gt $MaximumDiagnosticBytes) {
                        Stop-BoundedProcess $process
                        Throw-SafeError "PROCESS_OUTPUT_BOUNDS"
                    }
                    $stderrStream.Write($stderrBuffer, 0, $count)
                    $stderrTask = $process.StandardError.BaseStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
                }
            }
            [Threading.Thread]::Sleep(10)
        }
        [void] $process.WaitForExit(2000)
        return ,([pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdoutStream.ToArray()
            Stderr = [Text.UTF8Encoding]::new($false, $false).GetString($stderrStream.ToArray())
        })
    }
    catch {
        Stop-BoundedProcess $process
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError "PROCESS_INTERNAL_ERROR"
    }
    finally {
        $stopwatch.Stop()
        $stdoutStream.Dispose()
        $stderrStream.Dispose()
        $process.Dispose()
    }
}

function Write-EvidenceCreateNew {
    param([string] $Path, [byte[]] $Bytes)
    $stream = $null
    $created = $false
    try {
        $stream = [IO.FileStream]::new(
            $Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None,
            4096, [IO.FileOptions]::WriteThrough
        )
        $created = $true
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose(); $stream = $null }
        if ($created) { try { [IO.File]::Delete($Path) } catch {} }
        Throw-SafeError "EVIDENCE_CREATE_NEW_FAILED"
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    try {
        if ($RunningOnWindows) {
            $acl = [Security.AccessControl.FileSecurity]::new()
            $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl.SetAccessRuleProtection($true, $false)
            $acl.SetOwner($current)
            foreach ($sid in @(
                $current,
                [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
                [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
            )) {
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                    $sid,
                    [Security.AccessControl.FileSystemRights]::FullControl,
                    [Security.AccessControl.AccessControlType]::Allow
                ))
            }
            [IO.File]::SetAccessControl($Path, $acl)
            Assert-RestrictedAcl $Path "EVIDENCE_ACL_INVALID"
        }
    }
    catch {
        try { [IO.File]::Delete($Path) } catch {}
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError "EVIDENCE_ACL_INVALID"
    }
}

function Replace-EvidenceAtomically {
    param([string] $Path, [byte[]] $Bytes, [string] $FailureCode)
    $directory = Get-CanonicalDirectory ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))) $FailureCode
    $replacementNonce = (Get-RandomNonce).Substring(0, 16)
    $temporary = Join-Path $directory (".attempt-replace-{0}.tmp" -f $replacementNonce)
    $backup = Join-Path $directory (".attempt-previous-{0}.tmp" -f $replacementNonce)
    try {
        Write-EvidenceCreateNew $temporary $Bytes
        [IO.File]::Replace($temporary, $Path, $backup)
        Assert-RestrictedAcl $Path $FailureCode
        if (Test-Path -LiteralPath $backup) { [IO.File]::Delete($backup) }
    }
    catch {
        if (Test-Path -LiteralPath $temporary) {
            try { [IO.File]::Delete($temporary) } catch {}
        }
        if ($ContractFixture) {
            [Console]::Error.WriteLine(("contained-promotion-fixture-marker:{0}:{1}" -f $_.Exception.GetType().Name, ($_.Exception.Message -replace "[\r\n]", " ")))
        }
        if ($_.Exception.Message -match "^REFUNDDESK_") { throw }
        Throw-SafeError $FailureCode
    }
}

function Open-ExactEvidenceOrCreate {
    param([string] $Path, [byte[]] $Bytes, [int] $MaximumBytes, [string] $FailureCode)
    if (-not (Test-Path -LiteralPath $Path)) { Write-EvidenceCreateNew $Path $Bytes }
    $document = Read-BoundedJson $Path $MaximumBytes $FailureCode
    if ($document.Bytes.Length -ne $Bytes.Length) {
        $document.Lock.Stream.Dispose()
        Throw-SafeError $FailureCode
    }
    for ($index = 0; $index -lt $Bytes.Length; $index++) {
        if ($document.Bytes[$index] -ne $Bytes[$index]) {
            $document.Lock.Stream.Dispose()
            Throw-SafeError $FailureCode
        }
    }
    return $document
}

function Assert-Preflight {
    param($Document)
    $now = [DateTime]::UtcNow
    try {
        $captured = [DateTime]::ParseExact($Document.capturedAt, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
        $validUntil = [DateTime]::ParseExact($Document.validUntil, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
    }
    catch { Throw-SafeError "PREFLIGHT_TIME_INVALID" }
    Assert-ContainedPostflightShape $Document
    if ($captured -gt $now.AddSeconds(5) -or ($validUntil - $now).TotalSeconds -lt $MinimumPreflightLifetimeSeconds -or
        ($validUntil - $captured).TotalSeconds -gt 901) { Throw-SafeError "PREFLIGHT_NOT_FRESH_ENOUGH" }
}

function Assert-ContainedPostflightShape {
    param($Document)
    $expectedAdmission = if ($ContractFixture) { "FIXTURE_ONLY" } else { "ADMISSIBLE_READ_ONLY" }
    if ($Document.kind -cne "refunddesk.lightsail.host-postflight.capture" -or
        $Document.result -cne "PASS" -or $Document.admission -cne $expectedAdmission -or
        $Document.posture -cne "COHERENT_CONTAINED" -or $Document.remote.code -cne "PASS_CONTAINED" -or
        -not $Document.remote.containment.liveDisabled -or -not $Document.remote.containment.workerStopped -or
        -not $Document.remote.containment.caddyStopped -or -not $Document.remote.containment.maintenanceStopped -or
        -not $Document.remote.containment.publicListenersClosed -or -not $Document.remote.financial.stable -or
        -not $Document.remote.financial.quiescent -or -not $Document.awsControlPlane.firewallClosedBefore -or
        -not $Document.awsControlPlane.firewallClosedAfter -or -not $Document.awsControlPlane.firewallUnchanged) {
        Throw-SafeError "PREFLIGHT_NOT_CONTAINED"
    }
}

function Assert-PostflightAfterPromotion {
    param($Postflight, $Promotion)
    Assert-Preflight $Postflight
    Assert-PostflightChronology $Postflight $Promotion
}

function Assert-PostflightChronology {
    param($Postflight, $Promotion)
    $postflightCaptured = [DateTime]::Parse($Postflight.capturedAt).ToUniversalTime()
    $promotionCompleted = [DateTime]::Parse($Promotion.completedAt).ToUniversalTime()
    if ($postflightCaptured -lt $promotionCompleted -or
        $Postflight.remote.captures.b.identity.activeRevision -cne $Promotion.revision) {
        Throw-SafeError "POSTFLIGHT_PRECEDES_PROMOTION"
    }
}

function Assert-LockedRepositoryState {
    param(
        [string] $Repository,
        [string] $ExpectedHead,
        [object[]] $Bindings,
        [string] $GitExecutable,
        [hashtable] $Environment
    )
    $before = Invoke-BoundedProcess $GitExecutable @("-C", $Repository, "rev-parse", "--verify", "HEAD") $Environment $null 30 256
    if ($before.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetString($before.Stdout).Trim() -cne $ExpectedHead) {
        Throw-SafeError "REPOSITORY_HEAD_CHANGED"
    }
    $status = Invoke-BoundedProcess $GitExecutable @("-C", $Repository, "status", "--porcelain=v1", "--untracked-files=no") $Environment $null 30 2097152
    if ($status.ExitCode -ne 0 -or $status.Stdout.Length -ne 0) { Throw-SafeError "REPOSITORY_STATE_CHANGED" }
    foreach ($binding in $Bindings) {
        if ($binding.Lock.Stream.Length -ne $binding.Length -or
            (Get-StreamSha256 $binding.Lock.Stream) -cne $binding.Sha256) { Throw-SafeError "SOURCE_WORKTREE_CHANGED" }
        $commitResult = Invoke-BoundedProcess $GitExecutable @("-C", $Repository, "rev-parse", "$ExpectedHead`:$($binding.RelativePath)") $Environment $null 30 256
        $indexResult = Invoke-BoundedProcess $GitExecutable @("-C", $Repository, "rev-parse", ":$($binding.RelativePath)") $Environment $null 30 256
        $commitObject = [Text.Encoding]::UTF8.GetString($commitResult.Stdout).Trim()
        $indexObject = [Text.Encoding]::UTF8.GetString($indexResult.Stdout).Trim()
        if ($commitResult.ExitCode -ne 0 -or $indexResult.ExitCode -ne 0 -or
            $commitObject -cne $binding.CommitObject -or $indexObject -cne $binding.CommitObject) {
            Throw-SafeError "SOURCE_INDEX_OR_COMMIT_CHANGED"
        }
        $blob = Invoke-BoundedProcess $GitExecutable @("-C", $Repository, "cat-file", "blob", $commitObject) $Environment $null 30 2097152
        if ($blob.ExitCode -ne 0 -or $blob.Stdout.Length -ne $binding.Length -or
            (Get-Sha256Hex $blob.Stdout) -cne $binding.Sha256) { Throw-SafeError "SOURCE_COMMIT_CHANGED" }
    }
    $after = Invoke-BoundedProcess $GitExecutable @("-C", $Repository, "rev-parse", "--verify", "HEAD") $Environment $null 30 256
    if ($after.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetString($after.Stdout).Trim() -cne $ExpectedHead) {
        Throw-SafeError "REPOSITORY_HEAD_CHANGED"
    }
}

function Assert-LocksUnchanged {
    param([object[]] $FileLocks, [string] $FailureCode)
    foreach ($fileLock in $FileLocks) {
        $canonical = Get-CanonicalFile $fileLock.Path $FailureCode
        if ($canonical -cne $fileLock.Path) { Throw-SafeError $FailureCode }
        if ($fileLock.RequireRestrictedAcl) { Assert-RestrictedAcl $canonical $FailureCode }
        if ($fileLock.Stream.Length -ne $fileLock.Length -or (Get-StreamSha256 $fileLock.Stream) -cne $fileLock.Sha256) {
            Throw-SafeError $FailureCode
        }
    }
}

function Assert-CanonicalPowerShellJson {
    param($Document, [byte[]] $Bytes, [string] $FailureCode)
    $expected = [Text.UTF8Encoding]::new($false).GetBytes((($Document | ConvertTo-Json -Compress -Depth 100) + "`n"))
    if ($expected.Length -ne $Bytes.Length) { Throw-SafeError $FailureCode }
    for ($index = 0; $index -lt $Bytes.Length; $index++) {
        if ($expected[$index] -ne $Bytes[$index]) { Throw-SafeError $FailureCode }
    }
}

function Get-SourceBinding {
    param([object[]] $Bindings, [string] $RelativePath)
    $matches = @($Bindings | Where-Object { $_.RelativePath -ceq $RelativePath })
    if ($matches.Count -ne 1) { Throw-SafeError "POSTFLIGHT_SOURCE_BINDING_INVALID" }
    return $matches[0]
}

function Assert-PostflightCaptureStrict {
    param($Capture, [byte[]] $Bytes, [string] $ExpectedHead, [object[]] $Bindings)
    Assert-CanonicalPowerShellJson $Capture $Bytes "POSTFLIGHT_CAPTURE_NOT_CANONICAL"
    Assert-ExactPropertyNames $Capture @(
        "admission", "awsControlPlane", "capturedAt", "kind", "posture", "provenance", "redaction",
        "remote", "result", "schemaVersion", "validUntil"
    ) "POSTFLIGHT_CAPTURE_INVALID"
    if ($Capture.schemaVersion -ne 1 -or $Capture.kind -cne "refunddesk.lightsail.host-postflight.capture" -or
        $Capture.admission -cne "ADMISSIBLE_READ_ONLY" -or $Capture.result -cne $Capture.remote.result -or
        $Capture.posture -cne $Capture.remote.posture -or @("PASS", "FAIL", "INCOMPLETE") -cnotcontains $Capture.result) {
        Throw-SafeError "POSTFLIGHT_CAPTURE_INVALID"
    }
    Assert-ExactPropertyNames $Capture.awsControlPlane @(
        "accountMatches", "firewallClosedAfter", "firewallClosedBefore", "firewallUnchanged",
        "instanceMatches", "instanceRunning", "regionMatches", "targetId"
    ) "POSTFLIGHT_AWS_ENVELOPE_INVALID"
    if ($Capture.awsControlPlane.targetId -cne "$ExpectedInstanceName@$ExpectedAwsRegion" -or
        -not $Capture.awsControlPlane.accountMatches -or -not $Capture.awsControlPlane.regionMatches -or
        -not $Capture.awsControlPlane.instanceMatches -or -not $Capture.awsControlPlane.instanceRunning -or
        -not $Capture.awsControlPlane.firewallClosedBefore -or -not $Capture.awsControlPlane.firewallClosedAfter -or
        -not $Capture.awsControlPlane.firewallUnchanged) { Throw-SafeError "POSTFLIGHT_AWS_ENVELOPE_INVALID" }
    Assert-ExactPropertyNames $Capture.provenance @(
        "fixtureOnly", "observer", "remoteDocumentSha256", "repositoryHead", "revisionComposeVerified",
        "schema", "transportInputsPinned", "validator", "wrapper"
    ) "POSTFLIGHT_PROVENANCE_INVALID"
    if ($Capture.provenance.fixtureOnly -ne $false -or $Capture.provenance.transportInputsPinned -ne $true -or
        $Capture.provenance.repositoryHead -cne $ExpectedHead -or
        $Capture.provenance.remoteDocumentSha256 -notmatch "^[0-9a-f]{64}$" -or
        ($Capture.result -ceq "PASS" -and $Capture.provenance.revisionComposeVerified -ne $true)) {
        Throw-SafeError "POSTFLIGHT_PROVENANCE_INVALID"
    }
    $sourcePaths = [ordered]@{
        observer = "deploy/lightsail/scripts/observe-host-postflight.sh"
        schema = "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json"
        validator = "scripts/validate-lightsail-postflight.mjs"
        wrapper = "scripts/invoke-lightsail-postflight.ps1"
    }
    foreach ($name in $sourcePaths.Keys) {
        $binding = Get-SourceBinding $Bindings $sourcePaths[$name]
        $observed = $Capture.provenance.$name
        Assert-ExactPropertyNames $observed @("gitObject", "sha256") "POSTFLIGHT_PROVENANCE_INVALID"
        if ($observed.gitObject -cne $binding.CommitObject -or $observed.sha256 -cne $binding.Sha256) {
            Throw-SafeError "POSTFLIGHT_PROVENANCE_INVALID"
        }
    }
    Assert-ExactPropertyNames $Capture.redaction @(
        "arbitraryPathPresent", "customerDataPresent", "ipAddressPresent", "keyDigestPresent",
        "rawApiKeyPresent", "rawPayloadPresent", "rawSecretPresent", "rawSignaturePresent", "stderrPresent"
    ) "POSTFLIGHT_REDACTION_INVALID"
    foreach ($property in $Capture.redaction.PSObject.Properties) {
        if ($property.Value -ne $false) { Throw-SafeError "POSTFLIGHT_REDACTION_INVALID" }
    }
    $expectedRemoteExit = if ($Capture.remote.result -ceq "PASS") { 0 } elseif ($Capture.remote.result -ceq "FAIL") { 20 } else { 21 }
    if ($Capture.remote.exitCode -ne $expectedRemoteExit -or $Capture.remote.nonce -notmatch "^[0-9a-f]{64}$") {
        Throw-SafeError "POSTFLIGHT_REMOTE_MAPPING_INVALID"
    }
}

function New-PostflightOutcomeBytes {
    param($Promotion, $Postflight)
    $result = if ($Postflight.result -ceq "FAIL") { "FAIL" } else { "INCOMPLETE" }
    $code = if ($result -ceq "FAIL") {
        "FAIL_POSTFLIGHT_REJECTED_CONTAINED_PROMOTION"
    }
    else { "INCOMPLETE_POSTFLIGHT_FOR_CONTAINED_PROMOTION" }
    $value = [ordered]@{
        code = $code
        completedAt = [string] $Postflight.remote.completedAt
        effects = [ordered]@{
            caddyStarted = $false
            commitReached = $true
            containmentReasserted = $true
            databaseMigrationAttempted = $true
            edgeChanged = $false
            financialEffectAttempted = $false
            publicServicesStarted = $false
            remotePromotionPassed = $true
            sourceInstalled = $true
            workerStarted = $false
        }
        fromRevision = [string] $Promotion.fromRevision
        inputs = [ordered]@{
            bundleSha256 = [string] $Promotion.inputs.bundleSha256
            manifestSha256 = [string] $Promotion.inputs.manifestSha256
            provenanceSha256 = [string] $Promotion.inputs.provenanceSha256
            sourceSha256 = [string] $Promotion.inputs.sourceSha256
        }
        kind = "refunddesk-contained-promotion"
        nonce = [string] $Promotion.nonce
        operationStartedAt = [string] $Promotion.operationStartedAt
        phase = "postflight"
        redaction = [ordered]@{
            customerDataPresent = $false
            rawApiKeyPresent = $false
            rawPayloadPresent = $false
            rawSecretPresent = $false
            rawSignaturePresent = $false
            stderrPresent = $false
        }
        result = $result
        revision = [string] $Promotion.revision
        schemaVersion = 1
        startedAt = [string] $Promotion.startedAt
    }
    return ,([Text.UTF8Encoding]::new($false).GetBytes((($value | ConvertTo-Json -Compress -Depth 20) + "`n")))
}

$locks = [Collections.Generic.List[object]]::new()
$mutex = $null
$credentialsLock = $null
try {
    Assert-CanonicalIpv4HostCidr $ExpectedSshCidr
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    $preflight = Read-BoundedJson $PreflightEvidencePath 2097152 "PREFLIGHT_INVALID"
    $locks.Add($preflight.Lock)
    Assert-Preflight $preflight.Value
    $provenance = Read-BoundedJson $CandidateProvenancePath $MaximumEvidenceBytes "PROVENANCE_INVALID"
    $locks.Add($provenance.Lock)
    $attestationBundle = Open-InputLock $AttestationBundlePath "ATTESTATION_BUNDLE_INVALID"
    $locks.Add($attestationBundle)
    if ($attestationBundle.Length -gt 16777216) { Throw-SafeError "ATTESTATION_BUNDLE_INVALID" }
    $source = Open-InputLock $SourceArchivePath "SOURCE_ARCHIVE_INVALID"
    $locks.Add($source)
    $artifactRoot = Get-CanonicalDirectory $ArtifactDirectory "ARTIFACT_DIRECTORY_INVALID"

    $gitExecutable = if ($ContractFixture) { (Get-Command git).Source } else { $PinnedGitPath }
    $nodeExecutable = if ($ContractFixture) { (Get-Command node).Source } else { $PinnedNodePath }
    if (-not $ContractFixture) {
        foreach ($pair in @(@($gitExecutable, $PinnedGitSha256), @($nodeExecutable, $PinnedNodeSha256))) {
            $toolLock = Open-PinnedExecutableLock $pair[0] $pair[1] "PINNED_EXECUTABLE_INVALID"
            $locks.Add($toolLock)
        }
    }
    $clean = New-CleanEnvironment @{
        GIT_CONFIG_GLOBAL = "NUL"
        GIT_CONFIG_NOSYSTEM = "1"
        GIT_OPTIONAL_LOCKS = "0"
    }
    $headResult = Invoke-BoundedProcess $gitExecutable @("-C", $repository, "rev-parse", "HEAD") $clean $null 30
    $head = [Text.Encoding]::UTF8.GetString($headResult.Stdout).Trim()
    if ($headResult.ExitCode -ne 0 -or $head -notmatch "^[0-9a-f]{40}$") { Throw-SafeError "HEAD_INVALID" }
    $sourceBindings = [Collections.Generic.List[object]]::new()
    if (-not $ContractFixture) {
        $symbolicResult = Invoke-BoundedProcess $gitExecutable @("-C", $repository, "symbolic-ref", "--quiet", "HEAD") $clean $null 30
        $symbolicHead = [Text.Encoding]::UTF8.GetString($symbolicResult.Stdout).Trim()
        if ($symbolicResult.ExitCode -ne 0 -or $symbolicHead -notmatch "^refs/heads/[A-Za-z0-9._/-]+$") {
            Throw-SafeError "GIT_SYMBOLIC_HEAD_INVALID"
        }
        foreach ($gitControlPath in @(
            (Join-Path $repository ".git/HEAD"),
            (Join-Path $repository ".git/index"),
            (Join-Path (Join-Path $repository ".git") $symbolicHead),
            (Join-Path $repository ".git/refs/heads/main")
        )) {
            $gitControlLock = Open-FileLock $gitControlPath "GIT_CONTROL_LOCK_INVALID"
            $locks.Add($gitControlLock)
        }
        $lockedHeadResult = Invoke-BoundedProcess $gitExecutable @("-C", $repository, "rev-parse", "--verify", "HEAD") $clean $null 30
        if ($lockedHeadResult.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetString($lockedHeadResult.Stdout).Trim() -cne $head) {
            Throw-SafeError "HEAD_CHANGED_BEFORE_LOCK"
        }
        $status = Invoke-BoundedProcess $gitExecutable @("-C", $repository, "status", "--porcelain=v1", "--untracked-files=no") $clean $null 30
        if ($status.ExitCode -ne 0 -or $status.Stdout.Length -ne 0) { Throw-SafeError "WORKTREE_NOT_CLEAN" }
        foreach ($arguments in @(@("diff", "--quiet", "HEAD", "--"), @("diff", "--cached", "--quiet", "HEAD", "--"))) {
            $result = Invoke-BoundedProcess $gitExecutable (@("-C", $repository) + $arguments) $clean $null 30
            if ($result.ExitCode -ne 0) { Throw-SafeError "INDEX_NOT_HEAD" }
        }
    }

    Assert-ExactPropertyNames $provenance.Value @(
        "artifactId", "attestationBundleSha256", "attestationId", "bundleEvent", "bundleRunId",
        "bundleSha256", "bundleWorkflowPath", "ciEvent", "ciRunId", "ciWorkflowPath", "kind",
        "manifestSha256", "rekorEntryIndex", "repository", "revision", "schemaVersion",
        "sourceSha256", "verification", "verifiedAt"
    ) "PROVENANCE_BINDING_INVALID"
    if ($provenance.Value.kind -cne "refunddesk-contained-promotion-input-provenance" -or
        $provenance.Value.schemaVersion -ne 1 -or $provenance.Value.repository -cne "selimhehe1/RefundDesk" -or
        $provenance.Value.revision -cne $head -or $provenance.Value.sourceSha256 -cne $source.Sha256 -or
        $provenance.Value.attestationBundleSha256 -cne $attestationBundle.Sha256 -or
        $provenance.Value.verification -cne "github-cli-sigstore-and-actions-api-verified" -or
        $provenance.Value.ciWorkflowPath -cne ".github/workflows/ci.yml" -or
        $provenance.Value.bundleWorkflowPath -cne ".github/workflows/sandbox-images.yml" -or
        $provenance.Value.ciEvent -cne "push" -or $provenance.Value.bundleEvent -cne "workflow_dispatch" -or
        [long] $provenance.Value.artifactId -le 0 -or [long] $provenance.Value.attestationId -le 0 -or
        [long] $provenance.Value.bundleRunId -le 0 -or [long] $provenance.Value.ciRunId -le 0 -or
        [long] $provenance.Value.rekorEntryIndex -le 0 -or
        [string] $provenance.Value.verifiedAt -notmatch "^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") {
        Throw-SafeError "PROVENANCE_BINDING_INVALID"
    }
    if ([IO.Path]::GetFileName($source.Path) -cne "refunddesk-source-$head.tar.zst") { Throw-SafeError "SOURCE_ARCHIVE_NAME_INVALID" }
    $bundleName = "refunddesk-sandbox-$head.images.tar.zst"
    $manifestName = "refunddesk-sandbox-$head.manifest.json"
    $sourceName = [IO.Path]::GetFileName($source.Path)
    $sourceChecksumName = "$sourceName.sha256"
    if ([IO.Path]::GetDirectoryName($source.Path) -cne $artifactRoot) { Throw-SafeError "SOURCE_NOT_IN_ARTIFACT_SET" }
    $artifactFiles = @(Get-ChildItem -LiteralPath $artifactRoot -File -Force)
    $expectedArtifactNames = @($bundleName, "$bundleName.sha256", $manifestName, $sourceName, $sourceChecksumName) | Sort-Object
    if ($artifactFiles.Count -ne 5 -or
        (@($artifactFiles.Name | Sort-Object) -join "|") -cne ($expectedArtifactNames -join "|")) {
        Throw-SafeError "ARTIFACT_SET_INVALID"
    }
    $bundle = Open-InputLock (Join-Path $artifactRoot $bundleName) "BUNDLE_INVALID"; $locks.Add($bundle)
    $checksum = Open-InputLock (Join-Path $artifactRoot "$bundleName.sha256") "CHECKSUM_INVALID"; $locks.Add($checksum)
    $manifest = Read-BoundedJson (Join-Path $artifactRoot $manifestName) 262144 "MANIFEST_INVALID"; $locks.Add($manifest.Lock)
    $sourceChecksum = Open-InputLock (Join-Path $artifactRoot $sourceChecksumName) "SOURCE_CHECKSUM_INVALID"; $locks.Add($sourceChecksum)
    Assert-ExactPropertyNames $manifest.Value @("bundle", "createdAt", "images", "platform", "revision", "schemaVersion", "source") "MANIFEST_INVALID"
    Assert-ExactPropertyNames $manifest.Value.bundle @("file", "sha256") "MANIFEST_INVALID"
    if ($manifest.Value.revision -cne $head -or $manifest.Value.schemaVersion -ne 1 -or
        $manifest.Value.platform -cne "linux/amd64" -or
        $manifest.Value.source -cne "https://github.com/selimhehe1/RefundDesk" -or
        $manifest.Value.bundle.file -cne $bundleName -or
        $manifest.Value.bundle.sha256 -cne $bundle.Sha256 -or $provenance.Value.bundleSha256 -cne $bundle.Sha256 -or
        $provenance.Value.manifestSha256 -cne $manifest.Sha256) { Throw-SafeError "ARTIFACT_PROVENANCE_MISMATCH" }
    $manifestImages = @($manifest.Value.images)
    if ($manifestImages.Count -ne 3) { Throw-SafeError "MANIFEST_INVALID" }
    $observedRoles = [Collections.Generic.List[string]]::new()
    foreach ($image in $manifestImages) {
        Assert-ExactPropertyNames $image @("expectedUser", "imageId", "reference", "role") "MANIFEST_INVALID"
        $observedRoles.Add([string] $image.role)
        if ($image.role -notmatch "^(web|worker|migrate)$" -or $image.expectedUser -cne "node" -or
            $image.imageId -notmatch "^sha256:[0-9a-f]{64}$" -or
            $image.reference -cne ("refunddesk-{0}:sandbox-{1}" -f $image.role, $head)) {
            Throw-SafeError "MANIFEST_INVALID"
        }
    }
    if ((@($observedRoles | Sort-Object) -join "|") -cne "migrate|web|worker") { Throw-SafeError "MANIFEST_INVALID" }
    $checksumText = [Text.UTF8Encoding]::new($false, $true).GetString((New-Object byte[] ([int] $checksum.Length)))
    $checksum.Stream.Position = 0
    $checksumBytes = New-Object byte[] ([int] $checksum.Length)
    [void] $checksum.Stream.Read($checksumBytes, 0, $checksumBytes.Length)
    $checksumText = [Text.UTF8Encoding]::new($false, $true).GetString($checksumBytes)
    if ($checksumText -cne "$($bundle.Sha256)  $bundleName`n") { Throw-SafeError "CHECKSUM_CONTRACT_INVALID" }
    $sourceChecksumBytes = New-Object byte[] ([int] $sourceChecksum.Length)
    $sourceChecksum.Stream.Position = 0
    [void] $sourceChecksum.Stream.Read($sourceChecksumBytes, 0, $sourceChecksumBytes.Length)
    if ([Text.UTF8Encoding]::new($false, $true).GetString($sourceChecksumBytes) -cne "$($source.Sha256)  $sourceName`n") {
        Throw-SafeError "SOURCE_CHECKSUM_CONTRACT_INVALID"
    }

    $pinnedSources = @(
        "deploy/lightsail/scripts/promote-contained-candidate.sh",
        "deploy/lightsail/scripts/verify-deployment-local.sh",
        "deploy/lightsail/scripts/test-caddy-origin-contract.sh",
        "deploy/lightsail/scripts/install-source.sh",
        "deploy/lightsail/scripts/_common.sh",
        "deploy/lightsail/scripts/observe-host-postflight.sh",
        "docs/schemas/refunddesk-lightsail-contained-promotion-v1.schema.json",
        "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json",
        "scripts/validate-lightsail-contained-promotion.mjs",
        "scripts/validate-lightsail-postflight.mjs",
        "scripts/invoke-lightsail-contained-promotion.ps1",
        "scripts/invoke-lightsail-postflight.ps1",
        "docs/adr/0034-exact-e4-independent-review-and-read-only-host-postflight.md",
        "docs/adr/0037-bounded-cloudfront-origin-window.md"
    )
    if (-not $ContractFixture) {
        foreach ($relative in $pinnedSources) {
            $worktree = Open-FileLock (Join-Path $repository $relative) "PINNED_SOURCE_INVALID"; $locks.Add($worktree)
            $commitObjectResult = Invoke-BoundedProcess $gitExecutable @("-C", $repository, "rev-parse", "$head`:$relative") $clean $null 30 256
            $indexObjectResult = Invoke-BoundedProcess $gitExecutable @("-C", $repository, "rev-parse", ":$relative") $clean $null 30 256
            $commitObject = [Text.Encoding]::UTF8.GetString($commitObjectResult.Stdout).Trim()
            $indexObject = [Text.Encoding]::UTF8.GetString($indexObjectResult.Stdout).Trim()
            if ($commitObjectResult.ExitCode -ne 0 -or $indexObjectResult.ExitCode -ne 0 -or
                $commitObject -notmatch "^[0-9a-f]{40}$" -or $indexObject -cne $commitObject) {
                Throw-SafeError "PINNED_SOURCE_NOT_HEAD"
            }
            $commitBytes = Invoke-BoundedProcess $gitExecutable @("-C", $repository, "cat-file", "blob", $commitObject) $clean $null 30 2097152
            if ($commitBytes.ExitCode -ne 0 -or $commitBytes.Stdout.Length -ne $worktree.Length -or
                (Get-Sha256Hex $commitBytes.Stdout) -cne $worktree.Sha256) { Throw-SafeError "PINNED_SOURCE_NOT_HEAD" }
            $sourceBindings.Add([pscustomobject]@{
                CommitObject = $commitObject
                Length = $worktree.Length
                Lock = $worktree
                RelativePath = $relative
                Sha256 = $worktree.Sha256
            })
        }
        Assert-PostflightCaptureStrict $preflight.Value $preflight.Bytes $head $sourceBindings.ToArray()
        $remotePreflightText = ($preflight.Value.remote | ConvertTo-Json -Compress -Depth 100) + "`n"
        $remotePreflightBytes = [Text.UTF8Encoding]::new($false).GetBytes($remotePreflightText)
        $remotePreflightStream = [IO.MemoryStream]::new($remotePreflightBytes, $false)
        try {
            $officialValidator = Invoke-BoundedProcess $nodeExecutable @(
                (Join-Path $repository "scripts/validate-lightsail-postflight.mjs"),
                "--expected-nonce", [string] $preflight.Value.remote.nonce,
                "--process-exit-code", [string] $preflight.Value.remote.exitCode,
                "--not-before", [string] $preflight.Value.remote.startedAt,
                "--not-after", [string] $preflight.Value.remote.completedAt,
                "--repository", $repository,
                "--git-executable", $gitExecutable,
                "--expected-git-sha256", $PinnedGitSha256
            ) $clean $remotePreflightStream 60 2097152
        }
        finally { $remotePreflightStream.Dispose() }
        if ($officialValidator.ExitCode -ne 0) { Throw-SafeError "PREFLIGHT_OFFICIAL_VALIDATION_FAILED" }
        try { $officialValidation = [Text.UTF8Encoding]::new($false, $true).GetString($officialValidator.Stdout) | ConvertFrom-Json }
        catch { Throw-SafeError "PREFLIGHT_OFFICIAL_VALIDATOR_OUTPUT_INVALID" }
        if ($officialValidation.result -cne "PASS" -or $officialValidation.posture -cne "COHERENT_CONTAINED") {
            Throw-SafeError "PREFLIGHT_OFFICIAL_VALIDATOR_RESULT_INVALID"
        }
        Assert-LockedRepositoryState $repository $head $sourceBindings.ToArray() $gitExecutable $clean
        Assert-LocksUnchanged $locks.ToArray() "PINNED_INPUT_CHANGED"
        $ghLock = Open-PinnedExecutableLock $PinnedGhPath $PinnedGhSha256 "GH_EXECUTABLE_INVALID"
        $locks.Add($ghLock)
        $ghConfigDirectory = Get-CanonicalDirectory (Join-Path $env:APPDATA "GitHub CLI") "GH_CONFIG_INVALID"
        $ghHostsLock = Open-InputLock (Join-Path $ghConfigDirectory "hosts.yml") "GH_AUTH_INVALID"
        $locks.Add($ghHostsLock)
        $ghHome = New-RestrictedDirectory (Join-Path (Join-Path $repository "sandbox-evidence.local/aws") ".contained-promotion-gh-home") "GH_HOME_ACL_INVALID"
        $ghEnvironment = New-CleanEnvironment @{ HOME = $ghHome; USERPROFILE = $ghHome; GH_CONFIG_DIR = $ghConfigDirectory; GH_PAGER = "cat"; NO_COLOR = "1" }
        foreach ($subject in @($source, $bundle)) {
            $verification = Invoke-BoundedProcess $PinnedGhPath @(
                "attestation", "verify", $subject.Path,
                "--bundle", $attestationBundle.Path,
                "--repo", "selimhehe1/RefundDesk",
                "--signer-workflow", "selimhehe1/RefundDesk/.github/workflows/sandbox-images.yml",
                "--source-digest", $head,
                "--deny-self-hosted-runners",
                "--predicate-type", "https://slsa.dev/provenance/v1",
                "--format", "json"
            ) $ghEnvironment $null 120 2097152
            if ($verification.ExitCode -ne 0 -or $verification.Stdout.Length -eq 0) {
                Throw-SafeError "ATTESTATION_VERIFICATION_FAILED"
            }
        }
        foreach ($runContract in @(
            @([long] $provenance.Value.ciRunId, ".github/workflows/ci.yml", "push"),
            @([long] $provenance.Value.bundleRunId, ".github/workflows/sandbox-images.yml", "workflow_dispatch")
        )) {
            if ($runContract[0] -le 0) { Throw-SafeError "GITHUB_RUN_ID_INVALID" }
            $runResult = Invoke-BoundedProcess $PinnedGhPath @(
                "api", "--method", "GET",
                ("repos/selimhehe1/RefundDesk/actions/runs/{0}" -f $runContract[0])
            ) $ghEnvironment $null 60 1048576
            if ($runResult.ExitCode -ne 0) { Throw-SafeError "GITHUB_RUN_LOOKUP_FAILED" }
            try { $run = [Text.UTF8Encoding]::new($false, $true).GetString($runResult.Stdout) | ConvertFrom-Json }
            catch { Throw-SafeError "GITHUB_RUN_RESPONSE_INVALID" }
            if ([long] $run.id -ne $runContract[0] -or $run.head_sha -cne $head -or
                $run.status -cne "completed" -or $run.conclusion -cne "success" -or
                $run.path -cne $runContract[1] -or $run.event -cne $runContract[2]) {
                Throw-SafeError "GITHUB_RUN_CONTRACT_INVALID"
            }
        }
        Assert-LockedRepositoryState $repository $head $sourceBindings.ToArray() $gitExecutable $clean
        Assert-LocksUnchanged $locks.ToArray() "PINNED_INPUT_CHANGED"
    }

    if ($ContractFixture) {
        if ($env:REFUNDDESK_CONTAINED_PROMOTION_CONTRACT_MODE -cne "1") { Throw-SafeError "FIXTURE_MODE_NOT_ADMITTED" }
        $promotion = Read-BoundedJson $FixturePromotionEvidencePath $MaximumEvidenceBytes "FIXTURE_PROMOTION_INVALID"
        $locks.Add($promotion.Lock)
        $postflight = Read-BoundedJson $FixturePostflightEvidencePath 2097152 "FIXTURE_POSTFLIGHT_INVALID"
        $locks.Add($postflight.Lock)
        $outputPath = [IO.Path]::GetFullPath($FixtureOutputPath)
        if ([string] $promotion.Value.nonce -notmatch "^[0-9a-f]{64}$") { Throw-SafeError "FIXTURE_PROMOTION_INVALID" }
        $fixtureExpectedPostflightResult = if ($FixturePostflightExitCode -eq 0) { "PASS" } elseif ($FixturePostflightExitCode -eq 20) { "FAIL" } else { "INCOMPLETE" }
        if ($postflight.Value.result -cne $fixtureExpectedPostflightResult -or
            $postflight.Value.remote.result -cne $fixtureExpectedPostflightResult -or
            $postflight.Value.remote.exitCode -ne $FixturePostflightExitCode) {
            Throw-SafeError "FIXTURE_POSTFLIGHT_MAPPING_INVALID"
        }
    }

    $mutexName = "Local\RefundDeskContainedPromotion"
    $created = $false
    $mutex = [Threading.Mutex]::new($false, $mutexName, [ref] $created)
    if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(30))) { Throw-SafeError "TRANSPORT_LOCK_UNAVAILABLE" }
    $attemptDirectory = if ($ContractFixture) {
        Get-CanonicalDirectory ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($FixtureOutputPath))) "FIXTURE_OUTPUT_DIRECTORY_INVALID"
    }
    else {
        Get-CanonicalDirectory (Join-Path $repository "sandbox-evidence.local/aws") "EVIDENCE_DIRECTORY_INVALID"
    }
    Assert-RestrictedAcl $attemptDirectory "EVIDENCE_DIRECTORY_ACL_INVALID"
    $attemptPath = Join-Path $attemptDirectory ("contained-promotion-attempt-{0}-{1}.local.json" -f $head, $provenance.Sha256.Substring(0, 12))
    $validatorPath = Join-Path $repository "scripts/validate-lightsail-contained-promotion.mjs"
    $attemptLock = $null
    if (Test-Path -LiteralPath $attemptPath) {
        $attempt = Read-BoundedJson $attemptPath $MaximumEvidenceBytes "ATTEMPT_MARKER_INVALID"
        $locks.Add($attempt.Lock)
        $attemptLock = $attempt.Lock
        Assert-CanonicalPowerShellJson $attempt.Value $attempt.Bytes "ATTEMPT_MARKER_INVALID"
        if ($attempt.Value.kind -cne "refunddesk-contained-promotion-attempt" -or $attempt.Value.schemaVersion -ne 1 -or
            $attempt.Value.revision -cne $head -or $attempt.Value.sourceSha256 -cne $source.Sha256 -or
            $attempt.Value.bundleSha256 -cne $bundle.Sha256 -or $attempt.Value.manifestSha256 -cne $manifest.Sha256 -or
            $attempt.Value.provenanceSha256 -cne $provenance.Sha256 -or
            $attempt.Value.attestationBundleSha256 -cne $attestationBundle.Sha256 -or
            $attempt.Value.nonce -notmatch "^[0-9a-f]{64}$") { Throw-SafeError "ATTEMPT_MARKER_MISMATCH" }
        $nonce = [string] $attempt.Value.nonce
        if ($attempt.Value.status -ceq "complete") {
            Assert-ExactPropertyNames $attempt.Value @(
                "attestationBundleSha256", "bundleSha256", "completedAt", "consumed", "evidenceFileName",
                "evidenceSha256", "kind", "manifestSha256", "nonce", "postflightCapturedAt",
                "postflightEvidenceFileName", "postflightEvidenceSha256", "provenanceSha256", "revision",
                "schemaVersion", "sourceSha256", "status"
            ) "ATTEMPT_MARKER_MISMATCH"
            if ($attempt.Value.consumed -ne $true -or $attempt.Value.completedAt -notmatch "^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" -or
                $attempt.Value.postflightCapturedAt -notmatch "^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" -or
                $attempt.Value.evidenceSha256 -notmatch "^[0-9a-f]{64}$" -or $attempt.Value.postflightEvidenceSha256 -notmatch "^[0-9a-f]{64}$") {
                Throw-SafeError "ATTEMPT_MARKER_MISMATCH"
            }
            foreach ($name in @([string] $attempt.Value.evidenceFileName, [string] $attempt.Value.postflightEvidenceFileName)) {
                if ($name -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$" -or [IO.Path]::GetFileName($name) -cne $name) {
                    Throw-SafeError "ATTEMPT_MARKER_MISMATCH"
                }
            }
            $expectedCompletedEvidenceName = if ($ContractFixture) {
                [IO.Path]::GetFileName([IO.Path]::GetFullPath($FixtureOutputPath))
            }
            else { "contained-promotion-$head-$($nonce.Substring(0, 12)).local.json" }
            if ($attempt.Value.evidenceFileName -cne $expectedCompletedEvidenceName -or
                (-not $ContractFixture -and $attempt.Value.postflightEvidenceFileName -notmatch "^host-postflight-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.local\.json$")) {
                Throw-SafeError "ATTEMPT_MARKER_MISMATCH"
            }
            $completedEvidencePath = Join-Path $attemptDirectory ([string] $attempt.Value.evidenceFileName)
            $completedPostflightPath = Join-Path $attemptDirectory ([string] $attempt.Value.postflightEvidenceFileName)
            if ($ContractFixture -and [IO.Path]::GetFullPath($FixtureOutputPath) -cne [IO.Path]::GetFullPath($completedEvidencePath)) {
                Throw-SafeError "ATTEMPT_MARKER_MISMATCH"
            }
            $completedEvidence = Read-BoundedJson $completedEvidencePath $MaximumEvidenceBytes "COMPLETED_EVIDENCE_INVALID"; $locks.Add($completedEvidence.Lock)
            $completedPostflight = Read-BoundedJson $completedPostflightPath 2097152 "COMPLETED_POSTFLIGHT_INVALID"; $locks.Add($completedPostflight.Lock)
            if ($completedEvidence.Sha256 -cne $attempt.Value.evidenceSha256 -or
                $completedPostflight.Sha256 -cne $attempt.Value.postflightEvidenceSha256 -or
                $completedEvidence.Value.completedAt -cne $attempt.Value.completedAt -or
                $completedPostflight.Value.capturedAt -cne $attempt.Value.postflightCapturedAt) {
                Throw-SafeError "COMPLETED_EVIDENCE_BINDING_INVALID"
            }
            $completedValidation = Invoke-BoundedProcess $nodeExecutable @(
                $validatorPath, "--evidence", $completedEvidence.Lock.Path, "--expected-revision", $head,
                "--expected-nonce", $nonce, "--expected-bundle-sha256", $bundle.Sha256,
                "--expected-manifest-sha256", $manifest.Sha256, "--expected-provenance-sha256", $provenance.Sha256,
                "--expected-source-sha256", $source.Sha256
            ) $clean $null 30
            if ($completedValidation.ExitCode -ne 0 -or $completedEvidence.Value.result -cne "PASS") {
                Throw-SafeError "COMPLETED_EVIDENCE_INVALID"
            }
            Assert-ContainedPostflightShape $completedPostflight.Value
            Assert-PostflightChronology $completedPostflight.Value $completedEvidence.Value
            if (-not $ContractFixture) {
                Assert-PostflightCaptureStrict $completedPostflight.Value $completedPostflight.Bytes $head $sourceBindings.ToArray()
                $completedRemoteText = ($completedPostflight.Value.remote | ConvertTo-Json -Compress -Depth 100) + "`n"
                $completedRemoteStream = [IO.MemoryStream]::new([Text.UTF8Encoding]::new($false).GetBytes($completedRemoteText), $false)
                try {
                    $completedOfficial = Invoke-BoundedProcess $nodeExecutable @(
                        (Join-Path $repository "scripts/validate-lightsail-postflight.mjs"),
                        "--expected-nonce", [string] $completedPostflight.Value.remote.nonce,
                        "--process-exit-code", "0", "--not-before", [string] $completedPostflight.Value.remote.startedAt,
                        "--not-after", [string] $completedPostflight.Value.remote.completedAt, "--repository", $repository,
                        "--git-executable", $gitExecutable, "--expected-git-sha256", $PinnedGitSha256
                    ) $clean $completedRemoteStream 60 2097152
                }
                finally { $completedRemoteStream.Dispose() }
                if ($completedOfficial.ExitCode -ne 0) { Throw-SafeError "COMPLETED_POSTFLIGHT_INVALID" }
            }
            [Console]::Out.WriteLine("CONTAINED_PROMOTION_ALREADY_COMPLETE_PASS")
            exit 0
        }
        Assert-ExactPropertyNames $attempt.Value @(
            "attestationBundleSha256", "bundleSha256", "kind", "manifestSha256", "nonce",
            "provenanceSha256", "revision", "schemaVersion", "sourceSha256", "status"
        ) "ATTEMPT_MARKER_MISMATCH"
        if ($attempt.Value.status -cne "in_progress" -or
            ($ContractFixture -and $attempt.Value.nonce -cne $promotion.Value.nonce)) { Throw-SafeError "ATTEMPT_MARKER_MISMATCH" }
    }
    else {
        $nonce = if ($ContractFixture) { [string] $promotion.Value.nonce } else { Get-RandomNonce }
        $attemptValue = [ordered]@{
            attestationBundleSha256 = $attestationBundle.Sha256
            bundleSha256 = $bundle.Sha256
            kind = "refunddesk-contained-promotion-attempt"
            manifestSha256 = $manifest.Sha256
            nonce = $nonce
            provenanceSha256 = $provenance.Sha256
            revision = $head
            schemaVersion = 1
            sourceSha256 = $source.Sha256
            status = "in_progress"
        }
        $attemptBytes = [Text.UTF8Encoding]::new($false).GetBytes((($attemptValue | ConvertTo-Json -Compress) + "`n"))
        Write-EvidenceCreateNew $attemptPath $attemptBytes
        $attemptLock = Open-InputLock $attemptPath "ATTEMPT_MARKER_INVALID"
        $locks.Add($attemptLock)
    }

    if (-not $ContractFixture) {
        $awsLock = Open-PinnedExecutableLock $PinnedAwsPath $PinnedAwsSha256 "TRANSPORT_EXECUTABLE_INVALID"; $locks.Add($awsLock)
        $sshLock = Open-PinnedExecutableLock $PinnedSshPath $PinnedSshSha256 "TRANSPORT_EXECUTABLE_INVALID"; $locks.Add($sshLock)
        $identityLock = Open-InputLock (Join-Path $repository "sandbox-evidence.local/aws/refunddesk-sandbox-lightsail-rsa") "IDENTITY_INVALID"; $locks.Add($identityLock)
        $knownHostsLock = Open-InputLock (Join-Path $repository "sandbox-evidence.local/aws/known_hosts.refunddesk-sandbox") "KNOWN_HOSTS_INVALID"; $locks.Add($knownHostsLock)
        if ($identityLock.Sha256 -cne $ExpectedIdentitySha256 -or $knownHostsLock.Sha256 -cne $ExpectedKnownHostsSha256) {
            Throw-SafeError "TRANSPORT_IDENTITY_INVALID"
        }
        $identityPath = $identityLock.Path
        $knownHostsPath = $knownHostsLock.Path
        $credentialsLock = Open-RestrictedCredentialLock (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".aws/credentials") "AWS_CREDENTIALS_INVALID"
        $credentials = $credentialsLock.Path
        $isolatedHome = New-RestrictedDirectory (Join-Path (Join-Path $repository "sandbox-evidence.local/aws") ".contained-promotion-home") "ISOLATED_HOME_ACL_INVALID"
        $awsEnvironment = New-CleanEnvironment @{ HOME = $isolatedHome; USERPROFILE = $isolatedHome; AWS_SHARED_CREDENTIALS_FILE = $credentials; AWS_EC2_METADATA_DISABLED = "true"; AWS_PAGER = "" }
        $identity = Invoke-BoundedProcess $PinnedAwsPath @("sts", "get-caller-identity", "--output", "json", "--region", $ExpectedAwsRegion) $awsEnvironment $null 30
        $instance = Invoke-BoundedProcess $PinnedAwsPath @("lightsail", "get-instance", "--instance-name", $ExpectedInstanceName, "--output", "json", "--region", $ExpectedAwsRegion) $awsEnvironment $null 30
        $ports = Invoke-BoundedProcess $PinnedAwsPath @("lightsail", "get-instance-port-states", "--instance-name", $ExpectedInstanceName, "--output", "json", "--region", $ExpectedAwsRegion) $awsEnvironment $null 30
        Assert-RestrictedCredentialLockUnchanged $credentialsLock "AWS_CREDENTIALS_CHANGED"
        if ($identity.ExitCode -ne 0 -or $instance.ExitCode -ne 0 -or $ports.ExitCode -ne 0) { Throw-SafeError "AWS_PREFLIGHT_FAILED" }
        $identityJson = [Text.Encoding]::UTF8.GetString($identity.Stdout) | ConvertFrom-Json
        $instanceJson = [Text.Encoding]::UTF8.GetString($instance.Stdout) | ConvertFrom-Json
        $portsJson = [Text.Encoding]::UTF8.GetString($ports.Stdout) | ConvertFrom-Json
        if ($identityJson.Account -cne $ExpectedAwsAccount -or $instanceJson.instance.name -cne $ExpectedInstanceName -or
            $instanceJson.instance.state.name -cne "running") { Throw-SafeError "AWS_TARGET_INVALID" }
        $openPorts = @($portsJson.portStates | Where-Object { $_.state -ceq "open" })
        $sshPort = @($openPorts | Where-Object {
            $_.fromPort -eq 22 -and $_.toPort -eq 22 -and $_.protocol -ceq "tcp" -and
            @($_.cidrs).Count -eq 1 -and $_.cidrs[0] -ceq $ExpectedSshCidr -and
            @($_.ipv6Cidrs).Count -eq 0 -and @($_.cidrListAliases).Count -eq 0
        })
        $overlappingPublicPorts = @($portsJson.portStates | Where-Object {
            $_.state -ceq "open" -and (
                ($_.fromPort -le 80 -and $_.toPort -ge 80) -or
                ($_.fromPort -le 443 -and $_.toPort -ge 443)
            )
        })
        if ($openPorts.Count -ne 1 -or $sshPort.Count -ne 1 -or $overlappingPublicPorts.Count -ne 0) {
            Throw-SafeError "AWS_FIREWALL_INVALID"
        }
        $sshEnvironment = New-CleanEnvironment @{ HOME = $isolatedHome; USERPROFILE = $isolatedHome }
        $sshBase = @("-F", "NUL", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=$knownHostsPath", "-o", "GlobalKnownHostsFile=NUL", "-o", "CheckHostIP=yes", "-o", "UpdateHostKeys=no", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no", "-o", "ConnectTimeout=15", "-i", $identityPath, "ubuntu@$($instanceJson.instance.publicIpAddress)")
        $remoteDirectory = "/var/lib/refunddesk/incoming/contained-$nonce"
        $createCommand = ('sudo --non-interactive -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /bin/bash --noprofile --norc -c ''if [[ ! -e "{0}" && ! -L "{0}" ]]; then /usr/bin/install -d -o root -g root -m 0700 "{0}"; else [[ -d "{0}" && ! -L "{0}" && "$(/usr/bin/stat --format=%u:%g:%a -- "{0}")" == 0:0:700 ]]; fi''' -f $remoteDirectory)
        $create = Invoke-BoundedProcess $PinnedSshPath ($sshBase + @($createCommand)) $sshEnvironment $null 90
        if ($create.ExitCode -ne 0) { Throw-SafeError "REMOTE_STAGE_CREATE_FAILED" }
        # The receiver always drains and hashes the complete input, including on
        # exact retry. It never truncates an existing path and rejects links,
        # metadata drift, byte drift, or a mismatched retried upload.
        $receiver = 'import hashlib,os,stat,sys;p=sys.argv[1];n=int(sys.argv[2]);h=sys.argv[3];exists=os.path.lexists(p);f=None if exists else os.fdopen(os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600),"wb");d=hashlib.sha256();c=0;exec("while True:\n b=sys.stdin.buffer.read(1048576)\n if not b: break\n c+=len(b);d.update(b)\n if f is not None: f.write(b)");incoming_ok=c==n and d.hexdigest()==h;exec("if f is not None:\n f.flush();os.fsync(f.fileno());f.close()\n if not incoming_ok: os.unlink(p);sys.exit(20)");exec("if exists:\n s=os.lstat(p)\n if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode)!=0o600 or s.st_uid!=0 or s.st_gid!=0 or s.st_size!=n or not incoming_ok: sys.exit(20)\n e=hashlib.sha256()\n with open(p,\"rb\") as g:\n  while True:\n   b=g.read(1048576)\n   if not b: break\n   e.update(b)\n if e.hexdigest()!=h: sys.exit(20)\n sys.exit(0)");q=os.open(os.path.dirname(p),os.O_RDONLY|os.O_DIRECTORY);os.fsync(q);os.close(q)'
        $uploads = @(
            @((Open-FileLock (Join-Path $repository "deploy/lightsail/scripts/install-source.sh") "INSTALL_SOURCE_INVALID"), "install-source.sh"),
            @((Open-FileLock (Join-Path $repository "deploy/lightsail/scripts/_common.sh") "COMMON_SOURCE_INVALID"), "_common.sh"),
            @($source, [IO.Path]::GetFileName($source.Path)), @($bundle, $bundleName), @($checksum, "$bundleName.sha256"),
            @($manifest.Lock, $manifestName), @($provenance.Lock, "candidate-provenance.json")
        )
        foreach ($upload in $uploads) {
            $item = $upload[0]; if (-not ($locks -contains $item)) { $locks.Add($item) }
            $remotePath = "$remoteDirectory/$($upload[1])"
            $command = "sudo --non-interactive -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /usr/bin/python3 -c '$receiver' '$remotePath' $($item.Length) $($item.Sha256)"
            $sent = Invoke-BoundedProcess $PinnedSshPath ($sshBase + @($command)) $sshEnvironment $item.Stream $TransportTimeoutSeconds
            if ($sent.ExitCode -ne 0) { Throw-SafeError "REMOTE_UPLOAD_FAILED" }
        }
        # Upload is transport-only. Re-admit the point-in-time preflight and the
        # exact locked HEAD immediately before the first host installation.
        Assert-Preflight $preflight.Value
        Assert-LockedRepositoryState $repository $head $sourceBindings.ToArray() $gitExecutable $clean
        Assert-LocksUnchanged $locks.ToArray() "PINNED_INPUT_CHANGED_DURING_TRANSPORT"
        # Installation and promotion are one remote transaction. FD 9 is
        # acquired once by the parent shell and inherited by both children, so
        # no release/recovery/maintenance process can enter between the source
        # switch and the contained runner. The deadline repeats the >=720 s
        # preflight lifetime gate immediately after the potentially long install.
        $validUntil = [DateTime]::ParseExact([string] $preflight.Value.validUntil, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
        $epoch = [DateTime]::SpecifyKind([DateTime]::new(1970, 1, 1), [DateTimeKind]::Utc)
        $runnerFreshThroughEpoch = [long] [Math]::Floor(($validUntil.AddSeconds(-$MinimumPreflightLifetimeSeconds) - $epoch).TotalSeconds)
        $installedRunner = "/opt/refunddesk/releases/$head/source/deploy/lightsail/scripts/promote-contained-candidate.sh"
        $transactionScript = "set -Eeuo pipefail; source `"$remoteDirectory/_common.sh`"; acquire_operator_lock; /bin/bash `"$remoteDirectory/install-source.sh`" --archive `"$remoteDirectory/$([IO.Path]::GetFileName($source.Path))`" --revision `"$head`" --expected-sha256 `"$($source.Sha256)`" --no-quiesce-recovery --operator-lock-inherited >/dev/null; [[ `"`$(/usr/bin/date --utc +%s)`" -le $runnerFreshThroughEpoch ]] || die `"preflight freshness expired during source installation`"; exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /bin/bash `"$installedRunner`" --artifact-dir `"$remoteDirectory`" --revision `"$head`" --expected-bundle-sha256 `"$($bundle.Sha256)`" --expected-manifest-sha256 `"$($manifest.Sha256)`" --expected-source-sha256 `"$($source.Sha256)`" --provenance-file `"$remoteDirectory/candidate-provenance.json`" --expected-provenance-sha256 `"$($provenance.Sha256)`" --nonce `"$nonce`" --operator-lock-inherited"
        $transactionCommand = "sudo --non-interactive -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /bin/bash --noprofile --norc -c '$transactionScript'"
        $promoted = Invoke-BoundedProcess $PinnedSshPath ($sshBase + @($transactionCommand)) $sshEnvironment $null $TransportTimeoutSeconds $MaximumEvidenceBytes
        if (@(0, 20, 21) -notcontains $promoted.ExitCode -or $promoted.Stdout.Length -eq 0) { Throw-SafeError "REMOTE_PROMOTION_FAILED" }
        $temporaryPromotion = Join-Path $isolatedHome ("promotion-{0}-exit-{1}.json" -f $nonce, $promoted.ExitCode)
        $promotion = Open-ExactEvidenceOrCreate $temporaryPromotion $promoted.Stdout $MaximumEvidenceBytes "REMOTE_PROMOTION_EVIDENCE_INVALID"
        $locks.Add($promotion.Lock)
    }

    $validatorArguments = @($validatorPath, "--evidence", $promotion.Lock.Path, "--expected-revision", $head,
        "--expected-nonce", $nonce, "--expected-bundle-sha256", $bundle.Sha256,
        "--expected-manifest-sha256", $manifest.Sha256, "--expected-provenance-sha256", $provenance.Sha256,
        "--expected-source-sha256", $source.Sha256)
    $validated = Invoke-BoundedProcess $nodeExecutable $validatorArguments $clean $null 30
    $expectedPromotionExit = if ($promotion.Value.result -ceq "PASS") { 0 } elseif ($promotion.Value.result -ceq "FAIL") { 20 } elseif ($promotion.Value.result -ceq "INCOMPLETE") { 21 } else { -1 }
    if ($expectedPromotionExit -lt 0 -or $validated.ExitCode -ne $expectedPromotionExit -or
        (-not $ContractFixture -and $promoted.ExitCode -ne $expectedPromotionExit)) {
        if ($ContractFixture) { [Console]::Error.WriteLine(("contained-promotion-fixture-validator:{0}" -f ($validated.Stderr -replace "[\r\n]", " "))) }
        Throw-SafeError "PROMOTION_VALIDATION_FAILED"
    }
    if ($ContractFixture -and $env:REFUNDDESK_CONTAINED_PROMOTION_FIXTURE_CRASH_AFTER -ceq "promotion_validated") {
        exit 99
    }
    if ($expectedPromotionExit -ne 0) {
        $outcomePath = Join-Path $attemptDirectory ("contained-promotion-outcome-{0}-{1}-{2}.local.json" -f $head, $nonce.Substring(0, 12), $promotion.Value.code)
        $capturedOutcome = Open-ExactEvidenceOrCreate $outcomePath $promotion.Bytes $MaximumEvidenceBytes "PROMOTION_OUTCOME_MISMATCH"
        $locks.Add($capturedOutcome.Lock)
        [Console]::Out.WriteLine(("CONTAINED_PROMOTION_{0}_{1}" -f $promotion.Value.result, $promotion.Value.code))
        exit $expectedPromotionExit
    }

    if (-not $ContractFixture) {
        $before = @(Get-ChildItem (Join-Path $repository "sandbox-evidence.local/aws") -Filter "host-postflight-*.local.json" | ForEach-Object FullName)
        $postflightWrapper = Join-Path $repository "scripts/invoke-lightsail-postflight.ps1"
        $powershellExecutable = (Get-Process -Id $PID).Path
        $postflightEnvironment = New-CleanEnvironment @{
            APPDATA = $env:APPDATA
            HOME = $isolatedHome
            LOCALAPPDATA = $env:LOCALAPPDATA
            PROGRAMDATA = $env:PROGRAMDATA
            USERPROFILE = [Environment]::GetFolderPath("UserProfile")
        }
        $postflightRun = Invoke-BoundedProcess $powershellExecutable @("-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $postflightWrapper, "-ExpectedSshCidr", $ExpectedSshCidr) $postflightEnvironment $null 300
        if (@(0, 20, 21) -notcontains $postflightRun.ExitCode) { Throw-SafeError "POSTFLIGHT_INVOCATION_FAILED" }
        $after = @(Get-ChildItem (Join-Path $repository "sandbox-evidence.local/aws") -Filter "host-postflight-*.local.json" | ForEach-Object FullName)
        $createdPostflight = @($after | Where-Object { $before -notcontains $_ })
        if ($createdPostflight.Count -ne 1) { Throw-SafeError "POSTFLIGHT_EVIDENCE_CARDINALITY" }
        $postflight = Read-BoundedJson $createdPostflight[0] 2097152 "POSTFLIGHT_INVALID"; $locks.Add($postflight.Lock)
        Assert-PostflightCaptureStrict $postflight.Value $postflight.Bytes $head $sourceBindings.ToArray()
        if ($postflight.Value.remote.nonce -ceq $preflight.Value.remote.nonce -or
            $postflight.Value.remote.nonce -ceq $nonce) { Throw-SafeError "POSTFLIGHT_NONCE_REPLAY" }
        $remotePostflightText = ($postflight.Value.remote | ConvertTo-Json -Compress -Depth 100) + "`n"
        $remotePostflightStream = [IO.MemoryStream]::new([Text.UTF8Encoding]::new($false).GetBytes($remotePostflightText), $false)
        try {
            $officialPostflight = Invoke-BoundedProcess $nodeExecutable @(
                (Join-Path $repository "scripts/validate-lightsail-postflight.mjs"),
                "--expected-nonce", [string] $postflight.Value.remote.nonce,
                "--process-exit-code", [string] $postflight.Value.remote.exitCode,
                "--not-before", [string] $postflight.Value.remote.startedAt,
                "--not-after", [string] $postflight.Value.remote.completedAt,
                "--repository", $repository,
                "--git-executable", $gitExecutable,
                "--expected-git-sha256", $PinnedGitSha256
            ) $clean $remotePostflightStream 60 2097152
        }
        finally { $remotePostflightStream.Dispose() }
        if ($officialPostflight.ExitCode -ne 0) { Throw-SafeError "POSTFLIGHT_OFFICIAL_VALIDATION_FAILED" }
        try { $officialPostflightValue = [Text.UTF8Encoding]::new($false, $true).GetString($officialPostflight.Stdout) | ConvertFrom-Json }
        catch { Throw-SafeError "POSTFLIGHT_OFFICIAL_VALIDATOR_OUTPUT_INVALID" }
        if ($officialPostflightValue.result -cne $postflight.Value.result -or
            $officialPostflightValue.posture -cne $postflight.Value.posture -or
            $postflightRun.ExitCode -ne $postflight.Value.remote.exitCode) {
            Throw-SafeError "POSTFLIGHT_RESULT_MAPPING_INVALID"
        }
        $outputPath = Join-Path $attemptDirectory ("contained-promotion-{0}-{1}.local.json" -f $head, $nonce.Substring(0, 12))
        Assert-LockedRepositoryState $repository $head $sourceBindings.ToArray() $gitExecutable $clean
        Assert-LocksUnchanged $locks.ToArray() "PINNED_INPUT_CHANGED_AFTER_POSTFLIGHT"
        Assert-RestrictedCredentialLockUnchanged $credentialsLock "AWS_CREDENTIALS_CHANGED"
        if ($postflightRun.ExitCode -ne 0) {
            $remotePassPath = Join-Path $attemptDirectory ("contained-promotion-remote-pass-{0}-{1}.local.json" -f $head, $nonce.Substring(0, 12))
            $capturedRemotePass = Open-ExactEvidenceOrCreate $remotePassPath $promotion.Bytes $MaximumEvidenceBytes "REMOTE_PASS_RECOVERY_MISMATCH"
            $locks.Add($capturedRemotePass.Lock)
            $postflightOutcomeBytes = New-PostflightOutcomeBytes $promotion.Value $postflight.Value
            $postflightOutcomePath = Join-Path $attemptDirectory ("contained-promotion-outcome-{0}-{1}-postflight.local.json" -f $head, $nonce.Substring(0, 12))
            $postflightOutcome = Open-ExactEvidenceOrCreate $postflightOutcomePath $postflightOutcomeBytes $MaximumEvidenceBytes "POSTFLIGHT_OUTCOME_MISMATCH"
            $locks.Add($postflightOutcome.Lock)
            $postflightOutcomeValidation = Invoke-BoundedProcess $nodeExecutable @(
                $validatorPath, "--evidence", $postflightOutcome.Lock.Path, "--expected-revision", $head,
                "--expected-nonce", $nonce, "--expected-bundle-sha256", $bundle.Sha256,
                "--expected-manifest-sha256", $manifest.Sha256, "--expected-provenance-sha256", $provenance.Sha256,
                "--expected-source-sha256", $source.Sha256
            ) $clean $null 30
            if ($postflightOutcomeValidation.ExitCode -ne $postflightRun.ExitCode) {
                Throw-SafeError "POSTFLIGHT_OUTCOME_VALIDATION_FAILED"
            }
            [Console]::Out.WriteLine(("CONTAINED_PROMOTION_{0}_{1}" -f $postflightOutcome.Value.result, $postflightOutcome.Value.code))
            exit $postflightRun.ExitCode
        }
    }
    elseif ($FixturePostflightExitCode -ne 0) {
        Assert-PostflightChronology $postflight.Value $promotion.Value
        $postflightOutcomeBytes = New-PostflightOutcomeBytes $promotion.Value $postflight.Value
        $postflightOutcomePath = Join-Path $attemptDirectory ("contained-promotion-outcome-{0}-{1}-postflight.local.json" -f $head, $nonce.Substring(0, 12))
        $postflightOutcome = Open-ExactEvidenceOrCreate $postflightOutcomePath $postflightOutcomeBytes $MaximumEvidenceBytes "POSTFLIGHT_OUTCOME_MISMATCH"
        $locks.Add($postflightOutcome.Lock)
        $postflightOutcomeValidation = Invoke-BoundedProcess $nodeExecutable @(
            $validatorPath, "--evidence", $postflightOutcome.Lock.Path, "--expected-revision", $head,
            "--expected-nonce", $nonce, "--expected-bundle-sha256", $bundle.Sha256,
            "--expected-manifest-sha256", $manifest.Sha256, "--expected-provenance-sha256", $provenance.Sha256,
            "--expected-source-sha256", $source.Sha256
        ) $clean $null 30
        if ($postflightOutcomeValidation.ExitCode -ne $FixturePostflightExitCode) {
            Throw-SafeError "POSTFLIGHT_OUTCOME_VALIDATION_FAILED"
        }
        [Console]::Out.WriteLine(("CONTAINED_PROMOTION_{0}_{1}" -f $postflightOutcome.Value.result, $postflightOutcome.Value.code))
        exit $FixturePostflightExitCode
    }
    Assert-PostflightAfterPromotion $postflight.Value $promotion.Value
    if ($ContractFixture -and $env:REFUNDDESK_CONTAINED_PROMOTION_FIXTURE_CRASH_AFTER -ceq "postflight_validated") {
        exit 99
    }
    if (-not $ContractFixture) {
        if ($remoteDirectory -notmatch "^/var/lib/refunddesk/incoming/contained-[0-9a-f]{64}$") {
            Throw-SafeError "REMOTE_CLEANUP_PATH_INVALID"
        }
        $cleanupCommand = "sudo --non-interactive -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /usr/bin/find '$remoteDirectory' -xdev -depth -delete"
        $cleaned = Invoke-BoundedProcess $PinnedSshPath ($sshBase + @($cleanupCommand)) $sshEnvironment $null 120
        if ($cleaned.ExitCode -ne 0) { Throw-SafeError "REMOTE_CLEANUP_FAILED" }
        Assert-LockedRepositoryState $repository $head $sourceBindings.ToArray() $gitExecutable $clean
        Assert-LocksUnchanged $locks.ToArray() "PINNED_INPUT_CHANGED_AFTER_CLEANUP"
        Assert-RestrictedCredentialLockUnchanged $credentialsLock "AWS_CREDENTIALS_CHANGED"
    }
    $capturedPromotion = Open-ExactEvidenceOrCreate $outputPath $promotion.Bytes $MaximumEvidenceBytes "PROMOTION_OUTPUT_MISMATCH"
    $locks.Add($capturedPromotion.Lock)
    $completeAttemptValue = [ordered]@{
        attestationBundleSha256 = $attestationBundle.Sha256
        bundleSha256 = $bundle.Sha256
        completedAt = [string] $promotion.Value.completedAt
        consumed = $true
        evidenceFileName = [IO.Path]::GetFileName($capturedPromotion.Lock.Path)
        evidenceSha256 = $capturedPromotion.Sha256
        kind = "refunddesk-contained-promotion-attempt"
        manifestSha256 = $manifest.Sha256
        nonce = $nonce
        postflightCapturedAt = [string] $postflight.Value.capturedAt
        postflightEvidenceFileName = [IO.Path]::GetFileName($postflight.Lock.Path)
        postflightEvidenceSha256 = $postflight.Sha256
        provenanceSha256 = $provenance.Sha256
        revision = $head
        schemaVersion = 1
        sourceSha256 = $source.Sha256
        status = "complete"
    }
    $completeAttemptBytes = [Text.UTF8Encoding]::new($false).GetBytes((($completeAttemptValue | ConvertTo-Json -Compress) + "`n"))
    if ($null -ne $attemptLock) { $attemptLock.Stream.Dispose() }
    Replace-EvidenceAtomically $attemptPath $completeAttemptBytes "ATTEMPT_MARKER_COMMIT_FAILED"
    $completeAttempt = Read-BoundedJson $attemptPath $MaximumEvidenceBytes "ATTEMPT_MARKER_COMMIT_FAILED"
    try {
        if ($completeAttempt.Bytes.Length -ne $completeAttemptBytes.Length -or $completeAttempt.Value.status -cne "complete") {
            Throw-SafeError "ATTEMPT_MARKER_COMMIT_FAILED"
        }
        for ($index = 0; $index -lt $completeAttemptBytes.Length; $index++) {
            if ($completeAttempt.Bytes[$index] -ne $completeAttemptBytes[$index]) { Throw-SafeError "ATTEMPT_MARKER_COMMIT_FAILED" }
        }
    }
    finally { $completeAttempt.Lock.Stream.Dispose() }
    [Console]::Out.WriteLine("CONTAINED_PROMOTION_COMPLETE_PASS")
    exit 0
}
catch {
    $code = "INTERNAL_ERROR"
    if ($_.Exception.Message -match "^REFUNDDESK_([A-Z][A-Z0-9_]{0,63})$") { $code = $Matches[1] }
    [Console]::Error.WriteLine("contained-promotion-error:{0}" -f $code)
    if ($ContractFixture -and $code -ceq "INTERNAL_ERROR") {
        [Console]::Error.WriteLine(("contained-promotion-fixture-diagnostic:{0}:{1}" -f $_.InvocationInfo.ScriptLineNumber, $_.Exception.GetType().Name))
        [Console]::Error.WriteLine(("contained-promotion-fixture-message:{0}" -f ($_.Exception.Message -replace "[\r\n]", " ")))
    }
    exit 1
}
finally {
    foreach ($lock in $locks) { if ($null -ne $lock.Stream) { $lock.Stream.Dispose() } }
    if ($null -ne $credentialsLock -and $null -ne $credentialsLock.Stream) { $credentialsLock.Stream.Dispose() }
    if ($null -ne $mutex) { try { $mutex.ReleaseMutex() } catch {}; $mutex.Dispose() }
}
