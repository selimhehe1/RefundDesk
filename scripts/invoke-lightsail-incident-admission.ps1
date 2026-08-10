[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $PromotionEvidencePath,

    [Parameter(Mandatory = $true)]
    [string] $PreflightEvidencePath,

    [Parameter(Mandatory = $true)]
    [string] $DashboardAttestationPath,

    [Parameter(Mandatory = $true)]
    [string] $FixtureInputPath,

    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string] $ExpectedSshCidr,

    [Parameter()]
    [switch] $ContractFixture,

    [Parameter()]
    [string] $FixtureToolDirectory,

    [Parameter()]
    [string] $FixtureEvidencePath
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
$MaximumInputBytes = 2097152
$MaximumRemoteBytes = 131072
$MaximumDiagnosticBytes = 32768
$RunningOnWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

function Throw-SafeError {
    param([Parameter(Mandatory = $true)][ValidatePattern("^[A-Z][A-Z0-9_]{0,63}$")][string] $Code)
    throw [InvalidOperationException]::new("REFUNDDESK_$Code")
}

function Get-UtcTimestamp {
    return [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
}

function Parse-UtcTimestamp {
    param([Parameter(Mandatory = $true)][string] $Value, [Parameter(Mandatory = $true)][string] $FailureCode)
    try {
        return [DateTime]::ParseExact(
            $Value,
            "yyyy-MM-ddTHH:mm:ssZ",
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        )
    }
    catch { Throw-SafeError $FailureCode }
}

function Resolve-LocalCaptureWindow {
    param(
        [Parameter(Mandatory = $true)][DateTime] $Now,
        [Parameter(Mandatory = $true)][DateTime] $DashboardUntil,
        [Parameter(Mandatory = $true)][DateTime] $FinalUntil,
        [Parameter(Mandatory = $true)][ValidateSet(0, 20, 21)][int] $RemoteExitCode,
        [Parameter(Mandatory = $true)][string] $RemoteResult,
        [Parameter(Mandatory = $true)][string] $RemoteCode
    )
    $validUntil = $Now.AddMinutes(15)
    foreach ($candidate in @($DashboardUntil, $FinalUntil)) {
        if ($candidate -lt $validUntil) { $validUntil = $candidate }
    }
    $localExitCode = if ($RemoteExitCode -eq 0) { 0 } elseif ($RemoteExitCode -eq 20) { 20 } else { 21 }
    $localResult = $RemoteResult
    $localCode = $RemoteCode
    if (($validUntil - $Now).TotalSeconds -lt 720) {
        if ($RemoteExitCode -ne 0) { Throw-SafeError "LOCAL_EVIDENCE_LIFETIME_INVALID" }
        $localExitCode = 21
        $localResult = "INCOMPLETE"
        $localCode = "LOCAL_EVIDENCE_LIFETIME_INVALID"
        $validUntil = $Now.AddMinutes(15)
        if ($FinalUntil -lt $validUntil) { $validUntil = $FinalUntil }
        if (($validUntil - $Now).TotalSeconds -lt 720) { Throw-SafeError "LOCAL_EVIDENCE_LIFETIME_INVALID" }
    }
    return [pscustomobject]@{
        Code = $localCode
        ExitCode = $localExitCode
        Result = $localResult
        ValidUntil = $validUntil
    }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
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

function Get-CanonicalFile {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $FailureCode)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            Throw-SafeError $FailureCode
        }
        return $full
    }
    catch {
        if ($_.Exception.Message -match '^REFUNDDESK_') { throw }
        Throw-SafeError $FailureCode
    }
}

function Get-CanonicalDirectory {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $FailureCode)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            Throw-SafeError $FailureCode
        }
        return $full
    }
    catch {
        if ($_.Exception.Message -match '^REFUNDDESK_') { throw }
        Throw-SafeError $FailureCode
    }
}

function Assert-RestrictedAcl {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $FailureCode)
    if (-not $RunningOnWindows) { return }
    try {
        # Deliberately inspect only the access ACL. Reading SACL/audit entries may
        # require SeSecurityPrivilege and is not part of this contract.
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $allowed = @($currentSid, "S-1-5-18", "S-1-5-32-544")
        if (-not $acl.AreAccessRulesProtected -or
            $allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) {
            Throw-SafeError $FailureCode
        }
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
                $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
                if ($allowed -notcontains $sid) { Throw-SafeError $FailureCode }
            }
        }
    }
    catch {
        if ($_.Exception.Message -match '^REFUNDDESK_') { throw }
        Throw-SafeError $FailureCode
    }
}

function New-RestrictedDirectory {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $FailureCode)
    $full = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full)) { [void] [IO.Directory]::CreateDirectory($full) }
    $canonical = Get-CanonicalDirectory $full $FailureCode
    if ($RunningOnWindows) {
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        foreach ($sid in @(
            [Security.Principal.WindowsIdentity]::GetCurrent().User,
            [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
            [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
        )) {
            [void] $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow
            ))
        }
        [IO.Directory]::SetAccessControl($canonical, $security)
    }
    Assert-RestrictedAcl $canonical $FailureCode
    return $canonical
}

function New-ExclusiveRestrictedDirectory {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $FailureCode)
    $full = [IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $full) { Throw-SafeError $FailureCode }
    try { [void] (New-Item -ItemType Directory -Path $full -ErrorAction Stop) }
    catch { Throw-SafeError $FailureCode }
    $canonical = New-RestrictedDirectory $full $FailureCode
    if (@([IO.Directory]::EnumerateFileSystemEntries($canonical)).Count -ne 0) { Throw-SafeError $FailureCode }
    return $canonical
}

function New-RestrictedAsciiFile {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Content,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )
    $full = [IO.Path]::GetFullPath($Path)
    $bytes = [Text.Encoding]::ASCII.GetBytes($Content)
    $stream = $null
    try {
        $stream = [IO.FileStream]::new($full, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    catch { Throw-SafeError $FailureCode }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    if ($RunningOnWindows) {
        $security = [Security.AccessControl.FileSecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
        foreach ($sid in @(
            [Security.Principal.WindowsIdentity]::GetCurrent().User,
            [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
            [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
        )) {
            [void] $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow
            ))
        }
        [IO.File]::SetAccessControl($full, $security)
    }
    Assert-RestrictedAcl $full $FailureCode
    return Get-CanonicalFile $full $FailureCode
}

function Assert-IsolatedTransportHome {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)] $ConfigLock,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )
    $canonical = Get-CanonicalDirectory $Path $FailureCode
    Assert-RestrictedAcl $canonical $FailureCode
    if ((Get-CanonicalFile $ConfigLock.Path $FailureCode) -cne $ConfigLock.Path -or
        (Get-StreamSha256 $ConfigLock.Stream) -cne $ConfigLock.Sha256) { Throw-SafeError $FailureCode }
    $entries = @([IO.Directory]::EnumerateFileSystemEntries($canonical))
    if ($entries.Count -ne 1 -or [IO.Path]::GetFullPath($entries[0]) -cne $ConfigLock.Path -or
        (Test-Path -LiteralPath (Join-Path $canonical ".aws")) -or
        (Test-Path -LiteralPath (Join-Path $canonical ".ssh"))) { Throw-SafeError $FailureCode }
}

function Remove-IsolatedTransportHome {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)] $ConfigLock,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )
    Assert-IsolatedTransportHome $Path $ConfigLock $FailureCode
    $configPath = $ConfigLock.Path
    $ConfigLock.Stream.Dispose()
    try { Remove-Item -LiteralPath $configPath -Force -ErrorAction Stop }
    catch { Throw-SafeError $FailureCode }
    if (@([IO.Directory]::EnumerateFileSystemEntries($Path)).Count -ne 0) { Throw-SafeError $FailureCode }
    try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch { Throw-SafeError $FailureCode }
    if (Test-Path -LiteralPath $Path) { Throw-SafeError $FailureCode }
}

function Open-FileLock {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode,
        [switch] $RequireRestrictedAcl
    )
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
            Sha256 = Get-StreamSha256 $stream
            Stream = $stream
        }
    }
    catch {
        if ($_.Exception.Message -match '^REFUNDDESK_') { throw }
        Throw-SafeError $FailureCode
    }
}

function Open-UnreadFileLock {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $FailureCode,
        [switch] $RequireRestrictedAcl
    )
    try {
        $canonical = Get-CanonicalFile $Path $FailureCode
        if ($RequireRestrictedAcl) { Assert-RestrictedAcl $canonical $FailureCode }
        $stream = [IO.FileStream]::new(
            $canonical,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        if ($stream.Length -le 0 -or $stream.Position -ne 0) { $stream.Dispose(); Throw-SafeError $FailureCode }
        return [pscustomobject]@{
            Length = $stream.Length
            Path = $canonical
            Stream = $stream
        }
    }
    catch {
        if ($_.Exception.Message -match '^REFUNDDESK_') { throw }
        Throw-SafeError $FailureCode
    }
}

function Assert-UnreadFileLock {
    param(
        [Parameter(Mandatory = $true)] $Lock,
        [Parameter(Mandatory = $true)][string] $FailureCode
    )
    try {
        if ($null -eq $Lock.Stream -or $Lock.Stream.SafeFileHandle.IsClosed -or
            $Lock.Stream.SafeFileHandle.IsInvalid -or $Lock.Stream.Position -ne 0 -or
            $Lock.Stream.Length -ne $Lock.Length -or
            (Get-CanonicalFile $Lock.Path $FailureCode) -cne $Lock.Path) {
            Throw-SafeError $FailureCode
        }
        Assert-RestrictedAcl $Lock.Path $FailureCode
    }
    catch {
        if ($_.Exception.Message -match '^REFUNDDESK_') { throw }
        Throw-SafeError $FailureCode
    }
}

function Read-LockedBytes {
    param([Parameter(Mandatory = $true)] $Lock, [Parameter(Mandatory = $true)][int] $MaximumBytes, [Parameter(Mandatory = $true)][string] $FailureCode)
    if ($Lock.Length -gt $MaximumBytes) { Throw-SafeError $FailureCode }
    $bytes = New-Object byte[] ([int] $Lock.Length)
    $Lock.Stream.Position = 0
    $offset = 0
    while ($offset -lt $bytes.Length) {
        $read = $Lock.Stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($read -le 0) { Throw-SafeError $FailureCode }
        $offset += $read
    }
    $Lock.Stream.Position = 0
    return $bytes
}

