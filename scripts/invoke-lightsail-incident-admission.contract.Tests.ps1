[CmdletBinding()]
param(
    [Parameter()]
    [switch] $IntentionalFailure
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Assert-Contract {
    param(
        [Parameter(Mandatory = $true)][bool] $Condition,
        [Parameter(Mandatory = $true)][string] $Code
    )
    if (-not $Condition) { throw "contract-assertion-failed:$Code" }
}

if ($IntentionalFailure) {
    Assert-Contract -Condition $false -Code "intentional-nonzero-probe"
}

$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Wrapper = Join-Path $PSScriptRoot "invoke-lightsail-incident-admission.ps1"
$Validator = Join-Path $PSScriptRoot "validate-lightsail-incident-admission.mjs"
$PowerShell = (Get-Process -Id $PID).Path
$ExpectedRevision = (& git -C $Repository rev-parse HEAD).Trim()
$Hex = [ordered]@{
    a = "a" * 64
    b = "b" * 64
    c = "c" * 64
    d = "d" * 64
    e = "e" * 64
    f = "f" * 64
}

function Set-RestrictedAcl {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][bool] $Directory
    )
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $sids = @(
        $currentSid,
        [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
        [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    )
    if ($Directory) {
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($currentSid)
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        foreach ($sid in $sids) {
            [void] $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow
            ))
        }
        [IO.Directory]::SetAccessControl($Path, $security)
    }
    else {
        $security = [Security.AccessControl.FileSecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($currentSid)
        foreach ($sid in $sids) {
            [void] $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow
            ))
        }
        [IO.File]::SetAccessControl($Path, $security)
    }
}

function ConvertTo-RecursivelySortedValue {
    param([AllowNull()] $Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [Collections.IDictionary]) {
        $sorted = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) {
            $sorted[$key] = ConvertTo-RecursivelySortedValue -Value $Value[$key]
        }
        return $sorted
    }
    if ($Value -is [Array]) {
        $items = @($Value | ForEach-Object { ConvertTo-RecursivelySortedValue -Value $_ })
        return ,$items
    }
    return $Value
}

function Write-CanonicalRestrictedJson {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)] $Value
    )
    $sorted = ConvertTo-RecursivelySortedValue -Value $Value
    $text = ($sorted | ConvertTo-Json -Compress -Depth 100) + [char] 10
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
    Set-RestrictedAcl -Path $Path -Directory $false
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string] $Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $stream.Dispose() }
    }
    finally { $algorithm.Dispose() }
}

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][string] $Value)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

