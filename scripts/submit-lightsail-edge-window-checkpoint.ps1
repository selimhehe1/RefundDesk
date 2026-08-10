[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $RequestPath,
    [Parameter(Mandatory = $true)][string] $CheckpointPath,
    [Parameter(Mandatory = $true)][ValidateRange(100, 599)][int] $HttpStatus,
    [Parameter(Mandatory = $true)][bool] $Duplicate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Fail([string] $Code) { throw [InvalidOperationException]::new("REFUNDDESK_$Code") }
function Canonical([Collections.IDictionary] $Value) { return (($Value | ConvertTo-Json -Compress -Depth 8) + "`n") }
function Sha256([byte[]] $Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function StrictUtc([string] $Value) {
    try {
        return [DateTime]::ParseExact($Value, "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    }
    catch { Fail "TIMESTAMP_INVALID" }
}
function Get-SidValue($Identity) {
    try { return $Identity.Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { Fail "CHECKPOINT_PARENT_ACL_INVALID" }
}
function Assert-NoReparsePath([string] $Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if ([IO.Directory]::Exists($current) -or [IO.File]::Exists($current)) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail "CHECKPOINT_PARENT_INVALID"
            }
        }
        $next = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($next) -or $next -ceq $current) { break }
        $current = $next
    }
}
function Assert-ExactAcl($Acl, [bool] $Directory, [string] $Code) {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowed = @(
        $current.Value,
        ([Security.Principal.SecurityIdentifier]::new("S-1-5-18")).Value,
        ([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")).Value
    )
    try { $ownerSid = $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value }
    catch { Fail $Code }
    if (-not $Acl.AreAccessRulesProtected -or $ownerSid -cne $current.Value) { Fail $Code }
    $rules = @($Acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) { Fail $Code }
    $seen = @{}
    $expectedInheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($rule in $rules) {
        $sid = Get-SidValue $rule.IdentityReference
        if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $allowed -notcontains $sid -or $seen.ContainsKey($sid) -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne $expectedInheritance -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            Fail $Code
        }
        $seen[$sid] = $true
    }
    if ($seen.Count -ne 3) { Fail $Code }
}
function Assert-StrictParent([string] $Path) {
    $parent = [IO.Path]::GetFullPath((Split-Path -Parent $Path))
    if (-not [IO.Directory]::Exists($parent)) { Fail "CHECKPOINT_PARENT_INVALID" }
    Assert-NoReparsePath $parent
    Assert-ExactAcl (Get-Acl -LiteralPath $parent) $true "CHECKPOINT_PARENT_ACL_INVALID"
    return $parent
}

try {
    $request = [IO.Path]::GetFullPath($RequestPath)
    $checkpoint = [IO.Path]::GetFullPath($CheckpointPath)
    if (-not [IO.File]::Exists($request) -or [IO.File]::Exists($checkpoint)) { Fail "CHECKPOINT_STATE_INVALID" }
    $checkpointParent = Assert-StrictParent $checkpoint
    $requestStream = [IO.FileStream]::new($request, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($requestStream.Length -le 0 -or $requestStream.Length -gt 16384) { Fail "REQUEST_INVALID" }
        $requestBytes = New-Object byte[] ([int] $requestStream.Length)
        $offset = 0
        while ($offset -lt $requestBytes.Length) {
            $read = $requestStream.Read($requestBytes, $offset, $requestBytes.Length - $offset)
            if ($read -le 0) { Fail "REQUEST_INVALID" }
            $offset += $read
        }
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $requestText = $utf8.GetString($requestBytes)
        try { $document = $requestText | ConvertFrom-Json }
        catch { Fail "REQUEST_INVALID" }
        $expectedRequest = [ordered]@{
            deadlineAt = [string] $document.deadlineAt
            eventFingerprintSha256 = [string] $document.eventFingerprintSha256
            expectedRevision = [string] $document.expectedRevision
            kind = [string] $document.kind
            nonce = [string] $document.nonce
            openedAt = [string] $document.openedAt
            schemaVersion = [int] $document.schemaVersion
        }
        if ((Canonical $expectedRequest) -cne $requestText -or $document.kind -cne "refunddesk.operator-workbench-request" -or
            $document.schemaVersion -ne 1 -or $document.nonce -notmatch "^[0-9a-f]{64}$" -or
            $document.expectedRevision -notmatch "^[0-9a-f]{40}$" -or
            $document.eventFingerprintSha256 -notmatch "^[0-9a-f]{64}$") { Fail "REQUEST_INVALID" }
        $captured = [DateTime]::UtcNow
        if ($captured -lt (StrictUtc ([string] $document.openedAt)) -or
            $captured -gt (StrictUtc ([string] $document.deadlineAt))) { Fail "CHECKPOINT_OUTSIDE_WINDOW" }
        if ($HttpStatus -ne 200 -or -not $Duplicate) { Fail "WORKBENCH_RESULT_INVALID" }
        $checkpointDocument = [ordered]@{
            capturedAt = $captured.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
            cliUsed = $false
            duplicate = $true
            eventFingerprintSha256 = [string] $document.eventFingerprintSha256
            expectedRevision = [string] $document.expectedRevision
            httpStatus = 200
            kind = "refunddesk.operator-workbench-replay"
            nonce = [string] $document.nonce
            receiver = "REFUNDDESK_CREATE_NEW_V1"
            requestSha256 = Sha256 $requestBytes
            schemaVersion = 1
            source = "OPERATOR_WORKBENCH"
        }
        $bytes = $utf8.GetBytes((Canonical $checkpointDocument))
        if ((Assert-StrictParent $checkpoint) -cne $checkpointParent -or [IO.File]::Exists($checkpoint)) {
            Fail "CHECKPOINT_STATE_INVALID"
        }
        $stream = [IO.FileStream]::new($checkpoint, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
            [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        $security = [Security.AccessControl.FileSecurity]::new()
        $security.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
        $security.SetAccessRuleProtection($true, $false)
        foreach ($sid in @(
            [Security.Principal.WindowsIdentity]::GetCurrent().User,
            [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
            [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
        )) {
            $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow))
        }
        Set-Acl -LiteralPath $checkpoint -AclObject $security
        Assert-NoReparsePath $checkpoint
        Assert-ExactAcl (Get-Acl -LiteralPath $checkpoint) $false "CHECKPOINT_ACL_INVALID"
        [Console]::Out.WriteLine([IO.Path]::GetFileName($checkpoint))
    }
    finally { $requestStream.Dispose() }
}
catch {
    $code = if ($_.Exception.Message -match "^REFUNDDESK_([A-Z0-9_]+)$") { $Matches[1] } else { "CHECKPOINT_SUBMISSION_FAILED" }
    [Console]::Error.WriteLine("edge-window-checkpoint-error:$code")
    exit 20
}