function Read-BoundedJsonLock {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][int] $MaximumBytes, [Parameter(Mandatory = $true)][string] $FailureCode)
    $lock = Open-FileLock $Path $FailureCode -RequireRestrictedAcl
    try {
        $bytes = Read-LockedBytes $lock $MaximumBytes $FailureCode
        if ($bytes.Length -eq 0 -or $bytes[0] -eq 239 -or $bytes -contains 0) { Throw-SafeError $FailureCode }
        try { $value = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json }
        catch { Throw-SafeError $FailureCode }
        return [pscustomobject]@{ Bytes = $bytes; Lock = $lock; Sha256 = $lock.Sha256; Value = $value }
    }
    catch {
        $lock.Stream.Dispose()
        throw
    }
}

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = [Text.StringBuilder]::new()
    [void] $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $backslashes += 1; continue }
        if ($character -eq '"') {
            [void] $builder.Append(('\' * (($backslashes * 2) + 1)))
            [void] $builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void] $builder.Append(('\' * $backslashes)); $backslashes = 0 }
        [void] $builder.Append($character)
    }
    if ($backslashes -gt 0) { [void] $builder.Append(('\' * ($backslashes * 2))) }
    [void] $builder.Append('"')
    return $builder.ToString()
}

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][Diagnostics.Process] $Process)
    try {
        if ($Process.HasExited) { return }
        if ($RunningOnWindows) {
            $taskkillPath = Join-Path $env:SystemRoot "System32\taskkill.exe"
            $start = [Diagnostics.ProcessStartInfo]::new()
            $start.FileName = $taskkillPath
            $start.Arguments = "/PID $($Process.Id) /T /F"
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $killer = [Diagnostics.Process]::new()
            $killer.StartInfo = $start
            try { if ($killer.Start()) { [void] $killer.WaitForExit(2000) } }
            finally { $killer.Dispose() }
        }
        if (-not $Process.HasExited) { $Process.Kill() }
    }
    catch { }
    try { [void] $Process.WaitForExit(2000) }
    catch { }
}

function New-KillOnCloseJob {
    if (-not $RunningOnWindows) { return [IntPtr]::Zero }
    if ($null -eq ("RefundDeskIncidentAdmissionNativeJob" -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class RefundDeskIncidentAdmissionNativeJob {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnClose() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        ExtendedLimits limits = new ExtendedLimits();
        limits.BasicLimitInformation.LimitFlags = 0x00002000;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }
}
'@
    }
    $job = [RefundDeskIncidentAdmissionNativeJob]::CreateKillOnClose()
    if ($job -eq [IntPtr]::Zero) { Throw-SafeError "PROCESS_JOB_CREATE_FAILED" }
    return $job
}

function New-CleanEnvironment {
    param([Collections.IDictionary] $Additional)
    if ([string]::IsNullOrWhiteSpace($env:SystemRoot) -or [string]::IsNullOrWhiteSpace($env:PROGRAMDATA) -or
        $env:SystemRoot.Contains("%") -or $env:PROGRAMDATA.Contains("%") -or
        -not [IO.Path]::IsPathRooted($env:SystemRoot) -or -not [IO.Path]::IsPathRooted($env:PROGRAMDATA)) {
        Throw-SafeError "PROCESS_ENVIRONMENT_INVALID"
    }
    $systemDrive = [IO.Path]::GetPathRoot($env:SystemRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($systemDrive -notmatch '^[A-Za-z]:$') { Throw-SafeError "PROCESS_ENVIRONMENT_INVALID" }
    $environment = [ordered]@{
        LC_ALL = "C"
        PATH = "$env:SystemRoot\System32"
        PROGRAMDATA = $env:PROGRAMDATA
        SystemDrive = $systemDrive
        SystemRoot = $env:SystemRoot
        TZ = "UTC"
        WINDIR = $env:WINDIR
    }
    if ($null -ne $Additional) {
        foreach ($entry in $Additional.GetEnumerator()) { $environment[$entry.Key] = [string] $entry.Value }
    }
    return $environment
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)][string] $Executable,
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ExpectedExecutableSha256,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][Collections.IDictionary] $Environment,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $InputBytes,
        [Parameter(Mandatory = $true)][ValidateRange(1, 2400)][int] $TimeoutSeconds,
        [Parameter(Mandatory = $true)][ValidateRange(1, 4194304)][int] $MaximumStdoutBytes
    )
    $executableLock = Open-FileLock $Executable "EXECUTABLE_LOCK_INVALID"
    if ($executableLock.Sha256 -cne $ExpectedExecutableSha256) {
        $executableLock.Stream.Dispose()
        Throw-SafeError "EXECUTABLE_PIN_MISMATCH"
    }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument ([string] $_) }) -join " ")
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Clear()
    foreach ($entry in $Environment.GetEnumerator()) {
        if ($entry.Key -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,63}$' -or ([string] $entry.Value).Contains([char] 0)) {
            $executableLock.Stream.Dispose()
            Throw-SafeError "PROCESS_ENVIRONMENT_INVALID"
        }
        $start.EnvironmentVariables[[string] $entry.Key] = [string] $entry.Value
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $stdout = [IO.MemoryStream]::new()
    $stderr = [IO.MemoryStream]::new()
    $stdoutBuffer = New-Object byte[] 8192
    $stderrBuffer = New-Object byte[] 4096
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $job = New-KillOnCloseJob
    try {
        if (-not $process.Start()) { Throw-SafeError "PROCESS_START_FAILED" }
        if ($job -ne [IntPtr]::Zero -and
            -not [RefundDeskIncidentAdmissionNativeJob]::AssignProcessToJobObject($job, $process.Handle)) {
            Throw-SafeError "PROCESS_JOB_ASSIGN_FAILED"
        }
        $stdoutTask = $process.StandardOutput.BaseStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
        $stderrTask = $process.StandardError.BaseStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
        $stdinTask = $process.StandardInput.BaseStream.WriteAsync($InputBytes, 0, $InputBytes.Length)
        $stdinClosed = $false
        $stdoutClosed = $false
        $stderrClosed = $false
        $failureCode = $null

        while (-not ($process.HasExited -and $stdoutClosed -and $stderrClosed)) {
            if ($stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                $failureCode = "PROCESS_TIMEOUT"
                Stop-ProcessTree $process
                break
            }
            if (-not $stdinClosed -and $stdinTask.IsCompleted) {
                if ($stdinTask.IsFaulted) {
                    $failureCode = "PROCESS_STDIN_FAILED"
                    Stop-ProcessTree $process
                    break
                }
                $process.StandardInput.BaseStream.Flush()
                $process.StandardInput.Close()
                $stdinClosed = $true
            }
            if (-not $stdoutClosed -and $stdoutTask.IsCompleted) {
                if ($stdoutTask.IsFaulted) {
                    $failureCode = "PROCESS_STDOUT_FAILED"
                    Stop-ProcessTree $process
                    break
                }
                $count = $stdoutTask.Result
                if ($count -eq 0) { $stdoutClosed = $true }
                else {
                    if (($stdout.Length + $count) -gt $MaximumStdoutBytes) {
                        $failureCode = "PROCESS_STDOUT_LIMIT"
                        Stop-ProcessTree $process
                        break
                    }
                    $stdout.Write($stdoutBuffer, 0, $count)
                    $stdoutTask = $process.StandardOutput.BaseStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
                }
            }
            if (-not $stderrClosed -and $stderrTask.IsCompleted) {
                if ($stderrTask.IsFaulted) {
                    $failureCode = "PROCESS_STDERR_FAILED"
                    Stop-ProcessTree $process
                    break
                }
                $count = $stderrTask.Result
                if ($count -eq 0) { $stderrClosed = $true }
                else {
                    if (($stderr.Length + $count) -gt $MaximumDiagnosticBytes) {
                        $failureCode = "PROCESS_STDERR_LIMIT"
                        Stop-ProcessTree $process
                        break
                    }
                    $stderr.Write($stderrBuffer, 0, $count)
                    $stderrTask = $process.StandardError.BaseStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
                }
            }
            if ($null -eq $failureCode) { [Threading.Thread]::Sleep(10) }
        }
        if ($null -ne $failureCode) { Throw-SafeError $failureCode }
        if (-not $stdinClosed) { $process.StandardInput.Close() }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stderr = $stderr.ToArray(); Stdout = $stdout.ToArray() }
    }
    catch {
        Stop-ProcessTree $process
        if ($_.Exception.Message -match '^REFUNDDESK_') { throw }
        Throw-SafeError "PROCESS_INTERNAL_ERROR"
    }
    finally {
        if ($job -ne [IntPtr]::Zero) {
            [void] [RefundDeskIncidentAdmissionNativeJob]::CloseHandle($job)
        }
        $executableLock.Stream.Dispose()
        $stopwatch.Stop()
        $stdout.Dispose()
        $stderr.Dispose()
        $process.Dispose()
    }
}

function Invoke-IsolatedTransportProcess {
    param(
        [Parameter(Mandatory = $true)][string] $Executable,
        [Parameter(Mandatory = $true)][string] $ExpectedExecutableSha256,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][Collections.IDictionary] $Environment,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $InputBytes,
        [Parameter(Mandatory = $true)][int] $TimeoutSeconds,
        [Parameter(Mandatory = $true)][int] $MaximumStdoutBytes,
        [Parameter(Mandatory = $true)][string] $IsolatedHome,
        [Parameter(Mandatory = $true)] $ConfigLock
    )
    Assert-IsolatedTransportHome $IsolatedHome $ConfigLock "ISOLATED_HOME_CHANGED"
    try {
        return Invoke-BoundedProcess $Executable $ExpectedExecutableSha256 $Arguments $Environment $InputBytes $TimeoutSeconds $MaximumStdoutBytes
    }
    finally { Assert-IsolatedTransportHome $IsolatedHome $ConfigLock "ISOLATED_HOME_CHANGED" }
}

function Assert-CanonicalIpv4HostCidr {
    param([Parameter(Mandatory = $true)][string] $Value, [switch] $DocumentationOnly)
    if ($Value -notmatch '^(?<address>(?:[0-9]{1,3}\.){3}[0-9]{1,3})/32$') { Throw-SafeError "SSH_CIDR_INVALID" }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($Matches.address, [ref] $address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        ("{0}/32" -f $address) -cne $Value) { Throw-SafeError "SSH_CIDR_INVALID" }
    if ($DocumentationOnly -and -not (
        $Matches.address -like '192.0.2.*' -or
        $Matches.address -like '198.51.100.*' -or
        $Matches.address -like '203.0.113.*'
    )) { Throw-SafeError "FIXTURE_SSH_CIDR_INVALID" }
}