function New-Redaction {
    return [ordered]@{
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
}

function New-PostflightSource {
    return [ordered]@{ gitObject = $null; sha256 = $Hex.a }
}

function New-PostIncidentBaseline {
    return [ordered]@{
        activeFinancialJobs = 0
        auditEvents = 12
        mutationReceipts = 4
        refundExecutionAttempts = 2
        refundExecutions = 2
        refundRequests = 3
        snapshotSha256 = "1d75c67f621c244b5f069ca9210d0546d6575e6487af52950a6cd9ad2ae59cb3"
        unreleasedPaymentGuards = 0
        webhookReceipts = 0
    }
}

function New-PostIncidentDatabase {
    return [ordered]@{
        activeFinancialJobs = 0
        activeWorkflows = 0
        apiMutationReceipts = 4
        auditEvents = 12
        liveInstallations = 0
        liveTenants = 0
        preparedTransactions = 0
        refundExecutionAttempts = 2
        refundExecutions = 2
        refundRequests = 3
        snapshotAvailable = $true
        systemIdentifier = "123456789012345678"
        unreleasedPaymentGuards = 0
        webhookReceipts = 0
    }
}

function New-Postflight {
    param(
        [Parameter(Mandatory = $true)][string] $CapturedAt,
        [Parameter(Mandatory = $true)][string] $ValidUntil
    )
    $identity = [ordered]@{
        activeRevision = $ExpectedRevision
        currentRevision = $ExpectedRevision
        releaseEnvironmentRevision = $ExpectedRevision
        releaseEnvironmentWorkerRuntimeMode = "INCIDENT_ADMISSION"
        sourceRevision = $ExpectedRevision
    }
    $containers = @(
        [ordered]@{ containerId = $Hex.b; effectiveWorkerRuntimeMode = $null; service = "postgres" },
        [ordered]@{ containerId = $Hex.c; effectiveWorkerRuntimeMode = $null; service = "verifier" },
        [ordered]@{ containerId = $Hex.e; effectiveWorkerRuntimeMode = "INCIDENT_ADMISSION"; service = "worker" },
        [ordered]@{ containerId = $Hex.d; effectiveWorkerRuntimeMode = $null; service = "web" },
        [ordered]@{ containerId = $Hex.a; effectiveWorkerRuntimeMode = $null; service = "caddy" }
    )
    return [ordered]@{
        admission = "FIXTURE_ONLY"
        awsControlPlane = [ordered]@{
            accountMatches = $true
            firewallClosedAfter = $true
            firewallClosedBefore = $true
            firewallUnchanged = $true
            instanceMatches = $true
            instanceRunning = $true
            regionMatches = $true
            targetId = "refunddesk-sandbox-paris@eu-west-3"
        }
        capturedAt = $CapturedAt
        kind = "refunddesk.lightsail.host-postflight.capture"
        posture = "COHERENT_CONTAINED"
        provenance = [ordered]@{
            fixtureOnly = $true
            observer = New-PostflightSource
            remoteDocumentSha256 = $Hex.f
            repositoryHead = $null
            revisionComposeVerified = $true
            schema = New-PostflightSource
            transportInputsPinned = $true
            validator = New-PostflightSource
            wrapper = New-PostflightSource
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
        }
        remote = [ordered]@{
            captures = [ordered]@{
                a = [ordered]@{ containers = $containers; database = New-PostIncidentDatabase; identity = $identity }
                b = [ordered]@{ containers = $containers; database = New-PostIncidentDatabase; identity = $identity }
            }
            code = "PASS_CONTAINED"
            containment = [ordered]@{
                caddyStopped = $true
                fenceClosed = $true
                journalsClosed = $true
                liveDisabled = $true
                maintenanceStopped = $true
                publicListenersClosed = $true
                sensitiveModesSafe = $true
                workerStopped = $true
            }
            financial = [ordered]@{ quiescent = $true; snapshotAvailable = $true; stable = $true }
            posture = "COHERENT_CONTAINED"
            result = "PASS"
        }
        result = "PASS"
        schemaVersion = 1
        validUntil = $ValidUntil
    }
}

function New-Promotion {
    param(
        [Parameter(Mandatory = $true)][string] $StartedAt,
        [Parameter(Mandatory = $true)][string] $CompletedAt
    )
    return [ordered]@{
        code = "PASS_CONTAINED_CANDIDATE_PROMOTED"
        completedAt = $CompletedAt
        containment = [ordered]@{
            caddyStopped = $true
            liveDisabled = $true
            maintenanceDisabled = $true
            maintenanceStopped = $true
            publicListenersAbsent = $true
            timersDisabled = $true
            verifierHealthy = $true
            webHealthy = $true
            workerStopped = $true
        }
        database = [ordered]@{
            activeFinancialJobs = 0
            activeWorkflows = 0
            apiMutationReceipts = 2
            auditEvents = 9
            liveInstallations = 0
            liveTenants = 0
            preparedTransactions = 0
            refundExecutionAttempts = 1
            refundExecutions = 1
            refundRequests = 2
            snapshotSha256 = "d4bfa0dcf30dcf089eedd822c8abcf3493445414e844f771ad8caf6a33400c41"
            stable = $true
            systemIdentifier = "123456789012345678"
            unreleasedPaymentGuards = 0
            webhookReceipts = 0
        }
        fromRevision = "0" * 40
        inputs = [ordered]@{
            bundleSha256 = $Hex.b
            manifestSha256 = $Hex.c
            provenanceSha256 = $Hex.d
            sourceSha256 = $Hex.e
        }
        kind = "refunddesk-contained-promotion"
        nonce = $Hex.f
        operationStartedAt = $StartedAt
        phase = "complete"
        redaction = [ordered]@{
            customerDataPresent = $false
            rawApiKeyPresent = $false
            rawPayloadPresent = $false
            rawSecretPresent = $false
            rawSignaturePresent = $false
            stderrPresent = $false
        }
        result = "PASS"
        resumed = $false
        revision = $ExpectedRevision
        runtime = [ordered]@{
            caddyContainerId = $Hex.a
            postgresContainerId = $Hex.b
            verifierContainerId = $Hex.c
            webContainerId = $Hex.d
            workerContainerId = $Hex.e
            workerRuntimeMode = "incident_admission"
        }
        schemaVersion = 1
        startedAt = $StartedAt
    }
}

function New-Dashboard {
    param(
        [Parameter(Mandatory = $true)][string] $CapturedAt,
        [Parameter(Mandatory = $true)][string] $ValidUntil
    )
    return [ordered]@{
        accountFingerprints = [ordered]@{ managedSandbox = "sha256:$($Hex.a)"; platformTest = "sha256:$($Hex.b)" }
        activityReview = [ordered]@{
            apiRequestsReviewed = $true
            dashboardActivityReviewed = $true
            reviewedThrough = $CapturedAt
            unexpectedActivity = $false
        }
        candidateFingerprints = [ordered]@{
            managedSandboxEffect = "sha256:$($Hex.d)"
            managedSandboxRead = "sha256:$($Hex.c)"
            stripeAppSigning = "sha256:$($Hex.e)"
        }
        containment = [ordered]@{
            caddyStopped = $true
            liveDisabled = $true
            maintenanceStopped = $true
            portsClosed = $true
            workerStopped = $true
        }
        containmentCapturedAt = $CapturedAt
        containmentValidUntil = $ValidUntil
        credentialRecords = [ordered]@{
            exposedFullAccessTest = [ordered]@{ recordSha256 = "sha256:$('1' * 64)"; state = "revoked" }
            managedSandboxEffect = [ordered]@{ recordSha256 = "sha256:$('2' * 64)"; state = "revoked" }
            managedSandboxRead = [ordered]@{ recordSha256 = "sha256:$('3' * 64)"; state = "revoked" }
            stripeAppSigning = [ordered]@{ recordSha256 = "sha256:$('4' * 64)"; state = "revoked" }
            unintendedPlatformLiveCli = [ordered]@{ recordSha256 = "sha256:$('5' * 64)"; state = "deleted" }
            unintendedPlatformTestCli = [ordered]@{ recordSha256 = "sha256:$('6' * 64)"; state = "deleted" }
        }
        exposedFingerprints = [ordered]@{
            managedSandboxEffect = "sha256:25ce0da57b94ad8b1ad76cf0b4e7a6bdd76151cd0ca007dca68e17063d6d1bcf"
            managedSandboxRead = "sha256:ebfdf77852f715252845466e2c24a791670cb6a5443e8b9c052dde6950dc7626"
            stripeAppSigning = "sha256:b4e042f041ff39315b1378a386817af405788f82ac27b962c2876e508ea09156"
        }
        kind = "refunddesk.stripe.dashboard-incident-attestation"
        redaction = New-Redaction
        replacementRows = [ordered]@{
            managedSandboxEffect = [ordered]@{
                active = $true
                chargesRead = $true
                customersRead = $false
                fullAccess = $false
                paymentIntentsRead = $true
                refundsCreate = $true
                refundsRead = $true
                restricted = $true
                unrelatedPermissionCount = 0
            }
            managedSandboxRead = [ordered]@{
                active = $true
                chargesRead = $true
                customersRead = $false
                fullAccess = $false
                paymentIntentsRead = $true
                refundsCreate = $false
                refundsRead = $true
                restricted = $true
                unrelatedPermissionCount = 0
            }
            stripeAppSigning = [ordered]@{ active = $true; current = $true; predecessorDisabled = $true }
        }
        revocation = [ordered]@{
            exposedFullAccessTest = $true
            exposedManagedSandboxEffect = $true
            exposedManagedSandboxRead = $true
            exposedStripeAppSigning = $true
            unintendedPlatformLiveCliDeleted = $true
            unintendedPlatformTestCliDeleted = $true
        }
        schemaVersion = 1
        sourceEvidence = [ordered]@{
            apiKeyExposure = "sha256:791c2832500e59b5147e09add7d429e1c871f92e06f73432559156c0d22f9d2f"
            appSigningExposure = "sha256:ab29955376fea135f14646c7b7dcdd512449d1abbd3645c9befaea9246b7395b"
            candidatePreflight = "sha256:ec07ef8b14fee601f7339bf8a3837dee0ba3817601fa8330486e758eab10e606"
            cliAuthentication = "sha256:d51f557fd8f76af871d4a5019eac8e00e4ed465ed487afd05ac6750877ac9da7"
            independentReview = "sha256:613f868c80e52b834b7fe33594f590fea1990c52b155eef9dfcbaf9fc7b9fba2"
        }
    }
}

function New-RemoteAdmission {
    param(
        [Parameter(Mandatory = $true)][ValidateSet(0, 20, 21)][int] $ExitCode,
        [Parameter(Mandatory = $true)][string] $StartedAt,
        [Parameter(Mandatory = $true)][string] $CompletedAt,
        [Parameter(Mandatory = $true)][string] $PromotionEvidenceSha256
    )
    $success = $ExitCode -eq 0
    $code = if ($success) { "PASS_INCIDENT_ADMITTED_CONTAINED" } elseif ($ExitCode -eq 20) { "NEW_ROTATION_REQUIRED" } else { "WORKER_PROOF_AMBIGUOUS" }
    [object] $diagnostics = @()
    if (-not $success) { $diagnostics = @($code) }
    return [ordered]@{
        bindings = [ordered]@{
            accountBindingsExact = $success
            filesMode0600 = $success
            managedSandboxEffectMatches = $success
            managedSandboxReadMatches = $success
            predecessorBytesRetested = $false
            stripeAppSigningMatches = $success
        }
        code = $code
        completedAt = $CompletedAt
        containment = [ordered]@{
            caddyStopped = $success
            coreStable = $success
            financialBaselineQuiescent = $success
            financialDeltaExact = $success
            firewallClosed = $success
            liveDisabled = $success
            maintenanceStopped = $success
            markerComplete = $success
            publicListenersClosed = $success
            sourceExact = $success
            workerStopped = $success
        }
        diagnostics = $diagnostics
        exitCode = $ExitCode
        expectedRevision = $ExpectedRevision
        kind = "refunddesk.lightsail.incident-admission"
        marker = [ordered]@{
            complete = $success
            markerTransitions = if ($success) { 5 } else { 0 }
            operationBound = $success
            resumed = $false
            sameIdempotencyKey = $success
            state = if ($success) { "complete" } else { "absent" }
        }
        mutations = [ordered]@{
            markerTransitions = if ($success) { 5 } else { 0 }
            refundsCreated = if ($success) { 1 } else { 0 }
            workerStarts = if ($success) { 1 } else { 0 }
            workerStops = if ($success) { 1 } else { 0 }
            workflowsCreated = if ($success) { 1 } else { 0 }
        }
        nonce = $Hex.a
        postIncidentBaseline = if ($success) { New-PostIncidentBaseline } else { $null }
        proof = [ordered]@{
            ambiguousResumeSameKey = $false
            appSigningAccepted = $success
            denialRefundSetUnchanged = $success
            deterministicIdempotency = $success
            guardReleased = $success
            readChargeSucceeded = $success
            readPaymentIntentSucceeded = $success
            readRefundCreateDenied = $success
            refundCount = if ($success) { 1 } else { 0 }
            requesterApproverDistinct = $success
            terminalReconciled = $success
            unrelatedSigningRejected = $success
            workerStartedPrivately = $success
            workerStoppedAfter = $success
            workflowCount = if ($success) { 1 } else { 0 }
        }
        promotion = [ordered]@{
            bundleSha256 = $Hex.b
            candidateRevision = $ExpectedRevision
            contained = $success
            evidenceSha256 = $PromotionEvidenceSha256
            manifestSha256 = $Hex.c
            postflightAfterPromotion = $success
            provenanceSha256 = $Hex.d
            sourceSha256 = $Hex.e
        }
        redaction = New-Redaction
        repositoryHead = $ExpectedRevision
        result = if ($success) { "PASS" } elseif ($ExitCode -eq 20) { "FAIL" } else { "INCOMPLETE" }
        schemaVersion = 1
        startedAt = $StartedAt
    }
}

function Invoke-WrapperFixture {
    param(
        [Parameter(Mandatory = $true)][string] $Root,
        [Parameter(Mandatory = $true)][ValidateSet(0, 20, 21)][int] $RemoteExit,
        [Parameter(Mandatory = $true)][string] $EvidencePath,
        [string] $Failure = ""
    )
    $toolDirectory = Join-Path $Root "tools"
    $capturedAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    $promotionStarted = [DateTime]::UtcNow.AddSeconds(-2).ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    $promotionCompleted = [DateTime]::UtcNow.AddSeconds(-1).ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    $remoteCompleted = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    $finalCaptured = [DateTime]::UtcNow.AddSeconds(1).ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    $validUntil = [DateTime]::UtcNow.AddMinutes(15).ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    $promotionEvidenceSha256 = Get-FileSha256 (Join-Path $Root "promotion.json")
    Write-CanonicalRestrictedJson (Join-Path $toolDirectory "remote-admission.fixture.json") (New-RemoteAdmission $RemoteExit $capturedAt $remoteCompleted $promotionEvidenceSha256)
    $finalPostflight = New-Postflight $finalCaptured $validUntil
    if ($Failure -ceq "baseline-mismatch") { $finalPostflight.remote.captures.b.database.auditEvents = 13 }
    if ($Failure -ceq "final-container-id") { $finalPostflight.remote.captures.b.containers[2].containerId = $Hex.f }
    if ($Failure -ceq "final-system-identifier") { $finalPostflight.remote.captures.b.database.systemIdentifier = "223456789012345678" }
    Write-CanonicalRestrictedJson (Join-Path $toolDirectory "final-postflight.fixture.json") $finalPostflight
    $stderrPath = Join-Path $Root ("stderr-{0}.txt" -f [guid]::NewGuid().ToString("N"))
    $arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $Wrapper,
        "-PromotionEvidencePath", (Join-Path $Root "promotion.json"),
        "-PreflightEvidencePath", (Join-Path $Root "preflight.json"),
        "-DashboardAttestationPath", (Join-Path $Root "dashboard.json"),
        "-FixtureInputPath", (Join-Path $Root "fixture.json"),
        "-ExpectedSshCidr", "192.0.2.44/32", "-ContractFixture",
        "-FixtureToolDirectory", $toolDirectory, "-FixtureEvidencePath", $EvidencePath
    )
    $previous = $env:REFUNDDESK_INCIDENT_ADMISSION_CONTRACT_MODE
    $previousFailure = $env:REFUNDDESK_INCIDENT_ADMISSION_CONTRACT_FAILURE
    $env:REFUNDDESK_INCIDENT_ADMISSION_CONTRACT_MODE = "1"
    $env:REFUNDDESK_INCIDENT_ADMISSION_CONTRACT_FAILURE = $Failure
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { $stdout = @(& $PowerShell @arguments 2> $stderrPath) -join [Environment]::NewLine; $exit = $LASTEXITCODE }
    finally {
        $ErrorActionPreference = $previousErrorAction
        $env:REFUNDDESK_INCIDENT_ADMISSION_CONTRACT_MODE = $previous
        $env:REFUNDDESK_INCIDENT_ADMISSION_CONTRACT_FAILURE = $previousFailure
    }
    return [pscustomobject]@{
        ExitCode = $exit
        Stderr = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath) } else { "" }
        Stdout = $stdout
    }
}

