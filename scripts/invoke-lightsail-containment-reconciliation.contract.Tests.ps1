[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$FixtureExpectedSshCidr = "192.0.2.44/32"
$ExpectedRevision = "8da280b78a9d1475c7bd79063e72c5af77121e8d"
$ExpectedComposeSha256 = "92a96553a38b226505957e717e2844960794256dceb5a5284fde0c00d22b4610"
$ExpectedManifestSha256 = "e72319926d184db8e696c7d4d032d3f9e44cbabbde9b36e64c473da96ef241ca"
$ExpectedCommonSha256 = "e3582a5ccbac7be03731c1773cb3527c9ee6613796a131762b19041fa6918da6"
$ExpectedHelperSha256 = "76fba53c93c450c202788a9fd12754e409e713a7b8407084723c440f01f7a6e6"
$ExpectedImageIds = [ordered]@{
    postgres = "sha256:0a314d409a9633cff4f89dc18482262625c0ee78cb1aa2ff8e47bc6da0251e1b"
    verifier = "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe"
    worker = "sha256:e3ead31f6c3084b69731e095a250b8d0a4e3e9d6e8d239dccf077e6b90d53f64"
    web = "sha256:c1d13b7db80e019e8a0ea24717c2a2028052b5959e1aaf65746336073606601f"
    caddy = "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe"
}

function Assert-Contract {
    param([Parameter(Mandatory = $true)][bool] $Condition, [Parameter(Mandatory = $true)][string] $Code)
    if (-not $Condition) { throw "contract-assertion-failed:$Code" }
}

function Set-RestrictedAcl {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][bool] $Directory)

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $sids = @(
        $currentSid,
        [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
        [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    )
    if ($Directory) {
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        foreach ($sid in $sids) {
            [void] $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
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

function Write-RestrictedJson {
    param([string] $Path, $Value)

    $text = ($Value | ConvertTo-Json -Compress -Depth 100) + [char] 10
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
    Set-RestrictedAcl -Path $Path -Directory $false
}

function Get-Sha256Hex {
    param([byte[]] $Bytes)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

function Get-CanonicalJsonSha256 {
    param([Parameter(Mandatory = $true)] $Value)

    $sorted = ConvertTo-RecursivelySortedValue -Value $Value
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(
        ($sorted | ConvertTo-Json -Compress -Depth 100)
    )
    return Get-Sha256Hex -Bytes $bytes
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

function ConvertTo-TestArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Value)
    return '"' + $Value.Replace('"', '`"') + '"'
}

function Invoke-WrapperFixture {
    param(
        [string] $PowerShellExecutable,
        [string] $WrapperPath,
        [string] $ToolDirectory,
        [string] $EvidencePath,
        [string] $PreflightPath,
        [string] $TemplatePath,
        [string] $Mode,
        [string] $StatePath,
        [AllowEmptyString()][string] $ExpectedSshCidr = $FixtureExpectedSshCidr,
        [ValidateRange(1, 15)][int] $TimeoutSeconds = 1,
        [AllowNull()][string] $GitFixtureRepository,
        [AllowNull()][string] $GitAlternateHead,
        [ValidateRange(30000, 180000)][int] $ProcessTimeoutMilliseconds = 30000
    )

    $arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $WrapperPath,
        "-PreflightEvidencePath", $PreflightPath,
        "-ExpectedSshCidr", $ExpectedSshCidr,
        "-ContractFixture",
        "-FixtureToolDirectory", $ToolDirectory,
        "-FixtureEvidencePath", $EvidencePath,
        "-FixtureTimeoutSeconds", ([string] $TimeoutSeconds)
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $PowerShellExecutable
    $startInfo.Arguments = (($arguments | ForEach-Object { ConvertTo-TestArgument $_ }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables["REFUNDDESK_CONTAINMENT_RECONCILIATION_CONTRACT_MODE"] = "1"
    $startInfo.EnvironmentVariables["REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_MODE"] = $Mode
    $startInfo.EnvironmentVariables["REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_REMOTE_TEMPLATE"] = $TemplatePath
    $startInfo.EnvironmentVariables["REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_STATE"] = $StatePath
    if (-not [string]::IsNullOrWhiteSpace($GitFixtureRepository)) {
        Assert-Contract -Condition (-not [string]::IsNullOrWhiteSpace($GitAlternateHead)) -Code "git-fixture-alternate-required"
        $startInfo.EnvironmentVariables["REFUNDDESK_CONTAINMENT_RECONCILIATION_GIT_PROVENANCE_FIXTURE"] = "1"
        $startInfo.EnvironmentVariables["REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_REPOSITORY"] = $GitFixtureRepository
        $startInfo.EnvironmentVariables["REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_ALTERNATE_HEAD"] = $GitAlternateHead
    }
    $startInfo.EnvironmentVariables["NODE_OPTIONS"] = "--require=C:`refunddesk-does-not-exist.js"
    $startInfo.EnvironmentVariables["NODE_PATH"] = "C:`refunddesk-poison"
    $startInfo.EnvironmentVariables["GIT_CONFIG_COUNT"] = "1"
    $startInfo.EnvironmentVariables["GIT_CONFIG_KEY_0"] = "core.sshCommand"
    $startInfo.EnvironmentVariables["GIT_CONFIG_VALUE_0"] = "refunddesk-poison"
    $startInfo.EnvironmentVariables["SSH_AUTH_SOCK"] = "refunddesk-poison"
    $startInfo.EnvironmentVariables["AWS_ENDPOINT_URL"] = "https://refunddesk.invalid"
    $startInfo.EnvironmentVariables["AWS_ACCESS_KEY_ID"] = ("AK" + "IA" + ("Z" * 16))
    $startInfo.EnvironmentVariables["AWS_SECRET_ACCESS_KEY"] = ("fixture" + ("Z" * 32))
    $startInfo.EnvironmentVariables["AWS_PROFILE"] = "refunddesk-poison"

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        Assert-Contract -Condition ($process.Start()) -Code "wrapper-did-not-start"
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($ProcessTimeoutMilliseconds)) {
            $process.Kill()
            throw "contract-assertion-failed:wrapper-timeout"
        }
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdoutTask.Result
            Stderr = $stderrTask.Result
        }
    }
    finally { $process.Dispose() }
}

function New-PostflightContainer {
    param(
        [string] $Service,
        [int] $Index,
        [ValidateSet("CREATED", "EXITED", "RUNNING")][string] $Status,
        [ValidateSet("HEALTHY", "NONE", "STARTING", "UNHEALTHY")][string] $Health
    )

    return [ordered]@{
        service = $Service
        presentCount = 1
        containerId = ([string] ($Index + 1)) * 64
        imageId = $ExpectedImageIds[$Service]
        expectedImageId = $ExpectedImageIds[$Service]
        imageReferenceMatches = $true
        noPublishedPorts = $Service -ne "caddy"
        effectiveGlobalLiveDisabled = if ($Service -in @("worker", "web")) { $true } else { $null }
        effectiveLiveWebhookDisabled = if ($Service -eq "web") { $true } else { $null }
        status = $Status
        health = $Health
        projectLabelMatches = $true
        serviceLabelMatches = $true
        revisionLabel = if ($Service -eq "postgres") { $null } else { $ExpectedRevision }
    }
}

function New-PostflightCaptureSnapshot {
    param(
        [ValidateSet(
            "INITIAL", "PENDING", "PARTIAL_TIMER_SUBSET", "PARTIAL_CADDY_STOPPED",
            "PARTIAL_STOPPED_MIXED", "CLEARED"
        )]
        [string] $Profile,
        [bool] $JournalPresent
    )

    $targetState = switch ($Profile) {
        "INITIAL" {
            @{
                worker = @("RUNNING", "HEALTHY")
                caddy = @("RUNNING", "HEALTHY")
            }
        }
        "PARTIAL_TIMER_SUBSET" {
            @{
                worker = @("RUNNING", "HEALTHY")
                caddy = @("RUNNING", "HEALTHY")
            }
        }
        "PARTIAL_CADDY_STOPPED" {
            @{
                worker = @("RUNNING", "HEALTHY")
                caddy = @("EXITED", "HEALTHY")
            }
        }
        "PARTIAL_STOPPED_MIXED" {
            @{
                worker = @("CREATED", "STARTING")
                caddy = @("EXITED", "UNHEALTHY")
            }
        }
        default {
            @{
                worker = @("EXITED", "NONE")
                caddy = @("EXITED", "NONE")
            }
        }
    }

    $backupTimerActive = $Profile -in @("INITIAL", "PARTIAL_TIMER_SUBSET")
    $retentionTimerActive = $Profile -eq "INITIAL"
    $tcp80Listening = $Profile -in @("INITIAL", "PARTIAL_TIMER_SUBSET")
    $tcp443Listening = $Profile -in @("INITIAL", "PARTIAL_TIMER_SUBSET")

    $containers = @()
    $services = @("postgres", "verifier", "worker", "web", "caddy")
    for ($index = 0; $index -lt $services.Count; $index += 1) {
        $service = $services[$index]
        if ($service -in @("postgres", "verifier", "web")) {
            $status = "RUNNING"
            $health = "HEALTHY"
        }
        else {
            $status = $targetState[$service][0]
            $health = $targetState[$service][1]
        }
        $containers += New-PostflightContainer -Service $service -Index $index -Status $status -Health $health
    }
    $unexpectedRunningContainerCount = @(
        $containers | Where-Object { $_.service -in @("worker", "caddy") -and $_.status -ceq "RUNNING" }
    ).Count
    return [ordered]@{
        capturedAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
        identity = [ordered]@{
            activeRevision = $ExpectedRevision
            currentRevision = $ExpectedRevision
            sourceRevision = $ExpectedRevision
            releaseEnvironmentRevision = $ExpectedRevision
            manifestRevision = $ExpectedRevision
            composeSha256 = $ExpectedComposeSha256
            installedManifestSha256 = $ExpectedManifestSha256
            manifestSchemaValid = $true
        }
        containers = $containers
        control = [ordered]@{
            operatorLockShared = $true
            transitionJournalPresent = $false
            transitionCommitMarkerValid = $true
            runtimeQuiesceJournalPresent = $JournalPresent
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
            backupTimerActive = $backupTimerActive
            retentionTimerActive = $retentionTimerActive
            backupServiceActive = $false
            retentionServiceActive = $false
            quiesceRecoveryActive = $false
            tcp80Listening = $tcp80Listening
            tcp443Listening = $tcp443Listening
            udp80Listening = $false
            udp443Listening = $false
            systemdInventoryAvailable = $true
            listenerInventoryAvailable = $true
            liveInterlocksAvailable = $true
            runtimeLiveInterlocksAvailable = $true
            unexpectedRunningContainerCount = $unexpectedRunningContainerCount
        }
        database = [ordered]@{
            snapshotAvailable = $true
            systemIdentifier = "123456789012345678"
            activeWorkflows = 0
            unreleasedPaymentGuards = 0
            activeFinancialJobs = 0
            liveTenants = 0
            liveInstallations = 0
            preparedTransactions = 0
            refundRequests = 6
            auditEvents = 2088
        }
    }
}

function New-PostflightEvidence {
    param(
        [ValidateSet(
            "INITIAL", "PENDING", "PARTIAL_TIMER_SUBSET", "PARTIAL_CADDY_STOPPED",
            "PARTIAL_STOPPED_MIXED", "CLEARED"
        )]
        [string] $Profile = "INITIAL"
    )

    $initial = $Profile -eq "INITIAL"
    $journalPresent = $Profile -ne "CLEARED"
    $snapshot = New-PostflightCaptureSnapshot -Profile $Profile -JournalPresent $journalPresent
    $capturedAt = [DateTime]::UtcNow
    $worker = @($snapshot.containers | Where-Object { $_.service -ceq "worker" })[0]
    $caddy = @($snapshot.containers | Where-Object { $_.service -ceq "caddy" })[0]
    $workerRunning = $worker.status -ceq "RUNNING" -and $worker.health -ceq "HEALTHY"
    $caddyRunning = $caddy.status -ceq "RUNNING" -and $caddy.health -ceq "HEALTHY"
    $maintenanceActive = $snapshot.surface.backupTimerActive -or $snapshot.surface.retentionTimerActive
    $publicListenerActive = $snapshot.surface.tcp80Listening -or $snapshot.surface.tcp443Listening
    $result = if ($journalPresent) { "FAIL" } else { "PASS" }
    $diagnostics = @()
    if ($journalPresent) {
        if ($caddyRunning) { $diagnostics += "CADDY_RUNNING" }
        if ($maintenanceActive) { $diagnostics += "MAINTENANCE_ACTIVE" }
        if ($publicListenerActive) { $diagnostics += "PUBLIC_LISTENER_ACTIVE" }
        if ($snapshot.surface.unexpectedRunningContainerCount -gt 0) { $diagnostics += "UNEXPECTED_RUNNING_CONTAINER" }
        $diagnostics += "UNRESOLVED_JOURNAL"
        if ($workerRunning) { $diagnostics += "WORKER_RUNNING" }
    }
    $code = if ($journalPresent) { $diagnostics[0] } else { "PASS_CONTAINED" }
    $posture = if ($initial) { "COHERENT_RUNNING" } elseif ($journalPresent) { "DIVERGENT" } else { "COHERENT_CONTAINED" }
    $remote = [ordered]@{
        schemaVersion = 1
        kind = "refunddesk.lightsail.host-postflight"
        nonce = "b" * 64
        startedAt = $capturedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
        completedAt = $capturedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
        exitCode = if ($result -eq "PASS") { 0 } else { 20 }
        result = $result
        code = $code
        posture = $posture
        diagnostics = $diagnostics
        captures = [ordered]@{ a = $snapshot; b = $snapshot }
        containment = [ordered]@{
            liveDisabled = $true
            workerStopped = -not $workerRunning
            caddyStopped = -not $caddyRunning
            maintenanceStopped = -not $maintenanceActive
            publicListenersClosed = -not $publicListenerActive
            journalsClosed = -not $journalPresent
            fenceClosed = $true
            sensitiveModesSafe = $true
        }
        availability = [ordered]@{
            capturesStable = $true
            metadataCoherent = $true
            containersCoherent = $true
            coreHealthy = $true
            recoverableRuntimeStopped = $false
        }
        financial = [ordered]@{ snapshotAvailable = $true; stable = $true; quiescent = $true }
        redaction = [ordered]@{
            rawSecretPresent = $false
            rawApiKeyPresent = $false
            rawSignaturePresent = $false
            rawPayloadPresent = $false
            customerDataPresent = $false
            arbitraryPathPresent = $false
            stderrPresent = $false
        }
    }
    $remoteBytes = [Text.UTF8Encoding]::new($false).GetBytes(
        (($remote | ConvertTo-Json -Compress -Depth 100) + [char] 10)
    )
    $remoteSha256 = Get-Sha256Hex -Bytes $remoteBytes
    return [ordered]@{
        schemaVersion = 1
        kind = "refunddesk.lightsail.host-postflight.capture"
        result = $result
        admission = "FIXTURE_ONLY"
        posture = $posture
        capturedAt = $capturedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
        validUntil = $capturedAt.AddMinutes(15).ToString("yyyy-MM-ddTHH:mm:ssZ")
        remote = $remote
        awsControlPlane = [ordered]@{
            targetId = "refunddesk-sandbox-paris@eu-west-3"
            accountMatches = $true
            regionMatches = $true
            instanceMatches = $true
            instanceRunning = $true
            firewallClosedBefore = $true
            firewallClosedAfter = $true
            firewallUnchanged = $true
        }
        provenance = [ordered]@{
            remoteDocumentSha256 = $remoteSha256
            observer = [ordered]@{ gitObject = $null; sha256 = "d" * 64 }
            validator = [ordered]@{ gitObject = $null; sha256 = "e" * 64 }
            wrapper = [ordered]@{ gitObject = $null; sha256 = "f" * 64 }
            schema = [ordered]@{ gitObject = $null; sha256 = "a" * 64 }
            repositoryHead = $null
            revisionComposeVerified = $true
            transportInputsPinned = $true
            fixtureOnly = $true
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
}

function New-ReconciliationContainer {
    param([string] $Service, [int] $Index, [bool] $Admission)

    $running = $Service -in @("postgres", "verifier", "web") -or ($Admission -and $Service -in @("worker", "caddy"))
    return [ordered]@{
        service = $Service
        presentCount = 1
        containerId = ([string] ($Index + 1)) * 64
        imageId = $ExpectedImageIds[$Service]
        expectedImageId = $ExpectedImageIds[$Service]
        imageReferenceMatches = $true
        status = if ($running) { "RUNNING" } else { "EXITED" }
        health = if ($running) { "HEALTHY" } else { "NONE" }
        restartPolicy = if ($running) { "unless-stopped" } else { "no" }
        projectLabelMatches = $true
        serviceLabelMatches = $true
        revisionLabelMatches = $true
    }
}

function New-ReconciliationCapture {
    param([bool] $JournalPresent, [bool] $Admission = $false)

    $containers = @()
    $services = @("postgres", "verifier", "worker", "web", "caddy")
    for ($index = 0; $index -lt $services.Count; $index += 1) {
        $containers += New-ReconciliationContainer -Service $services[$index] -Index $index -Admission $Admission
    }
    return [ordered]@{
        capturedAt = "__TIME__"
        identity = [ordered]@{
            activeRevision = $ExpectedRevision
            currentRevision = $ExpectedRevision
            sourceRevision = $ExpectedRevision
            releaseEnvironmentRevision = $ExpectedRevision
            manifestSha256 = $ExpectedManifestSha256
            composeSha256 = $ExpectedComposeSha256
            commonSha256 = $ExpectedCommonSha256
            helperSha256 = $ExpectedHelperSha256
        }
        journal = if ($JournalPresent) {
            [ordered]@{ present = $true; operation = "backup"; revision = $ExpectedRevision; status = "in_progress"; sha256 = "9" * 64 }
        } else {
            [ordered]@{ present = $false; operation = $null; revision = $null; status = $null; sha256 = $null }
        }
        control = [ordered]@{
            activeReleaseUnitCount = 0
            activeFenceUnitCount = 0
            releaseRuntimeMarkerCount = 0
            transitionPresent = $false
            backupUploadJournalPresent = $false
            managedTransitionPresent = $false
            reservationValid = $true
            knownOneShotsPresentCount = 0
            knownOneShotsRunningCount = 0
            unexpectedRunningContainerCount = 0
        }
        containers = $containers
        surface = [ordered]@{
            systemdInventoryAvailable = $true
            listenerInventoryAvailable = $true
            liveInterlocksAvailable = $true
            platformLiveDisabled = $true
            workerLiveDisabled = $true
            liveWebhookDisabled = $true
            webEffectiveLiveDisabled = $true
            workerEffectiveLiveDisabled = $true
            backupTimerActive = $Admission
            retentionTimerActive = $Admission
            backupServiceActive = $false
            retentionServiceActive = $false
            quiesceRecoveryActive = $false
            tcp80Listening = $Admission
            tcp443Listening = $Admission
            udp80Listening = $false
            udp443Listening = $false
        }
        database = [ordered]@{
            snapshotAvailable = $true
            systemIdentifier = "123456789012345678"
            activeWorkflows = 0
            unreleasedPaymentGuards = 0
            activeFinancialJobs = 0
            liveTenants = 0
            liveInstallations = 0
            preparedTransactions = 0
            refundRequests = 6
            auditEvents = 2088
        }
    }
}

function New-RemoteTemplate {
    param([ValidateSet("PASS", "FAIL", "INCOMPLETE")][string] $Outcome = "PASS")

    $admission = New-ReconciliationCapture -JournalPresent $true -Admission $true
    $before = New-ReconciliationCapture -JournalPresent $true
    $after = New-ReconciliationCapture -JournalPresent $false
    $containedStateProjection = [ordered]@{
        identity = $before.identity
        containers = $before.containers
        control = $before.control
        surface = $before.surface
        database = $before.database
    }
    $admissionContainers = @(
        $admission.containers | ForEach-Object {
            [ordered]@{
                service = $_.service
                presentCount = $_.presentCount
                containerId = $_.containerId
                imageId = $_.imageId
                expectedImageId = $_.expectedImageId
                imageReferenceMatches = $_.imageReferenceMatches
            }
        }
    )
    $admissionInvariantProjection = [ordered]@{
        identity = $admission.identity
        containers = $admissionContainers
        database = $admission.database
        live = [ordered]@{
            liveInterlocksAvailable = $admission.surface.liveInterlocksAvailable
            platformLiveDisabled = $admission.surface.platformLiveDisabled
            workerLiveDisabled = $admission.surface.workerLiveDisabled
            liveWebhookDisabled = $admission.surface.liveWebhookDisabled
            webEffectiveLiveDisabled = $admission.surface.webEffectiveLiveDisabled
            workerEffectiveLiveDisabled = $admission.surface.workerEffectiveLiveDisabled
        }
    }
    $admissionInvariantSha256 = Get-CanonicalJsonSha256 -Value $admissionInvariantProjection
    $containedStateSha256 = Get-CanonicalJsonSha256 -Value $containedStateProjection
    $document = [ordered]@{
        schemaVersion = 1
        kind = "refunddesk.lightsail.containment-reconciliation"
        nonce = "__NONCE__"
        expectedRevision = $ExpectedRevision
        operation = "backup"
        startedAt = "__TIME__"
        completedAt = "__TIME__"
        exitCode = 0
        result = "PASS"
        code = "PASS_CONTAINED_JOURNAL_CLEARED"
        diagnostics = @()
        marker = [ordered]@{
            state = "complete"
            resumedFromState = "absent"
            journalPresentAtInvocationStart = $true
            revision = $ExpectedRevision
            operation = "backup"
            runnerSha256 = "__RUNNER_SHA256__"
            journalSha256 = "9" * 64
            admissionInvariantSha256 = $admissionInvariantSha256
            containedStateSha256 = $containedStateSha256
        }
        captures = [ordered]@{
            admission = $admission
            before = [ordered]@{ a = $before; b = $before }
            after = $after
        }
        containment = [ordered]@{
            sourceExact = $true
            liveDisabled = $true
            financialStable = $true
            financialQuiescent = $true
            coreHealthy = $true
            coreContainerIdentitiesStable = $true
            workerStopped = $true
            caddyStopped = $true
            oneShotsStopped = $true
            maintenanceStopped = $true
            publicListenersClosed = $true
            releaseFenceAbsent = $true
            reservationValid = $true
            journalCleared = $true
            markerComplete = $true
        }
        mutations = [ordered]@{
            unitsStopRequested = 5
            containersRestartFenced = 2
            containersStopped = 2
            reservationReconciled = 0
            journalCleared = 1
            markerTransitions = 4
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
    if ($Outcome -eq "FAIL") {
        $document.exitCode = 20
        $document.result = "FAIL"
        $document.code = "MUTATION_FAILED"
        $document.diagnostics = @("MUTATION_FAILED")
        $document.marker.state = "contained_verified"
        $document.captures.after = New-ReconciliationCapture -JournalPresent $true
        $document.mutations.journalCleared = 0
        $document.mutations.markerTransitions = 2
        $document.containment.journalCleared = $false
        $document.containment.markerComplete = $false
    }
    elseif ($Outcome -eq "INCOMPLETE") {
        $document.operation = $null
        $document.exitCode = 21
        $document.result = "INCOMPLETE"
        $document.code = "JOURNAL_UNAVAILABLE"
        $document.diagnostics = @("JOURNAL_UNAVAILABLE")
        $document.marker = [ordered]@{
            state = "absent"
            resumedFromState = $null
            journalPresentAtInvocationStart = $null
            revision = $null
            operation = $null
            runnerSha256 = $null
            journalSha256 = $null
            admissionInvariantSha256 = $null
            containedStateSha256 = $null
        }
        $document.captures.admission.journal = [ordered]@{
            present = $false; operation = $null; revision = $null; status = $null; sha256 = $null
        }
        $document.captures.before.a.journal = [ordered]@{
            present = $false; operation = $null; revision = $null; status = $null; sha256 = $null
        }
        $document.captures.before.b.journal = [ordered]@{
            present = $false; operation = $null; revision = $null; status = $null; sha256 = $null
        }
        $document.mutations = [ordered]@{
            unitsStopRequested = 0
            containersRestartFenced = 0
            containersStopped = 0
            reservationReconciled = 0
            journalCleared = 0
            markerTransitions = 0
        }
        $document.containment.journalCleared = $false
        $document.containment.markerComplete = $false
    }
    $sorted = ConvertTo-RecursivelySortedValue -Value $document
    return $sorted | ConvertTo-Json -Compress -Depth 100
}

function Invoke-ContractGit {
    param(
        [Parameter(Mandatory = $true)][string] $GitExecutable,
        [Parameter(Mandatory = $true)][string[]] $Arguments
    )

    $output = @(& $GitExecutable @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw ("contract-git-failed:{0}:{1}" -f ($Arguments -join " "), (($output | ForEach-Object { [string] $_ }) -join "|"))
    }
    return ,$output
}

function New-GitProvenanceFixture {
    param(
        [Parameter(Mandatory = $true)][string] $SourceRepository,
        [Parameter(Mandatory = $true)][string] $TemporaryRoot,
        [Parameter(Mandatory = $true)][string] $GitExecutable,
        [Parameter(Mandatory = $true)][string] $Name
    )

    $fixtureRepository = Join-Path $TemporaryRoot ("git-{0}" -f [Guid]::NewGuid().ToString("N").Substring(0, 8))
    $longestFixturePath = Join-Path $fixtureRepository "docs/schemas/refunddesk-lightsail-containment-reconciliation-v1.schema.json"
    Assert-Contract -Condition ($longestFixturePath.Length -lt 200) -Code ("git-fixture-path-bound-{0}" -f $Name)
    [IO.Directory]::CreateDirectory($fixtureRepository) | Out-Null
    Set-RestrictedAcl -Path $fixtureRepository -Directory $true
    $relativePaths = @(
        "deploy/lightsail/scripts/reconcile-host-containment.sh",
        "scripts/validate-lightsail-containment-reconciliation.mjs",
        "scripts/invoke-lightsail-containment-reconciliation.ps1",
        "docs/schemas/refunddesk-lightsail-containment-reconciliation-v1.schema.json",
        "deploy/lightsail/scripts/observe-host-postflight.sh",
        "scripts/validate-lightsail-postflight.mjs",
        "scripts/invoke-lightsail-postflight.ps1",
        "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json"
    )
    foreach ($relativePath in $relativePaths) {
        $source = Join-Path $SourceRepository $relativePath
        $destination = Join-Path $fixtureRepository $relativePath
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        [IO.File]::Copy($source, $destination)
    }

    [void] (Invoke-ContractGit -GitExecutable $GitExecutable -Arguments @("init", "--quiet", $fixtureRepository))
    foreach ($setting in @(
        @("user.name", "RefundDesk Contract"),
        @("user.email", "refunddesk-contract@example.invalid"),
        @("core.autocrlf", "false"),
        @("core.filemode", "false"),
        @("core.longpaths", "true"),
        @("core.hooksPath", "NUL"),
        @("commit.gpgsign", "false")
    )) {
        [void] (Invoke-ContractGit -GitExecutable $GitExecutable -Arguments @("-C", $fixtureRepository, "config", $setting[0], $setting[1]))
    }
    [void] (Invoke-ContractGit -GitExecutable $GitExecutable -Arguments (@("-C", $fixtureRepository, "add", "--") + $relativePaths))
    [void] (Invoke-ContractGit -GitExecutable $GitExecutable -Arguments @("-C", $fixtureRepository, "commit", "--quiet", "-m", "source-a"))
    $alternateHead = ([string] @(Invoke-ContractGit -GitExecutable $GitExecutable -Arguments @("-C", $fixtureRepository, "rev-parse", "--verify", "HEAD"))[0]).Trim()
    [void] (Invoke-ContractGit -GitExecutable $GitExecutable -Arguments @("-C", $fixtureRepository, "commit", "--quiet", "--allow-empty", "-m", "source-b"))
    $head = ([string] @(Invoke-ContractGit -GitExecutable $GitExecutable -Arguments @("-C", $fixtureRepository, "rev-parse", "--verify", "HEAD"))[0]).Trim()
    Assert-Contract -Condition ($alternateHead -match "^[0-9a-f]{40}$" -and $head -match "^[0-9a-f]{40}$" -and $alternateHead -cne $head) `
        -Code "git-fixture-heads"
    foreach ($relativePath in $relativePaths) {
        $object = ([string] @(Invoke-ContractGit -GitExecutable $GitExecutable -Arguments @(
            "-C", $fixtureRepository, "rev-parse", ("{0}:{1}" -f $head, $relativePath)
        ))[0]).Trim()
        Assert-Contract -Condition ($object -match "^[0-9a-f]{40}$") -Code "git-fixture-object"
    }
    return [pscustomobject]@{
        Repository = $fixtureRepository
        WrapperPath = Join-Path $fixtureRepository "scripts/invoke-lightsail-containment-reconciliation.ps1"
        AlternateHead = $alternateHead
        Head = $head
    }
}


$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$wrapperPath = Join-Path $repository "scripts/invoke-lightsail-containment-reconciliation.ps1"
$powerShellExecutable = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$gitExecutable = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("refunddesk-cr-contract-{0}" -f [Guid]::NewGuid().ToString("N"))
$toolDirectory = Join-Path $temporaryRoot "tools"
$evidenceDirectory = Join-Path $temporaryRoot "evidence"
$templatePath = Join-Path $temporaryRoot "remote-template.json"
$failTemplatePath = Join-Path $temporaryRoot "remote-fail-template.json"
$incompleteTemplatePath = Join-Path $temporaryRoot "remote-incomplete-template.json"
$statePath = Join-Path $temporaryRoot "fake-state"

try {
    [IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
    Set-RestrictedAcl -Path $temporaryRoot -Directory $true
    [IO.Directory]::CreateDirectory($toolDirectory) | Out-Null
    [IO.Directory]::CreateDirectory($evidenceDirectory) | Out-Null

    $fakeSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class RefundDeskContainmentReconciliationFake
{
    private static string Mode {
        get { return Environment.GetEnvironmentVariable("REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_MODE") ?? "pass"; }
    }

    private static string StatePath {
        get { return Environment.GetEnvironmentVariable("REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_STATE"); }
    }

    private static string GitRepository {
        get { return Environment.GetEnvironmentVariable("REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_REPOSITORY"); }
    }

    private static bool PoisonEnvironmentPresent()
    {
        string[] names = new string[] {
            "NODE_OPTIONS", "NODE_PATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0", "SSH_AUTH_SOCK", "AWS_ENDPOINT_URL",
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE"
        };
        return names.Any(name => Environment.GetEnvironmentVariable(name) != null);
    }

    private static string ExpectedHome()
    {
        string template = Environment.GetEnvironmentVariable("REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_REMOTE_TEMPLATE");
        return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(template), "evidence"));
    }

    private static bool EnvironmentClosed(bool aws)
    {
        HashSet<string> allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "SystemRoot", "WINDIR", "PATH", "LC_ALL", "TZ", "HOME", "USERPROFILE",
            "REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_MODE",
            "REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_REMOTE_TEMPLATE",
            "REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_STATE",
            "REFUNDDESK_CONTAINMENT_RECONCILIATION_GIT_PROVENANCE_FIXTURE",
            "REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_REPOSITORY",
            "REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_GIT_ALTERNATE_HEAD"
        };
        if (aws) {
            foreach (string name in new string[] {
                "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_DEFAULT_REGION", "AWS_REGION",
                "AWS_EC2_METADATA_DISABLED", "AWS_CLI_AUTO_PROMPT", "AWS_PAGER"
            }) allowed.Add(name);
        } else {
            allowed.Add("PROGRAMDATA");
        }
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
            if (!allowed.Contains((string)entry.Key)) return false;
        }
        return true;
    }

    private static bool WriteDenied(string path)
    {
        try {
            using (FileStream stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) {
                stream.WriteByte(0x58);
                stream.Flush();
            }
            return false;
        } catch (IOException) {
            return true;
        } catch (UnauthorizedAccessException) {
            return true;
        }
    }

    private static bool RenameDenied(string path)
    {
        string destination = path + ".moved";
        try {
            if (File.Exists(destination)) File.Delete(destination);
            File.Move(path, destination);
            return false;
        } catch (IOException) {
            return true;
        } catch (UnauthorizedAccessException) {
            return true;
        }
    }

    public static int Main(string[] args)
    {
        string executable = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        if (executable == "aws") return RunAws(args);
        if (executable == "ssh") return RunSsh(args);
        return 90;
    }

    private static int RunAws(string[] args)
    {
        File.AppendAllText(StatePath + ".calls", "aws\n");
        string credentials = Environment.GetEnvironmentVariable("AWS_SHARED_CREDENTIALS_FILE");
        string home = Environment.GetEnvironmentVariable("HOME");
        if (String.IsNullOrEmpty(credentials) || !Path.IsPathRooted(credentials) || !File.Exists(credentials)) return 80;
        if (Environment.GetEnvironmentVariable("AWS_CONFIG_FILE") != "NUL") return 81;
        if (Environment.GetEnvironmentVariable("AWS_REGION") != "eu-west-3" ||
            Environment.GetEnvironmentVariable("AWS_DEFAULT_REGION") != "eu-west-3") return 82;
        if (Environment.GetEnvironmentVariable("AWS_EC2_METADATA_DISABLED") != "true" ||
            Environment.GetEnvironmentVariable("AWS_CLI_AUTO_PROMPT") != "off") return 83;
        if (PoisonEnvironmentPresent() || !EnvironmentClosed(true)) return 84;
        if (home != ExpectedHome() || Environment.GetEnvironmentVariable("USERPROFILE") != home) return 85;
        if (Directory.GetFileSystemEntries(home).Any(path =>
            String.Equals(Path.GetFileName(path), ".aws", StringComparison.OrdinalIgnoreCase))) return 86;
        int regionIndex = Array.IndexOf(args, "--region");
        if (regionIndex < 0 || regionIndex + 1 >= args.Length || args[regionIndex + 1] != "eu-west-3") return 87;
        if (Mode == "credential-write" && !WriteDenied(credentials)) return 88;
        if (Mode == "credential-rename" && !RenameDenied(credentials)) return 89;
        if (Mode == "git-race-before-ssh-index" && !File.Exists(StatePath + ".index-raced")) {
            if (String.IsNullOrEmpty(GitRepository)) return 105;
            string indexPath = Path.Combine(GitRepository, ".git", "index");
            using (FileStream stream = new FileStream(indexPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) {
                stream.Position = 0;
                stream.WriteByte(0x58);
                stream.Flush();
            }
            File.WriteAllText(StatePath + ".index-raced", "changed");
        }
        if (Mode == "aws-oversize") {
            Console.Out.Write(new string('A', 300000));
            return 0;
        }

        string joined = String.Join("\n", args);
        if (joined.Contains("get-caller-identity")) {
            Console.Out.WriteLine("{\"account\":\"633229204288\"}");
            return 0;
        }
        if (joined.Contains("get-instance-port-states")) {
            bool second = File.Exists(StatePath + ".firewall");
            if (!second) File.WriteAllText(StatePath + ".firewall", "seen");
            if (Mode == "firewall-open") {
                Console.Out.WriteLine("{\"portStates\":[{\"fromPort\":80,\"toPort\":80,\"protocol\":\"tcp\",\"state\":\"open\",\"cidrs\":[\"192.0.2.44/32\"],\"ipv6Cidrs\":[],\"cidrListAliases\":[]}]}");
                return 0;
            }
            string closedRule = Mode == "firewall-change" && second
                ? ",{\"fromPort\":443,\"toPort\":443,\"protocol\":\"tcp\",\"state\":\"closed\",\"cidrs\":[],\"ipv6Cidrs\":[],\"cidrListAliases\":[]}"
                : "";
            Console.Out.WriteLine("{\"portStates\":[{\"fromPort\":22,\"toPort\":22,\"protocol\":\"tcp\",\"state\":\"open\",\"cidrs\":[\"192.0.2.44/32\"],\"ipv6Cidrs\":[],\"cidrListAliases\":[]}" + closedRule + "]}");
            return 0;
        }
        if (joined.Contains("get-instance")) {
            Console.Out.WriteLine("{\"name\":\"refunddesk-sandbox-paris\",\"state\":\"running\",\"publicIpAddress\":\"192.0.2.10\"}");
            return 0;
        }
        return 91;
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using (SHA256 algorithm = SHA256.Create()) {
            return BitConverter.ToString(algorithm.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }
    }

    private static int RunSsh(string[] args)
    {
        File.AppendAllText(StatePath + ".calls", "ssh\n");
        if (PoisonEnvironmentPresent() || !EnvironmentClosed(false)) return 92;
        if (Environment.GetEnvironmentVariable("AWS_SHARED_CREDENTIALS_FILE") != null ||
            Environment.GetEnvironmentVariable("AWS_CONFIG_FILE") != null) return 93;
        string home = Environment.GetEnvironmentVariable("HOME");
        if (home != ExpectedHome() || Environment.GetEnvironmentVariable("USERPROFILE") != home ||
            Environment.GetEnvironmentVariable("PROGRAMDATA") != home) return 94;
        if (Directory.GetFileSystemEntries(home).Any(path => {
            string name = Path.GetFileName(path);
            return String.Equals(name, ".ssh", StringComparison.OrdinalIgnoreCase) ||
                String.Equals(name, "ssh", StringComparison.OrdinalIgnoreCase);
        })) return 95;

        byte[] input;
        using (MemoryStream stream = new MemoryStream()) {
            Console.OpenStandardInput().CopyTo(stream);
            input = stream.ToArray();
        }
        if (input.Length == 0 || input[input.Length - 1] != 10 || input.Contains((byte)0) || input.Contains((byte)13)) return 96;
        if (args.Length < 6) return 97;
        string[] tail = args.Skip(args.Length - 6).ToArray();
        if (tail[0] != "--nonce" || !Regex.IsMatch(tail[1], "^[0-9a-f]{64}$") ||
            tail[2] != "--expected-revision" || tail[3] != "8da280b78a9d1475c7bd79063e72c5af77121e8d" ||
            tail[4] != "--runner-sha256" || tail[5] != Sha256Hex(input)) return 98;
        string[] required = new string[] {
            "BatchMode=yes", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no",
            "PreferredAuthentications=publickey", "IdentitiesOnly=yes", "IdentityAgent=none",
            "StrictHostKeyChecking=yes", "CheckHostIP=yes", "UpdateHostKeys=no", "ForwardAgent=no",
            "ClearAllForwardings=yes", "PermitLocalCommand=no", "RequestTTY=no", "sudo",
            "--non-interactive", "/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
            "LC_ALL=C", "TZ=UTC", "/bin/bash", "--noprofile", "--norc", "-s", "--"
        };
        if (required.Any(value => !args.Contains(value))) return 99;
        int identityIndex = Array.IndexOf(args, "-i");
        string identityPath = identityIndex >= 0 && identityIndex + 1 < args.Length ? args[identityIndex + 1] : "";
        string knownHostsArgument = args.FirstOrDefault(value => value.StartsWith("UserKnownHostsFile=", StringComparison.Ordinal));
        string knownHostsPath = knownHostsArgument == null ? "" : knownHostsArgument.Substring("UserKnownHostsFile=".Length);
        if (String.IsNullOrEmpty(identityPath) || String.IsNullOrEmpty(knownHostsPath)) return 100;
        if (Mode == "identity-write" && !WriteDenied(identityPath)) return 101;
        if (Mode == "identity-rename" && !RenameDenied(identityPath)) return 102;
        if (Mode == "known-hosts-write" && !WriteDenied(knownHostsPath)) return 103;
        if (Mode == "known-hosts-rename" && !RenameDenied(knownHostsPath)) return 104;
        if (Mode == "git-race-during-ssh-worktree") {
            if (String.IsNullOrEmpty(GitRepository)) return 106;
            string wrapperPath = Path.Combine(GitRepository, "scripts", "invoke-lightsail-containment-reconciliation.ps1");
            File.AppendAllText(wrapperPath, "\n", new UTF8Encoding(false));
        }

        if (Mode == "timeout") {
            Thread.Sleep(10000);
            return 0;
        }
        if (Mode == "ssh-oversize") {
            Console.Out.Write(new string('A', 200000));
            return 0;
        }
        string template = File.ReadAllText(
            Environment.GetEnvironmentVariable("REFUNDDESK_CONTAINMENT_RECONCILIATION_FAKE_REMOTE_TEMPLATE")
        );
        string time = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
        string nonce = Mode == "nonce-mismatch" ? new string('f', 64) : tail[1];
        string runner = Mode == "runner-mismatch" ? new string('e', 64) : tail[5];
        string output = template.Replace("__NONCE__", nonce)
            .Replace("__RUNNER_SHA256__", runner)
            .Replace("__TIME__", time);
        if (Mode == "secret-stderr") {
            Console.Error.WriteLine(String.Join("_", new string[] { "sk", "test", new string('Z', 24) }));
        }
        if (Mode == "cr-output") Console.Out.Write(output + "\r\n");
        else Console.Out.Write(output + "\n");
        if (Mode == "remote-fail") return 20;
        if (Mode == "remote-incomplete") return 21;
        return 0;
    }
}
'@

    $compiledPath = Join-Path $toolDirectory "fake.exe"
    Add-Type -TypeDefinition $fakeSource -Language CSharp -OutputAssembly $compiledPath -OutputType ConsoleApplication
    [IO.File]::Copy($compiledPath, (Join-Path $toolDirectory "aws.exe"))
    [IO.File]::Copy($compiledPath, (Join-Path $toolDirectory "ssh.exe"))
    [IO.File]::WriteAllText((Join-Path $toolDirectory "identity.fixture"), "fixture identity" + [char] 10, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $toolDirectory "known_hosts.fixture"), "fixture known host" + [char] 10, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $toolDirectory "aws-credentials.fixture"), "[default]" + [char] 10 + "fixture=true" + [char] 10, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($templatePath, (New-RemoteTemplate -Outcome "PASS"), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($failTemplatePath, (New-RemoteTemplate -Outcome "FAIL"), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($incompleteTemplatePath, (New-RemoteTemplate -Outcome "INCOMPLETE"), [Text.UTF8Encoding]::new($false))

    $initialPreflightPath = Join-Path $temporaryRoot "preflight-initial.json"
    Write-RestrictedJson -Path $initialPreflightPath -Value (New-PostflightEvidence -Profile "INITIAL")

    $passEvidence = Join-Path $evidenceDirectory "pass.json"
    $pass = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory `
        -EvidencePath $passEvidence -PreflightPath $initialPreflightPath -TemplatePath $templatePath -Mode "pass" -StatePath $statePath
    if ($pass.ExitCode -ne 0) {
        throw ("contract-pass-failed:{0}:{1}:{2}" -f $pass.ExitCode, $pass.Stdout, $pass.Stderr)
    }
    Assert-Contract -Condition ($pass.ExitCode -eq 0) -Code "pass-exit"
    Assert-Contract -Condition ($pass.Stdout -ceq "CONTAINMENT_RECONCILIATION_FIXTURE_COMPLETE`r`n") -Code "pass-stdout"
    Assert-Contract -Condition ([string]::IsNullOrEmpty($pass.Stderr)) -Code "pass-stderr"
    Assert-Contract -Condition ([IO.File]::Exists($passEvidence)) -Code "pass-evidence-missing"
    $passText = [IO.File]::ReadAllText($passEvidence)
    $passDocument = $passText | ConvertFrom-Json
    Assert-Contract -Condition ($passDocument.kind -ceq "refunddesk.lightsail.containment-reconciliation.capture") -Code "pass-kind"
    Assert-Contract -Condition ($passDocument.result -ceq "PASS") -Code "pass-result"
    Assert-Contract -Condition ($passDocument.code -ceq "PASS_CONTAINED_JOURNAL_CLEARED") -Code "pass-code"
    Assert-Contract -Condition ($passDocument.admission -ceq "FIXTURE_ONLY") -Code "pass-admission"
    Assert-Contract -Condition ($passDocument.preflight.profile -ceq "INITIAL_COHERENT_RUNNING") -Code "pass-preflight-profile"
    Assert-Contract -Condition ($passDocument.awsControlPlane.firewallUnchanged -eq $true) -Code "pass-firewall"
    Assert-Contract -Condition ($passDocument.provenance.transportInputsPinned -eq $true) -Code "pass-pins"
    Assert-Contract -Condition ($passDocument.provenance.fixtureOnly -eq $true) -Code "pass-fixture"
    Assert-Contract -Condition ($passDocument.provenance.runner.sha256 -ceq $passDocument.remote.marker.runnerSha256) -Code "pass-runner-binding"
    Assert-Contract -Condition ($passText -notmatch '(?:192\.0\.2\.10|identity\.fixture|known_hosts\.fixture|REFUNDDESK_CONTAINMENT)') -Code "pass-private-value"
    Assert-Contract -Condition ($passText -notmatch '\b(?:sk|rk)_(?:live|test)_') -Code "pass-secret"

    $passAcl = Get-Acl -LiteralPath $passEvidence
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $requiredSids = @($currentSid, "S-1-5-18", "S-1-5-32-544")
    Assert-Contract -Condition ($passAcl.AreAccessRulesProtected) -Code "evidence-acl-protected"
    Assert-Contract -Condition ($passAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $currentSid) -Code "evidence-owner"
    $rules = @($passAcl.Access)
    Assert-Contract -Condition ($rules.Count -eq 3) -Code "evidence-acl-count"
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        Assert-Contract -Condition (
            -not $rule.IsInherited -and
            $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $rule.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
            $requiredSids -contains $sid
        ) -Code "evidence-acl-rule"
    }

    foreach ($remoteOutcome in @(
        [pscustomobject]@{ Mode = "remote-fail"; Template = $failTemplatePath; ExitCode = 20; Result = "FAIL" },
        [pscustomobject]@{ Mode = "remote-incomplete"; Template = $incompleteTemplatePath; ExitCode = 21; Result = "INCOMPLETE" }
    )) {
        Remove-Item -LiteralPath ($statePath + ".firewall") -Force -ErrorAction SilentlyContinue
        $remoteEvidencePath = Join-Path $evidenceDirectory ("{0}.json" -f $remoteOutcome.Mode)
        $remoteResult = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory `
            -EvidencePath $remoteEvidencePath -PreflightPath $initialPreflightPath -TemplatePath $remoteOutcome.Template `
            -Mode $remoteOutcome.Mode -StatePath $statePath
        Assert-Contract -Condition ($remoteResult.ExitCode -eq $remoteOutcome.ExitCode) -Code ("remote-exit-{0}" -f $remoteOutcome.Mode)
        Assert-Contract -Condition ([string]::IsNullOrEmpty($remoteResult.Stderr)) -Code ("remote-stderr-{0}" -f $remoteOutcome.Mode)
        Assert-Contract -Condition ([IO.File]::Exists($remoteEvidencePath)) -Code ("remote-evidence-{0}" -f $remoteOutcome.Mode)
        $remoteEvidence = [IO.File]::ReadAllText($remoteEvidencePath) | ConvertFrom-Json
        Assert-Contract -Condition ($remoteEvidence.result -ceq $remoteOutcome.Result) -Code ("remote-result-{0}" -f $remoteOutcome.Mode)
    }

    foreach ($gitCase in @(
        [pscustomobject]@{ Name = "bound-pass"; Mode = "git-provenance-pass"; ExitCode = 0; Calls = "ssh" },
        [pscustomobject]@{ Name = "source-head"; Mode = "git-race-source-head"; ExitCode = 1; Calls = $null },
        [pscustomobject]@{ Name = "before-ssh-index"; Mode = "git-race-before-ssh-index"; ExitCode = 1; Calls = "aws-only" },
        [pscustomobject]@{ Name = "during-ssh-worktree"; Mode = "git-race-during-ssh-worktree"; ExitCode = 1; Calls = "ssh" }
    )) {
        $gitFixture = New-GitProvenanceFixture -SourceRepository $repository -TemporaryRoot $temporaryRoot `
            -GitExecutable $gitExecutable -Name $gitCase.Name
        $gitStatePath = Join-Path $temporaryRoot ("fake-state-git-{0}" -f $gitCase.Name)
        $gitEvidencePath = Join-Path $evidenceDirectory ("git-{0}.json" -f $gitCase.Name)
        $gitResult = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable `
            -WrapperPath $gitFixture.WrapperPath -ToolDirectory $toolDirectory `
            -EvidencePath $gitEvidencePath -PreflightPath $initialPreflightPath -TemplatePath $templatePath `
            -Mode $gitCase.Mode -StatePath $gitStatePath -TimeoutSeconds 5 `
            -GitFixtureRepository $gitFixture.Repository -GitAlternateHead $gitFixture.AlternateHead `
            -ProcessTimeoutMilliseconds 180000
        if ($gitResult.ExitCode -ne $gitCase.ExitCode) {
            throw ("contract-git-case-failed:{0}:{1}:{2}:{3}" -f $gitCase.Name, $gitResult.ExitCode, $gitResult.Stdout, $gitResult.Stderr)
        }
        Assert-Contract -Condition ($gitResult.ExitCode -eq $gitCase.ExitCode) -Code ("git-race-exit-{0}" -f $gitCase.Name)
        if ($gitCase.ExitCode -eq 0) {
            Assert-Contract -Condition ([IO.File]::Exists($gitEvidencePath)) -Code ("git-bound-evidence-{0}" -f $gitCase.Name)
            $gitEvidence = [IO.File]::ReadAllText($gitEvidencePath) | ConvertFrom-Json
            Assert-Contract -Condition ($gitEvidence.provenance.repositoryHead -ceq $gitFixture.Head) -Code "git-bound-head"
            Assert-Contract -Condition ($gitEvidence.provenance.wrapper.gitObject -match "^[0-9a-f]{40}$") -Code "git-bound-wrapper-object"
        }
        else {
            Assert-Contract -Condition (-not [IO.File]::Exists($gitEvidencePath)) -Code ("git-race-evidence-{0}" -f $gitCase.Name)
            Assert-Contract -Condition (($gitResult.Stdout + $gitResult.Stderr) -match '^containment-reconciliation-error:[A-Z][A-Z0-9_]{0,63}\r?\n$') `
                -Code ("git-race-safe-{0}" -f $gitCase.Name)
        }
        $gitCallsPath = $gitStatePath + ".calls"
        if ($null -eq $gitCase.Calls) {
            Assert-Contract -Condition (-not [IO.File]::Exists($gitCallsPath)) -Code ("git-race-pre-effect-{0}" -f $gitCase.Name)
        }
        elseif ($gitCase.Calls -ceq "aws-only") {
            $gitCalls = if ([IO.File]::Exists($gitCallsPath)) { [IO.File]::ReadAllText($gitCallsPath) } else { "" }
            Assert-Contract -Condition ($gitCalls -match "aws" -and $gitCalls -notmatch "ssh") -Code ("git-race-aws-only-{0}" -f $gitCase.Name)
        }
        else {
            $gitCalls = if ([IO.File]::Exists($gitCallsPath)) { [IO.File]::ReadAllText($gitCallsPath) } else { "" }
            Assert-Contract -Condition ($gitCalls -match "ssh") -Code ("git-race-ssh-{0}" -f $gitCase.Name)
        }
    }


    foreach ($transportMutation in @(
        [pscustomobject]@{ Mode = "identity-write"; File = (Join-Path $toolDirectory "identity.fixture") },
        [pscustomobject]@{ Mode = "identity-rename"; File = (Join-Path $toolDirectory "identity.fixture") },
        [pscustomobject]@{ Mode = "known-hosts-write"; File = (Join-Path $toolDirectory "known_hosts.fixture") },
        [pscustomobject]@{ Mode = "known-hosts-rename"; File = (Join-Path $toolDirectory "known_hosts.fixture") },
        [pscustomobject]@{ Mode = "credential-write"; File = (Join-Path $toolDirectory "aws-credentials.fixture") },
        [pscustomobject]@{ Mode = "credential-rename"; File = (Join-Path $toolDirectory "aws-credentials.fixture") }
    )) {
        Remove-Item -LiteralPath ($statePath + ".firewall") -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ($transportMutation.File + ".moved") -Force -ErrorAction SilentlyContinue
        $beforeTransportHash = (Get-FileHash -LiteralPath $transportMutation.File -Algorithm SHA256).Hash
        $transportEvidencePath = Join-Path $evidenceDirectory ("transport-{0}.json" -f $transportMutation.Mode)
        $transportResult = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory `
            -EvidencePath $transportEvidencePath -PreflightPath $initialPreflightPath -TemplatePath $templatePath `
            -Mode $transportMutation.Mode -StatePath $statePath
        Assert-Contract -Condition ($transportResult.ExitCode -eq 0) -Code ("transport-lock-exit-{0}" -f $transportMutation.Mode)
        Assert-Contract -Condition ([IO.File]::Exists($transportEvidencePath)) -Code ("transport-lock-evidence-{0}" -f $transportMutation.Mode)
        Assert-Contract -Condition ([IO.File]::Exists($transportMutation.File)) -Code ("transport-lock-source-{0}" -f $transportMutation.Mode)
        Assert-Contract -Condition (-not [IO.File]::Exists($transportMutation.File + ".moved")) -Code ("transport-lock-rename-{0}" -f $transportMutation.Mode)
        Assert-Contract -Condition ((Get-FileHash -LiteralPath $transportMutation.File -Algorithm SHA256).Hash -ceq $beforeTransportHash) `
            -Code ("transport-lock-hash-{0}" -f $transportMutation.Mode)
    }


    foreach ($resumeCase in @(
        [pscustomobject]@{ Profile = "PENDING"; Expected = "RESUME_JOURNAL_PARTIAL" },
        [pscustomobject]@{ Profile = "PARTIAL_TIMER_SUBSET"; Expected = "RESUME_JOURNAL_PARTIAL" },
        [pscustomobject]@{ Profile = "PARTIAL_CADDY_STOPPED"; Expected = "RESUME_JOURNAL_PARTIAL" },
        [pscustomobject]@{ Profile = "PARTIAL_STOPPED_MIXED"; Expected = "RESUME_JOURNAL_PARTIAL" },
        [pscustomobject]@{ Profile = "CLEARED"; Expected = "RESUME_JOURNAL_CLEARED" }
    )) {
        $resumeProfile = $resumeCase.Profile
        Remove-Item -LiteralPath ($statePath + ".firewall") -Force -ErrorAction SilentlyContinue
        $resumePreflightPath = Join-Path $temporaryRoot ("preflight-{0}.json" -f $resumeProfile.ToLowerInvariant())
        Write-RestrictedJson -Path $resumePreflightPath -Value (New-PostflightEvidence -Profile $resumeProfile)
        $resumeEvidencePath = Join-Path $evidenceDirectory ("resume-{0}.json" -f $resumeProfile.ToLowerInvariant())
        $resume = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory `
            -EvidencePath $resumeEvidencePath -PreflightPath $resumePreflightPath -TemplatePath $templatePath -Mode "pass" -StatePath $statePath
        if ($resume.ExitCode -ne 0) {
            throw ("contract-resume-failed:{0}:{1}:{2}:{3}" -f $resumeProfile, $resume.ExitCode, $resume.Stdout, $resume.Stderr)
        }
        Assert-Contract -Condition ($resume.ExitCode -eq 0) -Code ("resume-exit-{0}" -f $resumeProfile)
        Assert-Contract -Condition ([IO.File]::Exists($resumeEvidencePath)) -Code ("resume-evidence-{0}" -f $resumeProfile)
        $resumeEvidence = [IO.File]::ReadAllText($resumeEvidencePath) | ConvertFrom-Json
        Assert-Contract -Condition ($resumeEvidence.preflight.profile -ceq $resumeCase.Expected) `
            -Code ("resume-profile-{0}" -f $resumeProfile)
    }

    $duplicateHash = (Get-FileHash -LiteralPath $passEvidence -Algorithm SHA256).Hash
    Remove-Item -LiteralPath ($statePath + ".firewall") -Force -ErrorAction SilentlyContinue
    $duplicate = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory `
        -EvidencePath $passEvidence -PreflightPath $initialPreflightPath -TemplatePath $templatePath -Mode "pass" -StatePath $statePath
    Assert-Contract -Condition ($duplicate.ExitCode -eq 1) -Code "create-new-exit"
    Assert-Contract -Condition ((Get-FileHash -LiteralPath $passEvidence -Algorithm SHA256).Hash -ceq $duplicateHash) -Code "create-new-preserved"

    $badPreflights = @(
        [pscustomobject]@{ Name = "validity"; Profile = "INITIAL"; Mutate = { param($value) $value.validUntil = ([DateTime]::Parse($value.capturedAt)).AddMinutes(10).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") } },
        [pscustomobject]@{ Name = "diagnostics"; Profile = "INITIAL"; Mutate = { param($value) $value.remote.diagnostics = @("CADDY_RUNNING") } },
        [pscustomobject]@{ Name = "revision"; Profile = "INITIAL"; Mutate = { param($value) $value.remote.captures.a.identity.activeRevision = "7" * 40 } },
        [pscustomobject]@{ Name = "aws-open"; Profile = "INITIAL"; Mutate = { param($value) $value.awsControlPlane.firewallClosedAfter = $false } },
        [pscustomobject]@{ Name = "live"; Profile = "INITIAL"; Mutate = { param($value) $value.remote.containment.liveDisabled = $false } },
        [pscustomobject]@{ Name = "finance"; Profile = "INITIAL"; Mutate = { param($value) $value.remote.financial.stable = $false } },
        [pscustomobject]@{ Name = "source-record"; Profile = "INITIAL"; Mutate = { param($value) $value.provenance.observer.sha256 = "not-a-digest" } },
        [pscustomobject]@{ Name = "remote-hash"; Profile = "INITIAL"; Mutate = { param($value) $value.provenance.remoteDocumentSha256 = "0" * 64 } },
        [pscustomobject]@{ Name = "partial-posture"; Profile = "PARTIAL_TIMER_SUBSET"; Mutate = { param($value) $value.posture = "COHERENT_RUNNING"; $value.remote.posture = "COHERENT_RUNNING" } },
        [pscustomobject]@{ Name = "single-listener"; Profile = "PARTIAL_TIMER_SUBSET"; Mutate = { param($value) $value.remote.captures.a.surface.tcp443Listening = $false; $value.remote.captures.b.surface.tcp443Listening = $false; $value.remote.diagnostics = @("CADDY_RUNNING", "MAINTENANCE_ACTIVE", "PUBLIC_LISTENER_ACTIVE", "UNEXPECTED_RUNNING_CONTAINER", "UNRESOLVED_JOURNAL", "WORKER_RUNNING") } },
        [pscustomobject]@{ Name = "caddy-stopped-timer-active"; Profile = "PARTIAL_CADDY_STOPPED"; Mutate = { param($value) $value.remote.captures.a.surface.backupTimerActive = $true; $value.remote.captures.b.surface.backupTimerActive = $true; $value.remote.containment.maintenanceStopped = $false; $value.remote.diagnostics = @("MAINTENANCE_ACTIVE", "UNEXPECTED_RUNNING_CONTAINER", "UNRESOLVED_JOURNAL", "WORKER_RUNNING"); $value.remote.code = "MAINTENANCE_ACTIVE" } },
        [pscustomobject]@{ Name = "worker-stopped-caddy-running"; Profile = "PARTIAL_CADDY_STOPPED"; Mutate = { param($value) foreach ($captureName in @("a", "b")) { $worker = @($value.remote.captures.$captureName.containers | Where-Object { $_.service -ceq "worker" })[0]; $caddy = @($value.remote.captures.$captureName.containers | Where-Object { $_.service -ceq "caddy" })[0]; $worker.status = "EXITED"; $worker.health = "HEALTHY"; $caddy.status = "RUNNING"; $caddy.health = "HEALTHY" }; $value.remote.containment.workerStopped = $true; $value.remote.containment.caddyStopped = $false; $value.remote.captures.a.surface.unexpectedRunningContainerCount = 1; $value.remote.captures.b.surface.unexpectedRunningContainerCount = 1; $value.remote.diagnostics = @("CADDY_RUNNING", "UNEXPECTED_RUNNING_CONTAINER", "UNRESOLVED_JOURNAL"); $value.remote.code = "CADDY_RUNNING" } }
    )
    foreach ($case in $badPreflights) {
        Remove-Item -LiteralPath ($statePath + ".calls") -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ($statePath + ".firewall") -Force -ErrorAction SilentlyContinue
        $value = New-PostflightEvidence -Profile $case.Profile
        & $case.Mutate $value
        if ($case.Name -ne "remote-hash") {
            $mutatedRemoteBytes = [Text.UTF8Encoding]::new($false).GetBytes(
                (($value.remote | ConvertTo-Json -Compress -Depth 100) + [char] 10)
            )
            $value.provenance.remoteDocumentSha256 = Get-Sha256Hex -Bytes $mutatedRemoteBytes
        }
        $badPath = Join-Path $temporaryRoot ("bad-preflight-{0}.json" -f $case.Name)
        Write-RestrictedJson -Path $badPath -Value $value
        $badEvidence = Join-Path $evidenceDirectory ("bad-preflight-{0}.json" -f $case.Name)
        $result = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory `
            -EvidencePath $badEvidence -PreflightPath $badPath -TemplatePath $templatePath -Mode "pass" -StatePath $statePath
        Assert-Contract -Condition ($result.ExitCode -eq 1) -Code ("bad-preflight-exit-{0}" -f $case.Name)
        Assert-Contract -Condition (-not [IO.File]::Exists($badEvidence)) -Code ("bad-preflight-evidence-{0}" -f $case.Name)
        Assert-Contract -Condition (-not [IO.File]::Exists($statePath + ".calls")) -Code ("bad-preflight-pre-effect-{0}" -f $case.Name)
        Assert-Contract -Condition (($result.Stdout + $result.Stderr) -match '^containment-reconciliation-error:[A-Z][A-Z0-9_]{0,63}\r?\n$') -Code ("bad-preflight-safe-{0}" -f $case.Name)
    }

    $injectionEvidence = Join-Path $evidenceDirectory "cidr-injection.json"
    $injection = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory `
        -EvidencePath $injectionEvidence -PreflightPath $initialPreflightPath -TemplatePath $templatePath -Mode "pass" `
        -StatePath $statePath -ExpectedSshCidr "192.0.2.44/32;Write-Output injected"
    Assert-Contract -Condition ($injection.ExitCode -eq 1) -Code "injection-exit"
    Assert-Contract -Condition (-not [IO.File]::Exists($injectionEvidence)) -Code "injection-evidence"
    Assert-Contract -Condition (($injection.Stdout + $injection.Stderr) -notmatch "injected\r?\n") -Code "injection-output"

    foreach ($mode in @(
        "timeout", "ssh-oversize", "aws-oversize", "firewall-change",
        "firewall-open", "nonce-mismatch", "runner-mismatch", "cr-output", "secret-stderr"
    )) {
        Remove-Item -LiteralPath ($statePath + ".firewall") -Force -ErrorAction SilentlyContinue
        $failureEvidence = Join-Path $evidenceDirectory ("failure-{0}.json" -f $mode)
        $caseTimeout = if ($mode -in @("ssh-oversize", "aws-oversize")) { 5 } else { 1 }
        $failure = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory `
            -EvidencePath $failureEvidence -PreflightPath $initialPreflightPath -TemplatePath $templatePath -Mode $mode `
            -StatePath $statePath -TimeoutSeconds $caseTimeout
        Assert-Contract -Condition ($failure.ExitCode -eq 1) -Code ("failure-exit-{0}" -f $mode)
        Assert-Contract -Condition (-not [IO.File]::Exists($failureEvidence)) -Code ("failure-evidence-{0}" -f $mode)
        $combined = $failure.Stdout + $failure.Stderr
        Assert-Contract -Condition ($combined -match '^containment-reconciliation-error:[A-Z][A-Z0-9_]{0,63}\r?\n$') -Code ("failure-safe-{0}" -f $mode)
        Assert-Contract -Condition ($combined.Length -le 160) -Code ("failure-bound-{0}" -f $mode)
        Assert-Contract -Condition ($combined -notmatch '\b(?:sk|rk)_(?:live|test)_') -Code ("failure-redacted-{0}" -f $mode)
    }

    $wrapperSource = [IO.File]::ReadAllText($wrapperPath)
    foreach ($requiredSource in @(
        "ProcessStartInfo", "EnvironmentVariables.Clear()", "FileMode]::CreateNew", "FileShare]::Read",
        "Open-BoundedEvidenceLock", "Open-VerifiedReadLock", "Open-PinnedTransportLock",
        "Assert-PinnedTransportLockUnchanged", "Open-RestrictedCredentialLock",
        "Assert-RestrictedCredentialLockUnchanged", "ReadAsync", "PROCESS_STDOUT_LIMIT", "PROCESS_TIMEOUT",
        'C:\Program Files\Amazon\AWSCLIV2\aws.exe', 'C:\Windows\System32\OpenSSH\ssh.exe',
        'C:\Program Files\nodejs\node.exe', 'C:\Program Files\Git\cmd\git.exe',
        "GIT_NO_REPLACE_OBJECTS", "Assert-IsolatedAwsHome", "Assert-IsolatedSshHome",
        '$commitPath = "{0}:{1}" -f $CommitOid, $RelativePath', '$indexPath = ":{0}" -f $RelativePath',
        "Assert-RepositorySourcesAtCommit", "REPOSITORY_HEAD_CHANGED", "SOURCE_PROVENANCE_CHANGED",
        "WorktreeSha256", "IndexSha256", "CommitSha256", '"cat-file", "blob"',
        "--expected-runner-sha256",
        "--expected-revision", "--runner-sha256", "PREFLIGHT_VALIDITY_INSUFFICIENT",
        "INITIAL_COHERENT_RUNNING", "RESUME_JOURNAL_PARTIAL", "RESUME_JOURNAL_CLEARED",
        "ADMISSIBLE_EXACT_8DA_CONTAINMENT_RECONCILIATION", '"FAIL" { exit 20 }', '"INCOMPLETE" { exit 21 }'
    )) {
        Assert-Contract -Condition ($wrapperSource.Contains($requiredSource)) -Code ("source-{0}" -f $requiredSource)
    }
    foreach ($forbiddenSource in @("Start-Process", "ReadToEnd(", "HEAD:")) {
        Assert-Contract -Condition (-not $wrapperSource.Contains($forbiddenSource)) -Code ("forbidden-source-{0}" -f $forbiddenSource)
    }
    $credentialLockStart = $wrapperSource.IndexOf("function Open-RestrictedCredentialLock", [StringComparison]::Ordinal)
    $credentialLockEnd = $wrapperSource.IndexOf("function Assert-RestrictedCredentialFile", $credentialLockStart, [StringComparison]::Ordinal)
    Assert-Contract -Condition ($credentialLockStart -ge 0 -and $credentialLockEnd -gt $credentialLockStart) -Code "credential-lock-source-range"
    $credentialLockSource = $wrapperSource.Substring($credentialLockStart, $credentialLockEnd - $credentialLockStart)
    Assert-Contract -Condition ($credentialLockSource -notmatch "ReadAllBytes|ComputeHash|ReadByte|ReadAsync") -Code "credential-lock-never-reads-bytes"

    [Console]::Out.WriteLine("PASS: invoke-lightsail-containment-reconciliation contract fixtures")
}
finally {
    $fullTemporaryRoot = [IO.Path]::GetFullPath($temporaryRoot)
    $fullSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (
        $fullTemporaryRoot.StartsWith($fullSystemTemp, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fullTemporaryRoot).StartsWith("refunddesk-cr-contract-", [StringComparison]::Ordinal)
    ) {
        foreach ($temporaryFile in [IO.Directory]::EnumerateFiles($fullTemporaryRoot, "*", [IO.SearchOption]::AllDirectories)) {
            try { [IO.File]::SetAttributes($temporaryFile, [IO.FileAttributes]::Normal) }
            catch { }
        }
        [IO.Directory]::Delete($fullTemporaryRoot, $true)
    }
}