function Assert-ExactProperties {
    param([Parameter(Mandatory = $true)] $Value, [Parameter(Mandatory = $true)][string[]] $Expected, [Parameter(Mandatory = $true)][string] $FailureCode)
    if ($null -eq $Value) { Throw-SafeError $FailureCode }
    $observed = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($observed -join '|') -cne ($wanted -join '|')) { Throw-SafeError $FailureCode }
}

function Get-PostIncidentBaselineFromPostflight {
    param([Parameter(Mandatory = $true)] $Postflight)
    $database = $Postflight.remote.captures.b.database
    if ($null -eq $database) { Throw-SafeError "FINAL_POSTFLIGHT_BASELINE_MISSING" }
    $mapping = [ordered]@{
        activeFinancialJobs = "activeFinancialJobs"
        auditEvents = "auditEvents"
        mutationReceipts = "apiMutationReceipts"
        refundExecutionAttempts = "refundExecutionAttempts"
        refundExecutions = "refundExecutions"
        refundRequests = "refundRequests"
        unreleasedPaymentGuards = "unreleasedPaymentGuards"
        webhookReceipts = "webhookReceipts"
    }
    $counts = [ordered]@{}
    $integerTypes = @([byte], [sbyte], [int16], [uint16], [int32], [uint32], [int64])
    foreach ($target in $mapping.Keys) {
        $value = $database.($mapping[$target])
        $isInteger = $false
        foreach ($type in $integerTypes) {
            if ($value -is $type) { $isInteger = $true; break }
        }
        if (-not $isInteger -or [int64] $value -lt 0 -or [int64] $value -gt 9007199254740991) {
            Throw-SafeError "FINAL_POSTFLIGHT_BASELINE_INVALID"
        }
        $counts[$target] = [int64] $value
    }
    $canonicalBytes = [Text.UTF8Encoding]::new($false).GetBytes(($counts | ConvertTo-Json -Compress))
    $baseline = [ordered]@{}
    foreach ($name in @("activeFinancialJobs", "auditEvents", "mutationReceipts", "refundExecutionAttempts", "refundExecutions", "refundRequests")) {
        $baseline[$name] = $counts[$name]
    }
    $baseline.snapshotSha256 = Get-Sha256Hex $canonicalBytes
    $baseline.unreleasedPaymentGuards = $counts.unreleasedPaymentGuards
    $baseline.webhookReceipts = $counts.webhookReceipts
    return $baseline
}

function Assert-PostIncidentBaselineEqual {
    param([Parameter(Mandatory = $true)] $Observed, [Parameter(Mandatory = $true)] $Expected)
    $names = @("activeFinancialJobs", "auditEvents", "mutationReceipts", "refundExecutionAttempts", "refundExecutions", "refundRequests", "snapshotSha256", "unreleasedPaymentGuards", "webhookReceipts")
    Assert-ExactProperties $Observed $names "REMOTE_POST_INCIDENT_BASELINE_INVALID"
    foreach ($name in $names) {
        if ([string] $Observed.$name -cne [string] $Expected.$name) {
            Throw-SafeError "POST_INCIDENT_BASELINE_MISMATCH"
        }
    }
}

function Assert-IncidentPostflightRuntimeMode {
    param([Parameter(Mandatory = $true)] $Postflight)
    foreach ($captureName in @("a", "b")) {
        $capture = $Postflight.remote.captures.$captureName
        if ($null -eq $capture -or
            [string] $capture.identity.releaseEnvironmentWorkerRuntimeMode -cne "INCIDENT_ADMISSION") {
            Throw-SafeError "FINAL_POSTFLIGHT_RUNTIME_MODE_INVALID"
        }
        $workers = @($capture.containers | Where-Object { [string] $_.service -ceq "worker" })
        if ($workers.Count -ne 1 -or
            [string] $workers[0].effectiveWorkerRuntimeMode -cne "INCIDENT_ADMISSION") {
            Throw-SafeError "FINAL_POSTFLIGHT_RUNTIME_MODE_INVALID"
        }
    }
}

function Get-VerifiedFinalCandidateBinding {
    param(
        [Parameter(Mandatory = $true)] $Postflight,
        [Parameter(Mandatory = $true)] $Promotion
    )
    $expectedSystemIdentifier = [string] $Promotion.database.systemIdentifier
    $runtime = [ordered]@{
        caddy = [string] $Promotion.runtime.caddyContainerId
        postgres = [string] $Promotion.runtime.postgresContainerId
        verifier = [string] $Promotion.runtime.verifierContainerId
        web = [string] $Promotion.runtime.webContainerId
        worker = [string] $Promotion.runtime.workerContainerId
    }
    if ($expectedSystemIdentifier -notmatch '^[1-9][0-9]{17,19}$') {
        Throw-SafeError "PROMOTION_SYSTEM_IDENTIFIER_INVALID"
    }
    foreach ($identifier in $runtime.Values) {
        if ($identifier -notmatch '^[0-9a-f]{64}$') { Throw-SafeError "PROMOTION_RUNTIME_INVALID" }
    }
    foreach ($captureName in @("a", "b")) {
        $capture = $Postflight.remote.captures.$captureName
        if ([string] $capture.database.systemIdentifier -cne $expectedSystemIdentifier) {
            Throw-SafeError "FINAL_POSTFLIGHT_SYSTEM_IDENTIFIER_MISMATCH"
        }
        $containers = @($capture.containers)
        if ($containers.Count -ne 5) { Throw-SafeError "FINAL_POSTFLIGHT_CONTAINER_BINDING_INVALID" }
        foreach ($service in $runtime.Keys) {
            $matches = @($containers | Where-Object { [string] $_.service -ceq $service })
            if ($matches.Count -ne 1 -or [string] $matches[0].containerId -cne $runtime[$service]) {
                Throw-SafeError "FINAL_POSTFLIGHT_CONTAINER_BINDING_MISMATCH"
            }
        }
    }
    $utf8 = [Text.UTF8Encoding]::new($false)
    return [ordered]@{
        caddyContainerIdSha256 = Get-Sha256Hex ($utf8.GetBytes($runtime.caddy))
        postgresContainerIdSha256 = Get-Sha256Hex ($utf8.GetBytes($runtime.postgres))
        systemIdentifierSha256 = Get-Sha256Hex ($utf8.GetBytes($expectedSystemIdentifier))
        verifierContainerIdSha256 = Get-Sha256Hex ($utf8.GetBytes($runtime.verifier))
        webContainerIdSha256 = Get-Sha256Hex ($utf8.GetBytes($runtime.web))
        workerContainerIdSha256 = Get-Sha256Hex ($utf8.GetBytes($runtime.worker))
    }
}

function Assert-CanonicalDocumentBytes {
    param([Parameter(Mandatory = $true)][byte[]] $Bytes, [Parameter(Mandatory = $true)][string] $FailureCode)
    if ($Bytes.Length -eq 0 -or $Bytes[$Bytes.Length - 1] -ne 10 -or
        $Bytes -contains 13 -or $Bytes -contains 0 -or $Bytes[0] -eq 239) { Throw-SafeError $FailureCode }
    $newlines = @($Bytes | Where-Object { $_ -eq 10 }).Count
    if ($newlines -ne 1) { Throw-SafeError $FailureCode }
}

function ConvertFrom-ExactJsonBytes {
    param([Parameter(Mandatory = $true)][byte[]] $Bytes, [Parameter(Mandatory = $true)][string] $FailureCode)
    Assert-CanonicalDocumentBytes $Bytes $FailureCode
    try { return [Text.UTF8Encoding]::new($false, $true).GetString($Bytes) | ConvertFrom-Json }
    catch { Throw-SafeError $FailureCode }
}

function Write-EvidenceCreateNew {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][byte[]] $Bytes)
    $stream = $null
    $created = $false
    try {
        $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $created = $true
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if ($RunningOnWindows) {
            $security = [Security.AccessControl.FileSecurity]::new()
            $security.SetAccessRuleProtection($true, $false)
            $security.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
            foreach ($sid in @(
                [Security.Principal.WindowsIdentity]::GetCurrent().User,
                [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
                [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
            )) {
                [void] $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                    $sid,
                    [Security.AccessControl.FileSystemRights]::FullControl,
                    [Security.AccessControl.AccessControlType]::Allow
                ))
            }
            [IO.File]::SetAccessControl($Path, $security)
            Assert-RestrictedAcl $Path "EVIDENCE_ACL_INVALID"
        }
        $verification = Open-FileLock $Path "EVIDENCE_COMMIT_INVALID" -RequireRestrictedAcl
        try {
            if ($verification.Length -ne $Bytes.Length -or $verification.Sha256 -cne (Get-Sha256Hex $Bytes)) {
                Throw-SafeError "EVIDENCE_COMMIT_INVALID"
            }
        }
        finally { $verification.Stream.Dispose() }
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose(); $stream = $null }
        if ($created -and (Test-Path -LiteralPath $Path)) {
            try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop }
            catch { }
        }
        if ($_.Exception.Message -match '^REFUNDDESK_') { throw }
        Throw-SafeError "EVIDENCE_CREATE_NEW_FAILED"
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Invoke-Validator {
    param(
        [Parameter(Mandatory = $true)][string] $Kind,
        [Parameter(Mandatory = $true)][byte[]] $Bytes,
        [Parameter(Mandatory = $true)][string] $NodePath,
        [Parameter(Mandatory = $true)][string] $NodeSha256,
        [Parameter(Mandatory = $true)][string] $ValidatorPath,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $ExpectedRevision,
        [switch] $FixtureOnly,
        [object] $ExpectedPromotion,
        [int[]] $AllowedExitCodes = @(0)
    )
    $arguments = @($ValidatorPath, "--kind", $Kind)
    if ($Kind -cne "fixture") { $arguments += @("--now", (Get-UtcTimestamp)) }
    if (-not [string]::IsNullOrEmpty($ExpectedRevision)) { $arguments += @("--expected-revision", $ExpectedRevision) }
    if ($FixtureOnly) { $arguments += @("--fixture-only", "true") }
    if ($null -ne $ExpectedPromotion) {
        Assert-ExactProperties $ExpectedPromotion @("bundleSha256", "evidenceSha256", "manifestSha256", "provenanceSha256", "sourceSha256") "EXPECTED_PROMOTION_INVALID"
        $arguments += @(
            "--expected-promotion-bundle-sha256", [string] $ExpectedPromotion.bundleSha256,
            "--expected-promotion-evidence-sha256", [string] $ExpectedPromotion.evidenceSha256,
            "--expected-promotion-manifest-sha256", [string] $ExpectedPromotion.manifestSha256,
            "--expected-promotion-provenance-sha256", [string] $ExpectedPromotion.provenanceSha256,
            "--expected-promotion-source-sha256", [string] $ExpectedPromotion.sourceSha256
        )
    }
    $result = Invoke-BoundedProcess $NodePath $NodeSha256 $arguments (New-CleanEnvironment $null) $Bytes 30 $MaximumInputBytes
    if ($AllowedExitCodes -notcontains $result.ExitCode -or $result.Stderr.Length -ne 0) {
        Throw-SafeError "VALIDATION_FAILED"
    }
    Assert-CanonicalDocumentBytes $result.Stdout "VALIDATOR_OUTPUT_INVALID"
    return $result
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string] $GitPath,
        [Parameter(Mandatory = $true)][string] $GitSha256,
        [Parameter(Mandatory = $true)][string] $Repository,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [int] $MaximumBytes = 2097152,
        [int[]] $AllowedExitCodes = @(0)
    )
    $nullDevice = if ($RunningOnWindows) { "NUL" } else { "/dev/null" }
    $gitEnvironment = New-CleanEnvironment ([ordered]@{
        GIT_CONFIG_GLOBAL = $nullDevice
        GIT_CONFIG_NOSYSTEM = "1"
        GIT_NO_REPLACE_OBJECTS = "1"
        GIT_OPTIONAL_LOCKS = "0"
    })
    $result = Invoke-BoundedProcess $GitPath $GitSha256 (@("--no-replace-objects", "--no-optional-locks", "-C", $Repository) + $Arguments) $gitEnvironment ([byte[]]@()) 30 $MaximumBytes
    if ($AllowedExitCodes -notcontains $result.ExitCode -or $result.Stderr.Length -ne 0) { Throw-SafeError "GIT_COMMAND_FAILED" }
    return $result
}