$wrapperText = [IO.File]::ReadAllText($Wrapper)
$tokens = $null
$parseErrors = $null
$wrapperAst = [Management.Automation.Language.Parser]::ParseFile($Wrapper, [ref] $tokens, [ref] $parseErrors)
Assert-Contract -Condition ($parseErrors.Count -eq 0) -Code "wrapper-parse"
foreach ($forbidden in @("ArgumentList", "ConvertFrom-Json -Depth", "CopyToAsync", "RNG.Fill", ".Kill(`$true)", "GetAuditRules", "SetAuditRule")) {
    Assert-Contract -Condition (-not $wrapperText.Contains($forbidden)) -Code ("forbidden-{0}" -f $forbidden)
}
foreach ($required in @(
    "[IO.FileMode]::CreateNew",
    ".ReadAsync(",
    "PROCESS_STDOUT_LIMIT",
    "PROCESS_STDERR_LIMIT",
    "CreateKillOnClose",
    "GIT_NO_REPLACE_OBJECTS",
    '"--no-replace-objects"',
    "taskkill.exe",
    "Invoke-FormalFinalPostflight",
    'Open-UnreadFileLock $credentialPath',
    'Assert-UnreadFileLock $credentialLock',
    'Invoke-Validator "capture"',
    '$localExitCode = $localWindow.ExitCode',
    '$remoteInvocationStarted -and -not $artifactCommitted',
    "Resolve-LocalCaptureWindow",
    "New-ExclusiveRestrictedDirectory",
    "Invoke-IsolatedTransportProcess",
    "AWS_CONFIG_FILE",
    "promotionValidator",
    "promotionSchema",
    "postflightObserver",
    "postflightValidator",
    "postflightWrapper"
)) {
    Assert-Contract -Condition $wrapperText.Contains($required) -Code ("required-{0}" -f $required)
}
$unreadFunction = [regex]::Match(
    $wrapperText,
    '(?s)function Open-UnreadFileLock \{.*?\r?\n\}\r?\n\r?\nfunction Assert-UnreadFileLock'
).Value
Assert-Contract -Condition (-not [string]::IsNullOrEmpty($unreadFunction)) -Code "credential-unread-helper-present"
foreach ($forbiddenRead in @("Get-StreamSha256", "ComputeHash", ".Read(", "Read-LockedBytes")) {
    Assert-Contract -Condition (-not $unreadFunction.Contains($forbiddenRead)) -Code ("credential-unread-{0}" -f $forbiddenRead)
}