function Get-AsciiOutput {
    param([Parameter(Mandatory = $true)][byte[]] $Bytes, [Parameter(Mandatory = $true)][string] $FailureCode)
    try {
        $text = [Text.Encoding]::ASCII.GetString($Bytes).Trim()
        if ([Text.Encoding]::ASCII.GetBytes($text).Length -ne $text.Length) { Throw-SafeError $FailureCode }
        return $text
    }
    catch {
        if ($_.Exception.Message -match '^REFUNDDESK_') { throw }
        Throw-SafeError $FailureCode
    }
}

function Get-TrackedSourceRecord {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $RelativePath,
        [Parameter(Mandatory = $true)][string] $Repository,
        [Parameter(Mandatory = $true)][string] $Head,
        [Parameter(Mandatory = $true)][string] $GitPath,
        [Parameter(Mandatory = $true)][string] $GitSha256,
        [Parameter(Mandatory = $true)][Collections.Generic.List[object]] $Locks,
        [switch] $FixtureOnly
    )
    $worktree = Open-FileLock (Join-Path $Repository $RelativePath) "PINNED_SOURCE_INVALID"
    $Locks.Add($worktree)
    $oid = $null
    if (-not $FixtureOnly) {
        $stageResult = Invoke-Git $GitPath $GitSha256 $Repository @("ls-files", "--stage", "--", $RelativePath) 4096
        $stage = Get-AsciiOutput $stageResult.Stdout "PINNED_SOURCE_INDEX_INVALID"
        if ($stage -notmatch "^(100644|100755) (?<oid>[0-9a-f]{40}) 0\t(?<path>.+)$" -or $Matches.path -cne $RelativePath) {
            Throw-SafeError "PINNED_SOURCE_INDEX_INVALID"
        }
        $oid = $Matches.oid
        $headOid = Get-AsciiOutput (Invoke-Git $GitPath $GitSha256 $Repository @("rev-parse", "$Head`:$RelativePath") 4096).Stdout "PINNED_SOURCE_HEAD_INVALID"
        if ($headOid -cne $oid) { Throw-SafeError "PINNED_SOURCE_HEAD_INVALID" }
        $blob = Invoke-Git $GitPath $GitSha256 $Repository @("cat-file", "blob", $oid) ([int] [Math]::Min([long] 4194304, [Math]::Max([long] 1, $worktree.Length + 1)))
        if ((Get-Sha256Hex $blob.Stdout) -cne $worktree.Sha256) { Throw-SafeError "PINNED_SOURCE_WORKTREE_INVALID" }
        foreach ($arguments in @(
            @("diff", "--quiet", "--", $RelativePath),
            @("diff", "--cached", "--quiet", $Head, "--", $RelativePath)
        )) {
            $unchanged = Invoke-Git $GitPath $GitSha256 $Repository $arguments 4096 @(0, 1)
            if ($unchanged.ExitCode -ne 0) { Throw-SafeError "PINNED_SOURCE_DIRTY" }
        }
    }
    return [pscustomobject]@{
        Name = $Name
        Record = [ordered]@{ gitObject = $oid; sha256 = $worktree.Sha256 }
        RelativePath = $RelativePath
        Worktree = $worktree
    }
}

function Assert-LocksUnchanged {
    param([Parameter(Mandatory = $true)][Collections.Generic.List[object]] $Sources)
    foreach ($source in $Sources) {
        if ((Get-StreamSha256 $source.Worktree.Stream) -cne $source.Record.sha256) {
            Throw-SafeError "CAPTURE_CHANGED"
        }
    }
}

function Assert-InputLocksUnchanged {
    param([Parameter(Mandatory = $true)][object[]] $Inputs)
    foreach ($input in $Inputs) {
        if ((Get-StreamSha256 $input.Lock.Stream) -cne $input.Sha256) { Throw-SafeError "CAPTURE_CHANGED" }
    }
}

function Get-ProductionAwsControl {
    param(
        [Parameter(Mandatory = $true)][string] $AwsPath,
        [Parameter(Mandatory = $true)][string] $AwsSha256,
        [Parameter(Mandatory = $true)][Collections.IDictionary] $Environment,
        [Parameter(Mandatory = $true)][string] $ExpectedCidr,
        [Parameter(Mandatory = $true)][string] $IsolatedHome,
        [Parameter(Mandatory = $true)] $ConfigLock
    )
    $identityResult = Invoke-IsolatedTransportProcess $AwsPath $AwsSha256 @("sts", "get-caller-identity", "--output", "json", "--region", $ExpectedAwsRegion) $Environment ([byte[]]@()) 30 262144 $IsolatedHome $ConfigLock
    $instanceResult = Invoke-IsolatedTransportProcess $AwsPath $AwsSha256 @("lightsail", "get-instance", "--instance-name", $ExpectedInstanceName, "--output", "json", "--region", $ExpectedAwsRegion) $Environment ([byte[]]@()) 30 262144 $IsolatedHome $ConfigLock
    $portsResult = Invoke-IsolatedTransportProcess $AwsPath $AwsSha256 @("lightsail", "get-instance-port-states", "--instance-name", $ExpectedInstanceName, "--output", "json", "--region", $ExpectedAwsRegion) $Environment ([byte[]]@()) 30 262144 $IsolatedHome $ConfigLock
    if ($identityResult.ExitCode -ne 0 -or $instanceResult.ExitCode -ne 0 -or $portsResult.ExitCode -ne 0 -or
        $identityResult.Stderr.Length -ne 0 -or $instanceResult.Stderr.Length -ne 0 -or $portsResult.Stderr.Length -ne 0) {
        Throw-SafeError "AWS_CONTROL_FAILED"
    }
    try {
        $identity = [Text.UTF8Encoding]::new($false, $true).GetString($identityResult.Stdout) | ConvertFrom-Json
        $instance = [Text.UTF8Encoding]::new($false, $true).GetString($instanceResult.Stdout) | ConvertFrom-Json
        $ports = [Text.UTF8Encoding]::new($false, $true).GetString($portsResult.Stdout) | ConvertFrom-Json
    }
    catch { Throw-SafeError "AWS_CONTROL_INVALID" }
    if ($identity.Account -cne $ExpectedAwsAccount -or $instance.instance.name -cne $ExpectedInstanceName -or
        $instance.instance.state.name -cne "running" -or
        -not ([string] $instance.instance.location.availabilityZone).StartsWith($ExpectedAwsRegion, [StringComparison]::Ordinal)) {
        Throw-SafeError "AWS_TARGET_INVALID"
    }
    $open = @($ports.portStates | Where-Object { $_.state -ceq "open" })
    $ssh = @($open | Where-Object {
        $_.fromPort -eq 22 -and $_.toPort -eq 22 -and $_.protocol -ceq "tcp" -and
        @($_.cidrs).Count -eq 1 -and $_.cidrs[0] -ceq $ExpectedCidr -and
        @($_.ipv6Cidrs).Count -eq 0 -and @($_.cidrListAliases).Count -eq 0
    })
    $public = @($open | Where-Object {
        ($_.fromPort -le 80 -and $_.toPort -ge 80) -or ($_.fromPort -le 443 -and $_.toPort -ge 443)
    })
    if ($open.Count -ne 1 -or $ssh.Count -ne 1 -or $public.Count -ne 0) { Throw-SafeError "AWS_FIREWALL_INVALID" }
    $projection = [ordered]@{
        account = [string] $identity.Account
        instance = [string] $instance.instance.name
        region = $ExpectedAwsRegion
        sshCidr = $ExpectedCidr
        state = [string] $instance.instance.state.name
    }
    $projectionBytes = [Text.UTF8Encoding]::new($false).GetBytes(($projection | ConvertTo-Json -Compress))
    return [pscustomobject]@{
        Digest = Get-Sha256Hex $projectionBytes
        PublicIpAddress = [string] $instance.instance.publicIpAddress
    }
}

function Get-FixtureAwsControl {
    param([Parameter(Mandatory = $true)][string] $ToolDirectory)
    $fixture = Read-BoundedJsonLock (Join-Path $ToolDirectory "aws-control.fixture.json") 4096 "FIXTURE_AWS_CONTROL_INVALID"
    try {
        Assert-ExactProperties $fixture.Value @("accountMatches", "digest", "firewallClosed", "instanceMatches", "regionMatches") "FIXTURE_AWS_CONTROL_INVALID"
        if ($fixture.Value.accountMatches -ne $true -or $fixture.Value.firewallClosed -ne $true -or
            $fixture.Value.instanceMatches -ne $true -or $fixture.Value.regionMatches -ne $true -or
            $fixture.Value.digest -notmatch '^[0-9a-f]{64}$') { Throw-SafeError "FIXTURE_AWS_CONTROL_INVALID" }
        return [pscustomobject]@{ Digest = [string] $fixture.Value.digest; PublicIpAddress = "192.0.2.1" }
    }
    finally { $fixture.Lock.Stream.Dispose() }
}

function Invoke-RemoteUpload {
    param(
        [Parameter(Mandatory = $true)][string] $SshPath,
        [Parameter(Mandatory = $true)][string] $SshSha256,
        [Parameter(Mandatory = $true)][string[]] $SshBase,
        [Parameter(Mandatory = $true)][Collections.IDictionary] $SshEnvironment,
        [Parameter(Mandatory = $true)][byte[]] $Bytes,
        [Parameter(Mandatory = $true)][string] $Sha256,
        [Parameter(Mandatory = $true)][string] $RemotePath,
        [Parameter(Mandatory = $true)][ValidateSet("0600", "0700")][string] $Mode,
        [Parameter(Mandatory = $true)][string] $IsolatedHome,
        [Parameter(Mandatory = $true)] $ConfigLock
    )
    if ($RemotePath -notmatch '^/run/refunddesk/incident-admission-[0-9a-f]{64}/[a-z0-9.-]+$') {
        Throw-SafeError "REMOTE_STAGE_PATH_INVALID"
    }
    $receiver = 'import hashlib,os,stat,sys;p=sys.argv[1];n=int(sys.argv[2]);h=sys.argv[3];m=int(sys.argv[4],8);f=os.fdopen(os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),m),"wb");d=hashlib.sha256();c=0;exec("while True:\n b=sys.stdin.buffer.read(1048576)\n if not b: break\n c+=len(b);d.update(b);f.write(b)");f.flush();os.fsync(f.fileno());f.close();s=os.lstat(p);ok=c==n and d.hexdigest()==h and stat.S_ISREG(s.st_mode) and stat.S_IMODE(s.st_mode)==m and s.st_uid==0 and s.st_gid==0;exec("if not ok:\n os.unlink(p)\n sys.exit(20)");q=os.open(os.path.dirname(p),os.O_RDONLY|os.O_DIRECTORY);os.fsync(q);os.close(q)'
    $command = "sudo --non-interactive -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /usr/bin/python3 -c '$receiver' '$RemotePath' $($Bytes.Length) '$Sha256' '$Mode'"
    $result = Invoke-IsolatedTransportProcess $SshPath $SshSha256 ($SshBase + @($command)) $SshEnvironment $Bytes 120 1 $IsolatedHome $ConfigLock
    if ($result.ExitCode -ne 0 -or $result.Stdout.Length -ne 0 -or $result.Stderr.Length -ne 0) {
        Throw-SafeError "REMOTE_UPLOAD_FAILED"
    }
}

function Invoke-FormalFinalPostflight {
    param(
        [Parameter(Mandatory = $true)][string] $Repository,
        [Parameter(Mandatory = $true)][string] $ExpectedRevision,
        [Parameter(Mandatory = $true)][string] $ExpectedCidr,
        [Parameter(Mandatory = $true)][string] $NodePath,
        [Parameter(Mandatory = $true)][string] $NodeSha256,
        [Parameter(Mandatory = $true)][string] $ValidatorPath,
        [Parameter(Mandatory = $true)][string] $RemoteCompletedAt,
        [Parameter(Mandatory = $true)][string] $ToolDirectory,
        [Parameter(Mandatory = $true)][string] $EvidenceDirectory,
        [switch] $FixtureOnly
    )
    $capture = $null
    if ($FixtureOnly) {
        # Contract mode cannot produce operational evidence. It consumes only a
        # locally generated, ACL-restricted ADR 0034 fixture while production
        # below launches the official wrapper and discovers exactly one capture.
        $capture = Read-BoundedJsonLock (Join-Path $ToolDirectory "final-postflight.fixture.json") $MaximumInputBytes "FIXTURE_FINAL_POSTFLIGHT_INVALID"
        [IO.File]::AppendAllText(
            (Join-Path $ToolDirectory "postflight-invocations.fixture.log"),
            "attempt`n",
            [Text.UTF8Encoding]::new($false)
        )
    }
    else {
        $before = @(Get-ChildItem -LiteralPath $EvidenceDirectory -Filter "host-postflight-*.local.json" -File -Force | ForEach-Object FullName)
        $powershellPath = Get-CanonicalFile ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) "POWERSHELL_EXECUTABLE_INVALID"
        $powershellLock = Open-FileLock $powershellPath "POWERSHELL_EXECUTABLE_INVALID"
        try {
            $environment = New-CleanEnvironment ([ordered]@{
                APPDATA = $env:APPDATA
                ComSpec = $env:ComSpec
                LOCALAPPDATA = $env:LOCALAPPDATA
                PROGRAMDATA = $env:PROGRAMDATA
                TEMP = $env:TEMP
                TMP = $env:TMP
                USERPROFILE = $env:USERPROFILE
            })
            $postflightPath = Join-Path $Repository "scripts/invoke-lightsail-postflight.ps1"
            $run = Invoke-BoundedProcess $powershellPath $powershellLock.Sha256 @(
                "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", $postflightPath, "-ExpectedSshCidr", $ExpectedCidr
            ) $environment ([byte[]]@()) 240 $MaximumDiagnosticBytes
            if ($run.ExitCode -ne 0 -or $run.Stderr.Length -ne 0) { Throw-SafeError "FINAL_POSTFLIGHT_INVOCATION_FAILED" }
        }
        finally { $powershellLock.Stream.Dispose() }
        $after = @(Get-ChildItem -LiteralPath $EvidenceDirectory -Filter "host-postflight-*.local.json" -File -Force | ForEach-Object FullName)
        $created = @($after | Where-Object { $before -notcontains $_ })
        if ($created.Count -ne 1) { Throw-SafeError "FINAL_POSTFLIGHT_CARDINALITY_INVALID" }
        $capture = Read-BoundedJsonLock $created[0] $MaximumInputBytes "FINAL_POSTFLIGHT_INVALID"
    }
    try {
        [void] (Invoke-Validator "postflight" $capture.Bytes $NodePath $NodeSha256 $ValidatorPath $ExpectedRevision -FixtureOnly:$FixtureOnly)
        Assert-IncidentPostflightRuntimeMode $capture.Value
        $capturedAt = Parse-UtcTimestamp ([string] $capture.Value.capturedAt) "FINAL_POSTFLIGHT_TIME_INVALID"
        $remoteCompleted = Parse-UtcTimestamp $RemoteCompletedAt "REMOTE_COMPLETION_TIME_INVALID"
        if ($capturedAt -lt $remoteCompleted -or $capture.Value.posture -cne "COHERENT_CONTAINED" -or
            $capture.Value.result -cne "PASS" -or $capture.Value.remote.code -cne "PASS_CONTAINED" -or
            -not $capture.Value.awsControlPlane.firewallClosedBefore -or
            -not $capture.Value.awsControlPlane.firewallClosedAfter -or
            -not $capture.Value.awsControlPlane.firewallUnchanged) {
            Throw-SafeError "FINAL_POSTFLIGHT_NOT_CONTAINED"
        }
        return [pscustomobject]@{
            Bytes = $capture.Bytes
            CapturedAt = [string] $capture.Value.capturedAt
            Lock = $capture.Lock
            Sha256 = $capture.Sha256
            ValidUntil = [string] $capture.Value.validUntil
            Value = $capture.Value
        }
    }
    catch {
        $capture.Lock.Stream.Dispose()
        throw
    }
}