$boundedFunctionNames = @("ConvertTo-NativeArgument", "Stop-ProcessTree", "New-KillOnCloseJob", "Invoke-BoundedProcess", "Resolve-LocalCaptureWindow")
foreach ($name in $boundedFunctionNames) {
    $definition = @($wrapperAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    Assert-Contract -Condition ($definition.Count -eq 1) -Code ("bounded-function-{0}" -f $name)
    . ([scriptblock]::Create($definition[0].Extent.Text))
}
function Throw-SafeError {
    param([string] $Code)
    throw [InvalidOperationException]::new("REFUNDDESK_$Code")
}
function Open-FileLock {
    param([string] $Path, [string] $FailureCode)
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    return [pscustomobject]@{ Sha256 = Get-FileSha256 $Path; Stream = $stream }
}
$RunningOnWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$MaximumDiagnosticBytes = 128

function Get-LiteralSystemDriveMetadata {
    $literal = Join-Path $Repository "%SystemDrive%"
    if (-not (Test-Path -LiteralPath $literal)) { return "ABSENT" }
    return (@(Get-ChildItem -LiteralPath $literal -Recurse -Force | Sort-Object FullName | ForEach-Object {
        $length = if ($_.PSIsContainer) { -1 } else { $_.Length }
        "{0}|{1}|{2}|{3}" -f $_.FullName.Substring($literal.Length), $length, [int] $_.Attributes, $_.LastWriteTimeUtc.Ticks
    }) -join "`n")
}

$literalSystemDriveBaseline = Get-LiteralSystemDriveMetadata

$root = Join-Path ([IO.Path]::GetTempPath()) ("refunddesk-incident-admission-wrapper-{0}" -f [guid]::NewGuid().ToString("N"))
[void] [IO.Directory]::CreateDirectory($root)
Set-RestrictedAcl -Path $root -Directory $true
$toolDirectory = Join-Path $root "tools"
[void] [IO.Directory]::CreateDirectory($toolDirectory)
Set-RestrictedAcl -Path $toolDirectory -Directory $true
try {
    $replaceRepository = Join-Path $root "replace-probe"
    [void] [IO.Directory]::CreateDirectory($replaceRepository)
    & git -C $replaceRepository init --quiet
    & git -C $replaceRepository config user.email "fixture@refunddesk.invalid"
    & git -C $replaceRepository config user.name "RefundDesk Fixture"
    & git -C $replaceRepository config core.autocrlf false
    [IO.File]::WriteAllText((Join-Path $replaceRepository "probe.txt"), "original`n", [Text.UTF8Encoding]::new($false))
    & git -C $replaceRepository add -- probe.txt
    & git -C $replaceRepository commit --quiet -m original
    $originalCommit = (& git -C $replaceRepository rev-parse HEAD).Trim()
    [IO.File]::WriteAllText((Join-Path $replaceRepository "probe.txt"), "substitute`n", [Text.UTF8Encoding]::new($false))
    & git -C $replaceRepository add -- probe.txt
    & git -C $replaceRepository commit --quiet -m substitute
    $substituteCommit = (& git -C $replaceRepository rev-parse HEAD).Trim()
    & git -C $replaceRepository replace $originalCommit $substituteCommit
    $replacedBytes = (& git -C $replaceRepository show "$originalCommit`:probe.txt").Trim()
    $pinnedBytes = (& git --no-replace-objects --no-optional-locks -C $replaceRepository show "$originalCommit`:probe.txt").Trim()
    Assert-Contract -Condition ($replacedBytes -ceq "substitute") -Code "git-replace-probe-active"
    Assert-Contract -Condition ($pinnedBytes -ceq "original") -Code "git-replace-neutralized"

    $syntheticStart = [DateTime]::ParseExact("2026-08-09T00:00:00Z", "yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    $syntheticDashboardUntil = $syntheticStart.AddMinutes(15)
    $syntheticLongCompletion = $syntheticStart.AddSeconds(181)
    Assert-Contract -Condition (($syntheticDashboardUntil - $syntheticStart).TotalSeconds -ge 720) -Code "temporal-initial-admitted"
    Assert-Contract -Condition (($syntheticDashboardUntil - $syntheticLongCompletion).TotalSeconds -lt 720) -Code "temporal-first-replay-required"
    $syntheticRefreshUntil = $syntheticLongCompletion.AddMinutes(15)
    Assert-Contract -Condition (($syntheticRefreshUntil - $syntheticLongCompletion).TotalSeconds -ge 720) -Code "temporal-refresh-admitted"
    $longWindow = Resolve-LocalCaptureWindow $syntheticLongCompletion $syntheticDashboardUntil $syntheticRefreshUntil 0 "PASS" "PASS_INCIDENT_ADMITTED_CONTAINED"
    Assert-Contract -Condition ($longWindow.ExitCode -eq 21 -and $longWindow.Result -ceq "INCOMPLETE" -and $longWindow.Code -ceq "LOCAL_EVIDENCE_LIFETIME_INVALID") -Code "temporal-first-local-incomplete"
    Assert-Contract -Condition ($longWindow.ValidUntil -eq $syntheticRefreshUntil) -Code "temporal-incomplete-final-cap"
    $refreshedWindow = Resolve-LocalCaptureWindow $syntheticLongCompletion $syntheticRefreshUntil $syntheticRefreshUntil 0 "PASS" "PASS_INCIDENT_ADMITTED_CONTAINED"
    Assert-Contract -Condition ($refreshedWindow.ExitCode -eq 0 -and $refreshedWindow.ValidUntil -eq $syntheticRefreshUntil) -Code "temporal-fast-replay-pass"

    $processEnvironment = [ordered]@{
        HOME = $root
        PATH = "$env:SystemRoot\System32"
        PROGRAMDATA = $root
        SystemDrive = [IO.Path]::GetPathRoot($env:SystemRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        SystemRoot = $env:SystemRoot
        USERPROFILE = $root
        WINDIR = $env:WINDIR
    }
    $powerShellSha256 = Get-FileSha256 $PowerShell
    foreach ($probe in @(
        [pscustomobject]@{ Code = "PROCESS_STDOUT_LIMIT"; Script = '[Console]::Out.Write("x" * 1048576); Start-Sleep -Seconds 30' },
        [pscustomobject]@{ Code = "PROCESS_STDERR_LIMIT"; Script = '[Console]::Error.Write("x" * 1048576); Start-Sleep -Seconds 30' }
    )) {
        $observed = $null
        try {
            [void] (Invoke-BoundedProcess $PowerShell $powerShellSha256 @("-NoLogo", "-NoProfile", "-NonInteractive", "-Command", $probe.Script) $processEnvironment ([byte[]]@()) 10 128)
        }
        catch { $observed = $_.Exception.Message }
        Assert-Contract -Condition ($observed -ceq "REFUNDDESK_$($probe.Code)") -Code ("bounded-{0}" -f $probe.Code)
    }

    $childPidPath = Join-Path $root "bounded-child.pid"
    $parentProbePath = Join-Path $root "bounded-parent.ps1"
    $parentProbe = @'
param([string] $ChildPidPath, [string] $PowerShellPath)
$child = Start-Process -FilePath $PowerShellPath -ArgumentList '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"' -PassThru
[IO.File]::WriteAllText($ChildPidPath, [string] $child.Id, [Text.Encoding]::ASCII)
Start-Sleep -Seconds 60
'@
    [IO.File]::WriteAllText($parentProbePath, $parentProbe, [Text.UTF8Encoding]::new($false))
    $timeoutObserved = $null
    try {
        [void] (Invoke-BoundedProcess $PowerShell $powerShellSha256 @("-NoLogo", "-NoProfile", "-NonInteractive", "-File", $parentProbePath, "-ChildPidPath", $childPidPath, "-PowerShellPath", $PowerShell) $processEnvironment ([byte[]]@()) 3 128)
    }
    catch { $timeoutObserved = $_.Exception.Message }
    Assert-Contract -Condition ($timeoutObserved -ceq "REFUNDDESK_PROCESS_TIMEOUT") -Code "bounded-timeout"
    Assert-Contract -Condition (Test-Path -LiteralPath $childPidPath) -Code "bounded-child-created"
    $childPid = [int] [IO.File]::ReadAllText($childPidPath)
    [Threading.Thread]::Sleep(500)
    Assert-Contract -Condition ($null -eq (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) -Code "bounded-child-killed"

    $capturedAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    $validUntil = [DateTime]::UtcNow.AddMinutes(15).ToString("yyyy-MM-ddTHH:mm:ssZ", [Globalization.CultureInfo]::InvariantCulture)
    Write-CanonicalRestrictedJson (Join-Path $root "promotion.json") (New-Promotion ([DateTime]::UtcNow.AddSeconds(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")) ([DateTime]::UtcNow.AddSeconds(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")))
    Write-CanonicalRestrictedJson (Join-Path $root "preflight.json") (New-Postflight $capturedAt $validUntil)
    Write-CanonicalRestrictedJson (Join-Path $root "dashboard.json") (New-Dashboard $capturedAt $validUntil)
    Write-CanonicalRestrictedJson (Join-Path $root "fixture.json") ([ordered]@{
        amountMinor = "1"
        approverUserId = "usr_Approver01"
        currency = "eur"
        denialPaymentIntentId = "pi_Denial001"
        environment = "managed_sandbox"
        kind = "refunddesk.stripe.incident-admission-fixture"
        refundablePaymentIntentId = "pi_Refundable001"
        requesterUserId = "usr_Requester01"
        schemaVersion = 1
    })
    Write-CanonicalRestrictedJson (Join-Path $toolDirectory "aws-control.fixture.json") ([ordered]@{
        accountMatches = $true
        digest = $Hex.a
        firewallClosed = $true
        instanceMatches = $true
        regionMatches = $true
    })

    $credentialProbe = Join-Path $root "credential-unread.fixture"
    [IO.File]::WriteAllText($credentialProbe, "never-read`n", [Text.UTF8Encoding]::new($false))
    Set-RestrictedAcl -Path $credentialProbe -Directory $false
    $unreadLock = [IO.FileStream]::new(
        $credentialProbe,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    try {
        $lockedLength = $unreadLock.Length
        Assert-Contract -Condition ($unreadLock.Position -eq 0) -Code "credential-position-before"
        $writeRejected = $false
        try {
            $writeProbe = [IO.FileStream]::new($credentialProbe, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            $writeProbe.Dispose()
        }
        catch { $writeRejected = $true }
        Assert-Contract -Condition $writeRejected -Code "credential-write-rejected"
        $renameRejected = $false
        try { [IO.File]::Move($credentialProbe, "$credentialProbe.renamed") }
        catch { $renameRejected = $true }
        Assert-Contract -Condition $renameRejected -Code "credential-rename-rejected"
        Assert-Contract -Condition ($unreadLock.Position -eq 0 -and $unreadLock.Length -eq $lockedLength) -Code "credential-never-read"
    }
    finally { $unreadLock.Dispose() }

    foreach ($mapping in @(
        [pscustomobject]@{ Exit = 0; Result = "PASS"; Admission = "FIXTURE_ONLY" },
        [pscustomobject]@{ Exit = 20; Result = "FAIL"; Admission = "FIXTURE_ONLY" },
        [pscustomobject]@{ Exit = 21; Result = "INCOMPLETE"; Admission = "FIXTURE_ONLY" }
    )) {
        $evidence = Join-Path $root ("capture-{0}.json" -f $mapping.Exit)
        $run = Invoke-WrapperFixture $root $mapping.Exit $evidence
        if ($run.ExitCode -ne $mapping.Exit) {
            throw "contract-wrapper-exit:$($mapping.Exit):actual=$($run.ExitCode):stderr=$($run.Stderr)"
        }
        Assert-Contract -Condition ($run.ExitCode -eq $mapping.Exit) -Code ("exit-map-{0}" -f $mapping.Exit)
        Assert-Contract -Condition ([string]::IsNullOrEmpty($run.Stderr)) -Code ("stderr-{0}" -f $mapping.Exit)
        Assert-Contract -Condition (Test-Path -LiteralPath $evidence) -Code ("evidence-{0}" -f $mapping.Exit)
        $capture = [IO.File]::ReadAllText($evidence) | ConvertFrom-Json
        Assert-Contract -Condition ($capture.result -ceq $mapping.Result) -Code ("result-{0}" -f $mapping.Exit)
        Assert-Contract -Condition ($capture.admission -ceq $mapping.Admission) -Code ("admission-{0}" -f $mapping.Exit)
        Assert-Contract -Condition ($capture.remoteDocument.exitCode -eq $mapping.Exit) -Code ("remote-exit-{0}" -f $mapping.Exit)
        Assert-Contract -Condition ($capture.exitCode -eq $mapping.Exit) -Code ("local-exit-{0}" -f $mapping.Exit)
        Assert-Contract -Condition ($capture.postIncidentBaseline.snapshotSha256 -ceq $capture.finalPostflight.postIncidentBaselineSha256) -Code ("baseline-final-bind-{0}" -f $mapping.Exit)
        Assert-Contract -Condition ($capture.postIncidentBaseline.refundRequests -eq 3 -and $capture.postIncidentBaseline.mutationReceipts -eq 4) -Code ("baseline-counts-{0}" -f $mapping.Exit)
        Assert-Contract -Condition ($capture.finalPostflight.candidateBinding.workerContainerIdSha256 -ceq (Get-TextSha256 $Hex.e)) -Code ("candidate-worker-bind-{0}" -f $mapping.Exit)
        Assert-Contract -Condition ($capture.finalPostflight.candidateBinding.systemIdentifierSha256 -ceq (Get-TextSha256 "123456789012345678")) -Code ("candidate-db-bind-{0}" -f $mapping.Exit)
    }

    $createNewEvidence = Join-Path $root "capture-create-new.json"
    $first = Invoke-WrapperFixture $root 0 $createNewEvidence
    Assert-Contract -Condition ($first.ExitCode -eq 0) -Code "create-new-first"
    $before = [IO.File]::ReadAllBytes($createNewEvidence)
    $second = Invoke-WrapperFixture $root 0 $createNewEvidence
    Assert-Contract -Condition ($second.ExitCode -eq 1) -Code "create-new-second-exit-one"
    Assert-Contract -Condition ([Convert]::ToBase64String([IO.File]::ReadAllBytes($createNewEvidence)) -ceq [Convert]::ToBase64String($before)) -Code "create-new-preserved"

    foreach ($failure in @(
        "remote-cleanup-fail", "remote-cleanup-hang", "remote-cleanup-ambiguous",
        "aws-after", "baseline-mismatch", "final-container-id", "final-postflight",
        "final-system-identifier", "source-race", "evidence-create-new"
    )) {
        $failureEvidence = Join-Path $root ("capture-failure-{0}.json" -f $failure)
        $postflightLog = Join-Path $toolDirectory "postflight-invocations.fixture.log"
        $beforeAttempts = if (Test-Path -LiteralPath $postflightLog) { @([IO.File]::ReadAllLines($postflightLog)).Count } else { 0 }
        $failed = Invoke-WrapperFixture $root 0 $failureEvidence $failure
        Assert-Contract -Condition ($failed.ExitCode -eq 1) -Code ("failure-exit-{0}" -f $failure)
        Assert-Contract -Condition (-not (Test-Path -LiteralPath $failureEvidence)) -Code ("failure-no-artifact-{0}" -f $failure)
        $afterAttempts = if (Test-Path -LiteralPath $postflightLog) { @([IO.File]::ReadAllLines($postflightLog)).Count } else { 0 }
        Assert-Contract -Condition ($afterAttempts -eq ($beforeAttempts + 1)) -Code ("failure-postflight-{0}" -f $failure)
    }

    Assert-Contract -Condition ((Get-LiteralSystemDriveMetadata) -ceq $literalSystemDriveBaseline) -Code "literal-systemdrive-baseline-unchanged"

    $failureProbePath = Join-Path $root "intentional-failure.stderr.txt"
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $PowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -IntentionalFailure 2> $failureProbePath | Out-Null
        $failureProbeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousErrorAction }
    Assert-Contract -Condition ($failureProbeExit -ne 0) -Code "assertion-failure-process-nonzero"
}
finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}

[Console]::Out.WriteLine("incident-admission-wrapper-contract:PASS")