$locks = [Collections.Generic.List[object]]::new()
$sources = [Collections.Generic.List[object]]::new()
$finalPostflight = $null
$credentialLock = $null
$isolatedConfigLock = $null
$isolatedConfigPath = $null
$isolatedHome = $null
$mutex = $null
$remoteStage = $null
$remoteStageCleaned = $false
$remoteCompleted = $false
$remoteInvocationStarted = $false
$remote = $null
$contractMode = $false
$artifactCommitted = $false
$contractFailure = ""
$exitCode = 1
try {
    Assert-CanonicalIpv4HostCidr $ExpectedSshCidr -DocumentationOnly:$ContractFixture
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    $contractMode = $ContractFixture.IsPresent
    if ($contractMode) {
        $contractFailure = [string] $env:REFUNDDESK_INCIDENT_ADMISSION_CONTRACT_FAILURE
        if (-not [string]::IsNullOrEmpty($contractFailure) -and @(
            "remote-cleanup-fail", "remote-cleanup-hang", "remote-cleanup-ambiguous",
            "aws-after", "baseline-mismatch", "final-container-id", "final-postflight",
            "final-system-identifier", "source-race", "evidence-create-new"
        ) -notcontains $contractFailure) { Throw-SafeError "FIXTURE_FAILURE_INVALID" }
        if ($env:REFUNDDESK_INCIDENT_ADMISSION_CONTRACT_MODE -cne "1" -or
            [string]::IsNullOrWhiteSpace($FixtureToolDirectory) -or
            [string]::IsNullOrWhiteSpace($FixtureEvidencePath)) {
            Throw-SafeError "FIXTURE_MODE_NOT_ADMITTED"
        }
        $toolDirectory = Get-CanonicalDirectory $FixtureToolDirectory "FIXTURE_TOOL_DIRECTORY_INVALID"
        Assert-RestrictedAcl $toolDirectory "FIXTURE_TOOL_DIRECTORY_INVALID"
        $evidenceDirectory = Get-CanonicalDirectory ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($FixtureEvidencePath))) "FIXTURE_EVIDENCE_DIRECTORY_INVALID"
        Assert-RestrictedAcl $evidenceDirectory "FIXTURE_EVIDENCE_DIRECTORY_INVALID"
        $evidencePath = [IO.Path]::GetFullPath($FixtureEvidencePath)
        $repositoryPrefix = $repository.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if ([IO.Path]::GetDirectoryName($evidencePath) -cne $evidenceDirectory -or
            $evidencePath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Throw-SafeError "FIXTURE_EVIDENCE_PATH_INVALID"
        }
        $nodePath = Get-CanonicalFile (Get-Command node.exe -ErrorAction Stop).Source "FIXTURE_NODE_INVALID"
        $gitPath = Get-CanonicalFile (Get-Command git.exe -ErrorAction Stop).Source "FIXTURE_GIT_INVALID"
        $nodeProbe = Open-FileLock $nodePath "FIXTURE_NODE_INVALID"
        $gitProbe = Open-FileLock $gitPath "FIXTURE_GIT_INVALID"
        try { $nodeSha256 = $nodeProbe.Sha256; $gitSha256 = $gitProbe.Sha256 }
        finally { $nodeProbe.Stream.Dispose(); $gitProbe.Stream.Dispose() }
    }
    else {
        if (-not [string]::IsNullOrEmpty($FixtureToolDirectory) -or -not [string]::IsNullOrEmpty($FixtureEvidencePath)) {
            Throw-SafeError "FIXTURE_ARGUMENT_FORBIDDEN"
        }
        $toolDirectory = $null
        $nodePath = $PinnedNodePath
        $gitPath = $PinnedGitPath
        $nodeSha256 = $PinnedNodeSha256
        $gitSha256 = $PinnedGitSha256
        $evidenceDirectory = Get-CanonicalDirectory (Join-Path $repository "sandbox-evidence.local/aws") "EVIDENCE_DIRECTORY_INVALID"
        Assert-RestrictedAcl $evidenceDirectory "EVIDENCE_DIRECTORY_INVALID"
        $evidencePath = Join-Path $evidenceDirectory ("incident-admission-{0}-{1}.local.json" -f ([DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")), (Get-RandomNonce).Substring(0, 12))
    }

    $nodeLock = Open-FileLock $nodePath "NODE_EXECUTABLE_INVALID"
    $gitLock = Open-FileLock $gitPath "GIT_EXECUTABLE_INVALID"
    $locks.Add($nodeLock); $locks.Add($gitLock)
    if ($nodeLock.Sha256 -cne $nodeSha256 -or $gitLock.Sha256 -cne $gitSha256) { Throw-SafeError "EXECUTABLE_PIN_MISMATCH" }

    $head = Get-AsciiOutput (Invoke-Git $gitPath $gitSha256 $repository @("rev-parse", "HEAD") 4096).Stdout "HEAD_INVALID"
    if ($head -notmatch '^[0-9a-f]{40}$') { Throw-SafeError "HEAD_INVALID" }
    if (-not $contractMode) {
        $symbolic = Get-AsciiOutput (Invoke-Git $gitPath $gitSha256 $repository @("symbolic-ref", "--quiet", "HEAD") 4096).Stdout "SYMBOLIC_HEAD_INVALID"
        if ($symbolic -notmatch '^refs/heads/[A-Za-z0-9._/-]+$') { Throw-SafeError "SYMBOLIC_HEAD_INVALID" }
        foreach ($controlPath in @(
            (Join-Path $repository ".git/HEAD"),
            (Join-Path $repository ".git/index"),
            (Join-Path (Join-Path $repository ".git") $symbolic)
        )) { $control = Open-FileLock $controlPath "GIT_CONTROL_LOCK_INVALID"; $locks.Add($control) }
    }

    $sourceDefinitions = @(
        @("admissionAdr", "docs/adr/0036-current-stripe-binding-incident-admission.md"),
        @("admissionRunner", "deploy/lightsail/scripts/admit-current-stripe-bindings.sh"),
        @("admissionSchema", "docs/schemas/refunddesk-lightsail-incident-admission-v1.schema.json"),
        @("admissionValidator", "scripts/validate-lightsail-incident-admission.mjs"),
        @("admissionWrapper", "scripts/invoke-lightsail-incident-admission.ps1"),
        @("compose", "deploy/lightsail/compose.yml"),
        @("hostCommand", "deploy/lightsail/scripts/incident-admission-host-command.sh"),
        @("postflightObserver", "deploy/lightsail/scripts/observe-host-postflight.sh"),
        @("postflightSchema", "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json"),
        @("postflightValidator", "scripts/validate-lightsail-postflight.mjs"),
        @("postflightWrapper", "scripts/invoke-lightsail-postflight.ps1"),
        @("promotionRunner", "deploy/lightsail/scripts/promote-contained-candidate.sh"),
        @("promotionSchema", "docs/schemas/refunddesk-lightsail-contained-promotion-v1.schema.json"),
        @("promotionValidator", "scripts/validate-lightsail-contained-promotion.mjs"),
        @("proofClient", "deploy/lightsail/scripts/incident-admission-proof-client.mjs")
    )
    foreach ($definition in $sourceDefinitions) {
        $source = Get-TrackedSourceRecord $definition[0] $definition[1] $repository $head $gitPath $gitSha256 $locks -FixtureOnly:$contractMode
        $sources.Add($source)
    }
    $sourceByName = @{}
    foreach ($source in $sources) { $sourceByName[$source.Name] = $source }
    $validatorPath = $sourceByName.admissionValidator.Worktree.Path

    $promotion = Read-BoundedJsonLock $PromotionEvidencePath $MaximumInputBytes "PROMOTION_EVIDENCE_INVALID"
    $preflight = Read-BoundedJsonLock $PreflightEvidencePath $MaximumInputBytes "PREFLIGHT_EVIDENCE_INVALID"
    $dashboard = Read-BoundedJsonLock $DashboardAttestationPath 32768 "DASHBOARD_ATTESTATION_INVALID"
    $fixture = Read-BoundedJsonLock $FixtureInputPath 16384 "FIXTURE_INPUT_INVALID"
    foreach ($input in @($promotion, $preflight, $dashboard, $fixture)) { $locks.Add($input.Lock) }
    $expectedRevision = [string] $promotion.Value.revision
    if ($expectedRevision -notmatch '^[0-9a-f]{40}$' -or $expectedRevision -cne $head) { Throw-SafeError "PROMOTION_REVISION_MISMATCH" }

    $officialPromotionArguments = @(
        $sourceByName.promotionValidator.Worktree.Path,
        "--evidence", $promotion.Lock.Path,
        "--expected-revision", $expectedRevision,
        "--expected-nonce", [string] $promotion.Value.nonce,
        "--expected-bundle-sha256", [string] $promotion.Value.inputs.bundleSha256,
        "--expected-manifest-sha256", [string] $promotion.Value.inputs.manifestSha256,
        "--expected-provenance-sha256", [string] $promotion.Value.inputs.provenanceSha256,
        "--expected-source-sha256", [string] $promotion.Value.inputs.sourceSha256
    )
    $officialPromotion = Invoke-BoundedProcess $nodePath $nodeSha256 $officialPromotionArguments (New-CleanEnvironment $null) ([byte[]]@()) 30 4096
    if ($officialPromotion.ExitCode -ne 0 -or $officialPromotion.Stderr.Length -ne 0) { Throw-SafeError "PROMOTION_OFFICIAL_VALIDATION_FAILED" }
    $officialPromotionResult = ConvertFrom-ExactJsonBytes $officialPromotion.Stdout "PROMOTION_OFFICIAL_VALIDATION_INVALID"
    Assert-ExactProperties $officialPromotionResult @("code", "evidenceSha256", "kind", "nonce", "result", "revision", "schemaVersion") "PROMOTION_OFFICIAL_VALIDATION_INVALID"
    if ($officialPromotionResult.schemaVersion -ne 1 -or $officialPromotionResult.kind -cne "refunddesk-contained-promotion" -or
        $officialPromotionResult.result -cne "PASS" -or $officialPromotionResult.code -cne "PASS_CONTAINED_CANDIDATE_PROMOTED" -or
        $officialPromotionResult.revision -cne $expectedRevision -or $officialPromotionResult.nonce -cne $promotion.Value.nonce -or
        $officialPromotionResult.evidenceSha256 -cne $promotion.Sha256) {
        Throw-SafeError "PROMOTION_OFFICIAL_VALIDATION_INVALID"
    }
    Assert-LocksUnchanged $sources
    Assert-InputLocksUnchanged @($promotion, $preflight, $dashboard, $fixture)

    [void] (Invoke-Validator "promotion" $promotion.Bytes $nodePath $nodeSha256 $validatorPath $expectedRevision)
    [void] (Invoke-Validator "postflight" $preflight.Bytes $nodePath $nodeSha256 $validatorPath $expectedRevision -FixtureOnly:$contractMode)
    [void] (Invoke-Validator "dashboard" $dashboard.Bytes $nodePath $nodeSha256 $validatorPath "")
    [void] (Invoke-Validator "fixture" $fixture.Bytes $nodePath $nodeSha256 $validatorPath "")
    $bundleArguments = @(
        $validatorPath, "--kind", "bundle", "--dashboard-path", $dashboard.Lock.Path,
        "--expected-revision", $expectedRevision, "--fixture-only", $(if ($contractMode) { "true" } else { "false" }),
        "--fixture-path", $fixture.Lock.Path, "--now", (Get-UtcTimestamp),
        "--postflight-path", $preflight.Lock.Path, "--promotion-path", $promotion.Lock.Path
    )
    $bundle = Invoke-BoundedProcess $nodePath $nodeSha256 $bundleArguments (New-CleanEnvironment $null) ([byte[]]@()) 30 $MaximumRemoteBytes
    if ($bundle.ExitCode -ne 0 -or $bundle.Stderr.Length -ne 0) { Throw-SafeError "BOUND_INPUT_INVALID" }
    Assert-CanonicalDocumentBytes $bundle.Stdout "BOUND_INPUT_INVALID"

    $created = $false
    $mutex = [Threading.Mutex]::new($false, "Local\RefundDeskIncidentAdmission", [ref] $created)
    if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(30))) { Throw-SafeError "TRANSPORT_LOCK_UNAVAILABLE" }
    $nonce = Get-RandomNonce

    $awsBefore = $null
    $awsAfter = $null
    $sshPath = $null
    $sshSha256 = $null
    $sshEnvironment = $null
    $sshBase = $null
    if ($contractMode) {
        $awsBefore = Get-FixtureAwsControl $toolDirectory
    }
    else {
        $awsLock = Open-FileLock $PinnedAwsPath "AWS_EXECUTABLE_INVALID"; $locks.Add($awsLock)
        $sshLock = Open-FileLock $PinnedSshPath "SSH_EXECUTABLE_INVALID"; $locks.Add($sshLock)
        if ($awsLock.Sha256 -cne $PinnedAwsSha256 -or $sshLock.Sha256 -cne $PinnedSshSha256) { Throw-SafeError "EXECUTABLE_PIN_MISMATCH" }
        $identity = Open-FileLock (Join-Path $repository "sandbox-evidence.local/aws/refunddesk-sandbox-lightsail-rsa") "SSH_IDENTITY_INVALID" -RequireRestrictedAcl
        $knownHosts = Open-FileLock (Join-Path $repository "sandbox-evidence.local/aws/known_hosts.refunddesk-sandbox") "KNOWN_HOSTS_INVALID" -RequireRestrictedAcl
        $credentialPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) ".aws/credentials"
        $credentialLock = Open-UnreadFileLock $credentialPath "AWS_CREDENTIALS_INVALID" -RequireRestrictedAcl
        foreach ($transportLock in @($identity, $knownHosts, $credentialLock)) { $locks.Add($transportLock) }
        if ($identity.Sha256 -cne $ExpectedIdentitySha256 -or $knownHosts.Sha256 -cne $ExpectedKnownHostsSha256) {
            Throw-SafeError "TRANSPORT_IDENTITY_INVALID"
        }
        $isolatedHome = New-ExclusiveRestrictedDirectory (Join-Path $evidenceDirectory (".incident-admission-home-{0}" -f $nonce)) "ISOLATED_HOME_INVALID"
        $isolatedConfigPath = New-RestrictedAsciiFile (Join-Path $isolatedHome "aws-config") "[default]`ncli_pager =`noutput = json`nregion = eu-west-3`n" "AWS_CONFIG_INVALID"
        $isolatedConfigLock = Open-FileLock $isolatedConfigPath "AWS_CONFIG_INVALID" -RequireRestrictedAcl
        $locks.Add($isolatedConfigLock)
        Assert-IsolatedTransportHome $isolatedHome $isolatedConfigLock "ISOLATED_HOME_INVALID"
        $awsEnvironment = New-CleanEnvironment ([ordered]@{
            AWS_CONFIG_FILE = $isolatedConfigLock.Path
            AWS_DEFAULT_REGION = $ExpectedAwsRegion
            AWS_EC2_METADATA_DISABLED = "true"
            AWS_PAGER = ""
            AWS_PROFILE = "default"
            AWS_REGION = $ExpectedAwsRegion
            AWS_SHARED_CREDENTIALS_FILE = $credentialLock.Path
            HOME = $isolatedHome
            PROGRAMDATA = $isolatedHome
            USERPROFILE = $isolatedHome
        })
        $awsBefore = Get-ProductionAwsControl $PinnedAwsPath $PinnedAwsSha256 $awsEnvironment $ExpectedSshCidr $isolatedHome $isolatedConfigLock
        $sshPath = $PinnedSshPath
        $sshSha256 = $PinnedSshSha256
        $sshEnvironment = New-CleanEnvironment ([ordered]@{
            HOME = $isolatedHome
            PROGRAMDATA = $isolatedHome
            USERPROFILE = $isolatedHome
        })
        $sshBase = @(
            "-F", "NUL", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
            "-o", "KbdInteractiveAuthentication=no", "-o", "PreferredAuthentications=publickey",
            "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "GSSAPIAuthentication=no",
            "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=$($knownHosts.Path)",
            "-o", "GlobalKnownHostsFile=NUL", "-o", "CheckHostIP=yes", "-o", "UpdateHostKeys=no",
            "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no",
            "-o", "ConnectTimeout=15", "-i", $identity.Path, "ubuntu@$($awsBefore.PublicIpAddress)"
        )
    }

    Assert-LocksUnchanged $sources
    Assert-InputLocksUnchanged @($promotion, $preflight, $dashboard, $fixture)
    if ($contractMode) {
        $remoteInvocationStarted = $true
        $remoteFixture = Read-BoundedJsonLock (Join-Path $toolDirectory "remote-admission.fixture.json") $MaximumRemoteBytes "REMOTE_FIXTURE_INVALID"
        $locks.Add($remoteFixture.Lock)
        $remoteBytes = $remoteFixture.Bytes
        $remoteExit = [int] $remoteFixture.Value.exitCode
    }
    else {
        $remoteStage = "/run/refunddesk/incident-admission-$nonce"
        $createCommand = "sudo --non-interactive -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /bin/bash --noprofile --norc -c 'umask 077; [[ ! -e `"$remoteStage`" && ! -L `"$remoteStage`" ]] && /usr/bin/install -d -o root -g root -m 0700 `"$remoteStage`"'"
        $stage = Invoke-IsolatedTransportProcess $sshPath $sshSha256 ($sshBase + @($createCommand)) $sshEnvironment ([byte[]]@()) 90 1 $isolatedHome $isolatedConfigLock
        if ($stage.ExitCode -ne 0 -or $stage.Stdout.Length -ne 0 -or $stage.Stderr.Length -ne 0) { Throw-SafeError "REMOTE_STAGE_CREATE_FAILED" }
        $uploads = @(
            @($sourceByName.admissionRunner, "runner.sh", "0700"),
            @($sourceByName.admissionValidator, "validator.mjs", "0600"),
            @($sourceByName.hostCommand, "host-command.sh", "0700"),
            @($sourceByName.promotionValidator, "promotion-validator.mjs", "0600"),
            @($sourceByName.proofClient, "proof-client.mjs", "0600")
        )
        foreach ($upload in $uploads) {
            $uploadBytes = Read-LockedBytes $upload[0].Worktree 4194304 "PINNED_SOURCE_INVALID"
            Invoke-RemoteUpload $sshPath $sshSha256 $sshBase $sshEnvironment $uploadBytes $upload[0].Record.sha256 "$remoteStage/$($upload[1])" $upload[2] $isolatedHome $isolatedConfigLock
        }
        Assert-LocksUnchanged $sources
        Assert-InputLocksUnchanged @($promotion, $preflight, $dashboard, $fixture)
        $runnerCommand = "sudo --non-interactive -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /bin/bash '$remoteStage/runner.sh' --nonce '$nonce' --expected-revision '$expectedRevision' --repository-head '$head' --runner-sha256 '$($sourceByName.admissionRunner.Record.sha256)' --promotion-sha256 '$($promotion.Sha256)' --postflight-sha256 '$($preflight.Sha256)' --dashboard-sha256 '$($dashboard.Sha256)' --fixture-sha256 '$($fixture.Sha256)' --validator-path '$remoteStage/validator.mjs' --validator-sha256 '$($sourceByName.admissionValidator.Record.sha256)' --host-command-path '$remoteStage/host-command.sh' --host-command-sha256 '$($sourceByName.hostCommand.Record.sha256)' --proof-client-path '$remoteStage/proof-client.mjs' --proof-client-sha256 '$($sourceByName.proofClient.Record.sha256)' --compose-sha256 '$($sourceByName.compose.Record.sha256)' --promotion-validator-path '$remoteStage/promotion-validator.mjs' --promotion-validator-sha256 '$($sourceByName.promotionValidator.Record.sha256)'"
        $remoteInvocationStarted = $true
        $remoteRun = Invoke-IsolatedTransportProcess $sshPath $sshSha256 ($sshBase + @($runnerCommand)) $sshEnvironment $bundle.Stdout 650 $MaximumRemoteBytes $isolatedHome $isolatedConfigLock
        if (@(0, 20, 21, 64) -notcontains $remoteRun.ExitCode -or $remoteRun.Stderr.Length -ne 0) { Throw-SafeError "REMOTE_EXECUTION_INVALID" }
        if ($remoteRun.ExitCode -eq 64) { Throw-SafeError "REMOTE_USAGE_INVALID" }
        $remoteBytes = $remoteRun.Stdout
        $remoteExit = $remoteRun.ExitCode
    }

    $validatedRemote = Invoke-Validator "admission" $remoteBytes $nodePath $nodeSha256 $validatorPath $expectedRevision -AllowedExitCodes @(0, 20, 21)
    $remote = ConvertFrom-ExactJsonBytes $validatedRemote.Stdout "REMOTE_DOCUMENT_INVALID"
    if ([int] $remote.exitCode -ne $remoteExit -or $remote.repositoryHead -cne $head -or
        $remote.promotion.evidenceSha256 -cne $promotion.Sha256) { Throw-SafeError "REMOTE_DOCUMENT_BINDING_INVALID" }
    $remoteCompletedAt = Parse-UtcTimestamp ([string] $remote.completedAt) "REMOTE_COMPLETION_TIME_INVALID"
    $dashboardCapturedAt = Parse-UtcTimestamp ([string] $dashboard.Value.containmentCapturedAt) "DASHBOARD_TIME_INVALID"
    $dashboardUntil = Parse-UtcTimestamp ([string] $dashboard.Value.containmentValidUntil) "DASHBOARD_TIME_INVALID"
    if ($remoteCompletedAt -lt $dashboardCapturedAt -or $remoteCompletedAt -gt $dashboardUntil) {
        Throw-SafeError "DASHBOARD_AUTHORITY_NOT_CONSUMED_IN_WINDOW"
    }
    $remoteCompleted = $true

    if ($contractMode -and $contractFailure -in @("remote-cleanup-fail", "remote-cleanup-hang", "remote-cleanup-ambiguous")) {
        Throw-SafeError "REMOTE_STAGE_CLEANUP_FAILED"
    }

    if (-not $contractMode) {
        $cleanupCommand = "sudo --non-interactive -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /usr/bin/find '$remoteStage' -xdev -depth -delete"
        $cleanup = Invoke-IsolatedTransportProcess $sshPath $sshSha256 ($sshBase + @($cleanupCommand)) $sshEnvironment ([byte[]]@()) 120 1 $isolatedHome $isolatedConfigLock
        if ($cleanup.ExitCode -ne 0 -or $cleanup.Stdout.Length -ne 0 -or $cleanup.Stderr.Length -ne 0) {
            Throw-SafeError "REMOTE_STAGE_CLEANUP_FAILED"
        }
        $cleanupControlCommand = "sudo --non-interactive -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C TZ=UTC /usr/bin/test ! -e '$remoteStage'"
        $cleanupControl = Invoke-IsolatedTransportProcess $sshPath $sshSha256 ($sshBase + @($cleanupControlCommand)) $sshEnvironment ([byte[]]@()) 60 1 $isolatedHome $isolatedConfigLock
        if ($cleanupControl.ExitCode -ne 0 -or $cleanupControl.Stdout.Length -ne 0 -or $cleanupControl.Stderr.Length -ne 0) {
            Throw-SafeError "REMOTE_STAGE_CLEANUP_UNPROVED"
        }
        $remoteStageCleaned = $true
    }

    if ($contractMode -and $contractFailure -ceq "aws-after") { Throw-SafeError "AWS_CONTROL_FAILED" }
    if ($contractMode) { $awsAfter = Get-FixtureAwsControl $toolDirectory }
    else { $awsAfter = Get-ProductionAwsControl $PinnedAwsPath $PinnedAwsSha256 $awsEnvironment $ExpectedSshCidr $isolatedHome $isolatedConfigLock }
    if ($awsAfter.Digest -cne $awsBefore.Digest) { Throw-SafeError "AWS_FIREWALL_CHANGED" }
    if (-not $contractMode) { Assert-UnreadFileLock $credentialLock "AWS_CREDENTIALS_CHANGED" }

    Assert-LocksUnchanged $sources
    Assert-InputLocksUnchanged @($promotion, $preflight, $dashboard, $fixture)
    if ($contractMode -and $contractFailure -ceq "final-postflight") { Throw-SafeError "FINAL_POSTFLIGHT_INVOCATION_FAILED" }
    $finalPostflight = Invoke-FormalFinalPostflight $repository $expectedRevision $ExpectedSshCidr $nodePath $nodeSha256 $validatorPath ([string] $remote.completedAt) $toolDirectory $evidenceDirectory -FixtureOnly:$contractMode
    $locks.Add($finalPostflight.Lock)
    $finalCandidateBinding = Get-VerifiedFinalCandidateBinding $finalPostflight.Value $promotion.Value
    $postIncidentBaseline = Get-PostIncidentBaselineFromPostflight $finalPostflight.Value
    if ([int] $remote.exitCode -eq 0) {
        Assert-PostIncidentBaselineEqual $remote.postIncidentBaseline $postIncidentBaseline
    }

    # The human authority was admitted before the effect and consumed by the
    # terminal remote operation before its exact expiry. Re-run the originally
    # timestamped bundle validation over unchanged locked bytes; later capture
    # validity comes only from the fresh independent contained postflight.
    $bundleControl = Invoke-BoundedProcess $nodePath $nodeSha256 $bundleArguments (New-CleanEnvironment $null) ([byte[]]@()) 30 $MaximumRemoteBytes
    if ($bundleControl.ExitCode -ne 0 -or $bundleControl.Stderr.Length -ne 0) { Throw-SafeError "BOUND_INPUT_EXPIRED" }
    Assert-LocksUnchanged $sources
    Assert-InputLocksUnchanged @($promotion, $preflight, $dashboard, $fixture)
    if ($contractMode -and $contractFailure -ceq "source-race") { Throw-SafeError "CAPTURE_CHANGED" }

    $now = [DateTime]::UtcNow
    $finalUntil = Parse-UtcTimestamp $finalPostflight.ValidUntil "FINAL_POSTFLIGHT_TIME_INVALID"
    $localWindow = Resolve-LocalCaptureWindow $now $dashboardUntil $finalUntil ([int] $remote.exitCode) ([string] $remote.result) ([string] $remote.code)
    $localUntil = $localWindow.ValidUntil
    $localExitCode = $localWindow.ExitCode
    $localResult = $localWindow.Result
    $localCode = $localWindow.Code

    if (-not $contractMode) {
        if (-not $remoteStageCleaned) { Throw-SafeError "REMOTE_STAGE_CLEANUP_UNPROVED" }
        Remove-IsolatedTransportHome $isolatedHome $isolatedConfigLock "ISOLATED_HOME_CLEANUP_FAILED"
        $isolatedConfigLock = $null
        $isolatedConfigPath = $null
        $isolatedHome = $null
    }

    $sourceEvidence = [ordered]@{}
    foreach ($source in @($sources | Sort-Object Name)) { $sourceEvidence[$source.Name] = $source.Record }
    $result = $localResult
    $code = $localCode
    $admission = if ($contractMode) { "FIXTURE_ONLY" } elseif ($localExitCode -eq 0) { "ADMISSIBLE_CURRENT_STRIPE_BINDING_INCIDENT" } else { "NOT_ADMITTED" }
    $capture = [ordered]@{
        admission = $admission
        awsControlPlane = [ordered]@{
            accountMatches = $true
            firewallClosedAfter = $true
            firewallClosedBefore = $true
            firewallUnchanged = $true
            instanceMatches = $true
            regionMatches = $true
            targetId = "$ExpectedInstanceName@$ExpectedAwsRegion"
        }
        capturedAt = $now.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
        code = $code
        exitCode = $localExitCode
        finalPostflight = [ordered]@{
            awsControlPlane = $finalPostflight.Value.awsControlPlane
            candidateBinding = $finalCandidateBinding
            capturedAt = $finalPostflight.CapturedAt
            firewallClosed = $true
            officialValidation = $true
            postIncidentBaselineSha256 = $postIncidentBaseline.snapshotSha256
            posture = "COHERENT_CONTAINED"
            provenance = $finalPostflight.Value.provenance
            revision = $expectedRevision
            sha256 = $finalPostflight.Sha256
            validUntil = $finalPostflight.ValidUntil
            workerRuntimeMode = "incident_admission"
        }
        kind = "refunddesk.lightsail.incident-admission.capture"
        postIncidentBaseline = $postIncidentBaseline
        provenance = [ordered]@{
            dashboardAttestationSha256 = $dashboard.Sha256
            fixtureInputSha256 = $fixture.Sha256
            fixtureOnly = $contractMode
            postflightBeforeSha256 = $preflight.Sha256
            promotionEvidenceSha256 = $promotion.Sha256
            repositoryHead = $head
            sources = $sourceEvidence
            transportInputsPinned = $true
        }
        redaction = [ordered]@{
            arbitraryPathPresent = $false
            customerDataPresent = $false
            ipAddressPresent = $false
            keyDigestPresent = $false
            rawApiKeyPresent = $false
            rawPayloadPresent = $false
            rawSecretPresent = $false
            rawSignaturePresent = $false
            stderrPresent = $false
            stripeIdentifierPresent = $false
        }
        remote = $remote
        remoteDocument = [ordered]@{
            exitCode = [int] $remote.exitCode
            sha256 = Get-Sha256Hex $remoteBytes
        }
        result = $result
        schemaVersion = 1
        validUntil = $localUntil.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    }
    $captureText = ($capture | ConvertTo-Json -Compress -Depth 100)
    if ($captureText -match '\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b' -or
        $captureText -match '\b(?:whsec|absec)_[A-Za-z0-9_]{12,}\b' -or
        $captureText -match '-----BEGIN .*PRIVATE KEY-----' -or
        $captureText -match '"(?:[A-Za-z]:\\|\\\\|/(?:etc|home|opt|run|tmp|var)/)' -or
        $captureText -match '\b(?:acct|ch|evt|pi|re|req|usr)_[A-Za-z0-9_]{6,}\b' -or
        $captureText -match '(?:^|[^0-9])(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}(?:[^0-9]|$)') {
        Throw-SafeError "EVIDENCE_REDACTION_FAILED"
    }
    $candidateCaptureBytes = [Text.UTF8Encoding]::new($false).GetBytes("$captureText`n")
    $expectedPromotionBinding = [pscustomobject]@{
        bundleSha256 = [string] $promotion.Value.inputs.bundleSha256
        evidenceSha256 = $promotion.Sha256
        manifestSha256 = [string] $promotion.Value.inputs.manifestSha256
        provenanceSha256 = [string] $promotion.Value.inputs.provenanceSha256
        sourceSha256 = [string] $promotion.Value.inputs.sourceSha256
    }
    $captureValidation = Invoke-Validator "capture" $candidateCaptureBytes $nodePath $nodeSha256 $validatorPath $expectedRevision -FixtureOnly:$contractMode -ExpectedPromotion $expectedPromotionBinding -AllowedExitCodes @(0, 20, 21)
    $captureBytes = $captureValidation.Stdout
    $exitCode = $localExitCode
    if ($contractMode -and $contractFailure -ceq "evidence-create-new") { Throw-SafeError "EVIDENCE_CREATE_NEW_FAILED" }
    Write-EvidenceCreateNew $evidencePath $captureBytes
    $artifactCommitted = $true
}
catch {
    $code = "INTERNAL_ERROR"
    if ($_.Exception.Message -match '^REFUNDDESK_([A-Z][A-Z0-9_]{0,63})$') { $code = $Matches[1] }
    [Console]::Error.WriteLine("incident-admission-error:{0}" -f $code)
    if ($remoteInvocationStarted -and -not $artifactCommitted -and $null -eq $finalPostflight) {
        try {
            $controlTime = if ($remoteCompleted -and $null -ne $remote) { [string] $remote.completedAt } else { Get-UtcTimestamp }
            $control = Invoke-FormalFinalPostflight $repository $expectedRevision $ExpectedSshCidr $nodePath $nodeSha256 $validatorPath $controlTime $toolDirectory $evidenceDirectory -FixtureOnly:$contractMode
            if ($null -ne $control -and $null -ne $control.Lock) { $locks.Add($control.Lock) }
        }
        catch {
            # The independently retained postflight artifact is the diagnostic;
            # transport ambiguity remains exit 1 and the nonce-bound stage stays intact.
        }
    }
    if (-not $artifactCommitted) { $exitCode = 1 }
}
finally {
    if ($null -ne $isolatedHome -and $null -ne $isolatedConfigLock) {
        try { Remove-IsolatedTransportHome $isolatedHome $isolatedConfigLock "ISOLATED_HOME_CLEANUP_FAILED" }
        catch { if (-not $artifactCommitted) { $exitCode = 1 } }
    }
    foreach ($lock in $locks) { if ($null -ne $lock -and $null -ne $lock.Stream) { try { $lock.Stream.Dispose() } catch { } } }
    if ($null -ne $mutex) { try { $mutex.ReleaseMutex() } catch { }; $mutex.Dispose() }
}
exit $exitCode
