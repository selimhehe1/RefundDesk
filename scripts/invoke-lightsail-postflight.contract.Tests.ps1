[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$FixtureExpectedSshCidr = "192.0.2.44/32"

function Assert-Contract {
    param([Parameter(Mandatory = $true)][bool] $Condition, [Parameter(Mandatory = $true)][string] $Code)
    if (-not $Condition) {
        throw "contract-assertion-failed:$Code"
    }
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
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow
            )
            [void] $security.AddAccessRule($rule)
        }
        [IO.Directory]::SetAccessControl($Path, $security)
    }
    else {
        $security = [Security.AccessControl.FileSecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        foreach ($sid in $sids) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow
            )
            [void] $security.AddAccessRule($rule)
        }
        [IO.File]::SetAccessControl($Path, $security)
    }
}

function ConvertTo-TestArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-WrapperFixture {
    param(
        [Parameter(Mandatory = $true)][string] $PowerShellExecutable,
        [Parameter(Mandatory = $true)][string] $WrapperPath,
        [Parameter(Mandatory = $true)][string] $ToolDirectory,
        [Parameter(Mandatory = $true)][string] $EvidencePath,
        [Parameter(Mandatory = $true)][string] $TemplatePath,
        [Parameter(Mandatory = $true)][string] $Mode,
        [Parameter(Mandatory = $true)][string] $StatePath,
        [Parameter()][AllowEmptyString()][string] $ExpectedSshCidr = $FixtureExpectedSshCidr,
        [Parameter()][ValidateRange(1, 15)][int] $TimeoutSeconds = 1
    )

    $arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $WrapperPath,
        "-ContractFixture",
        "-FixtureToolDirectory", $ToolDirectory,
        "-FixtureEvidencePath", $EvidencePath,
        "-FixtureTimeoutSeconds", ([string] $TimeoutSeconds),
        "-ExpectedSshCidr", $ExpectedSshCidr
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $PowerShellExecutable
    $startInfo.Arguments = (($arguments | ForEach-Object { ConvertTo-TestArgument $_ }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables["REFUNDDESK_POSTFLIGHT_CONTRACT_MODE"] = "1"
    $startInfo.EnvironmentVariables["REFUNDDESK_POSTFLIGHT_FAKE_MODE"] = $Mode
    $startInfo.EnvironmentVariables["REFUNDDESK_POSTFLIGHT_FAKE_REMOTE_TEMPLATE"] = $TemplatePath
    $startInfo.EnvironmentVariables["REFUNDDESK_POSTFLIGHT_FAKE_STATE"] = $StatePath
    $startInfo.EnvironmentVariables["NODE_OPTIONS"] = "--require=C:\refunddesk-does-not-exist.js"
    $startInfo.EnvironmentVariables["NODE_PATH"] = "C:\refunddesk-poison"
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
        if (-not $process.WaitForExit(20000)) {
            $process.Kill()
            throw "contract-assertion-failed:wrapper-timeout"
        }
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdoutTask.Result
            Stderr = $stderrTask.Result
        }
    }
    finally {
        $process.Dispose()
    }
}

function New-RemoteTemplate {
    param(
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{40}$")][string] $Revision,
        [Parameter(Mandatory = $true)][ValidatePattern("^[0-9a-f]{64}$")][string] $ComposeSha256
    )

    $revision = $Revision
    $digest = $ComposeSha256
    $containerServices = @("postgres", "verifier", "worker", "web", "caddy")
    $containers = @()
    for ($index = 0; $index -lt $containerServices.Count; $index += 1) {
        $service = $containerServices[$index]
        $running = $service -in @("postgres", "verifier", "web")
        $imageDigit = if ($service -ceq "caddy") { 6 } else { $index + 5 }
        $containers += [ordered]@{
            service = $service
            presentCount = 1
            containerId = ([string] ($index + 1)) * 64
            imageId = "sha256:" + (([string] $imageDigit) * 64)
            expectedImageId = "sha256:" + (([string] $imageDigit) * 64)
            imageReferenceMatches = $true
            noPublishedPorts = $true
            effectiveGlobalLiveDisabled = if ($service -in @("worker", "web")) { $true } else { $null }
            effectiveLiveWebhookDisabled = if ($service -ceq "web") { $true } else { $null }
            status = if ($running) { "RUNNING" } else { "EXITED" }
            health = if ($running) { "HEALTHY" } else { "NONE" }
            projectLabelMatches = $true
            serviceLabelMatches = $true
            revisionLabel = $revision
        }
    }
    $capture = [ordered]@{
        capturedAt = "__TIME__"
        identity = [ordered]@{
            activeRevision = $revision
            currentRevision = $revision
            sourceRevision = $revision
            releaseEnvironmentRevision = $revision
            manifestRevision = $revision
            composeSha256 = $digest
            installedManifestSha256 = $digest
            manifestSchemaValid = $true
        }
        containers = $containers
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
            systemIdentifier = "123456789012345678"
            activeWorkflows = 0
            unreleasedPaymentGuards = 0
            activeFinancialJobs = 0
            liveTenants = 0
            liveInstallations = 0
            preparedTransactions = 0
            refundRequests = 2
            auditEvents = 9
        }
    }
    $document = [ordered]@{
        schemaVersion = 1
        kind = "refunddesk.lightsail.host-postflight"
        nonce = "__NONCE__"
        startedAt = "__TIME__"
        completedAt = "__TIME__"
        exitCode = 0
        result = "PASS"
        code = "PASS_CONTAINED"
        posture = "COHERENT_CONTAINED"
        diagnostics = @()
        captures = [ordered]@{
            a = $capture
            b = $capture
        }
        containment = [ordered]@{
            liveDisabled = $true
            workerStopped = $true
            caddyStopped = $true
            maintenanceStopped = $true
            publicListenersClosed = $true
            journalsClosed = $true
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
        financial = [ordered]@{
            snapshotAvailable = $true
            stable = $true
            quiescent = $true
        }
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
    return $document | ConvertTo-Json -Compress -Depth 100
}

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$wrapperPath = Join-Path $repository "scripts/invoke-lightsail-postflight.ps1"
$powerShellExecutable = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("refunddesk-postflight-contract-{0}" -f [Guid]::NewGuid().ToString("N"))
$toolDirectory = Join-Path $temporaryRoot "tools"
$evidenceDirectory = Join-Path $temporaryRoot "evidence"
$templatePath = Join-Path $temporaryRoot "remote-template.json"
$statePath = Join-Path $temporaryRoot "fake-state.txt"

try {
    [IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
    Set-RestrictedAcl -Path $temporaryRoot -Directory $true
    [IO.Directory]::CreateDirectory($toolDirectory) | Out-Null
    [IO.Directory]::CreateDirectory($evidenceDirectory) | Out-Null

    $fakeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class RefundDeskPostflightFake
{
    private static string Mode { get { return Environment.GetEnvironmentVariable("REFUNDDESK_POSTFLIGHT_FAKE_MODE") ?? "pass"; } }

    private static bool PoisonEnvironmentPresent()
    {
        string[] names = new string[] {
            "NODE_OPTIONS", "NODE_PATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0", "SSH_AUTH_SOCK", "AWS_ENDPOINT_URL",
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE"
        };
        return names.Any(name => Environment.GetEnvironmentVariable(name) != null);
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
        string credentialPath = Environment.GetEnvironmentVariable("AWS_SHARED_CREDENTIALS_FILE");
        if (String.IsNullOrEmpty(credentialPath) || Path.GetFileName(credentialPath) != "aws-credentials.fixture" || !File.Exists(credentialPath)) return 80;
        if (Environment.GetEnvironmentVariable("AWS_CONFIG_FILE") != "NUL") return 81;
        if (Environment.GetEnvironmentVariable("AWS_REGION") != "eu-west-3" || Environment.GetEnvironmentVariable("AWS_DEFAULT_REGION") != "eu-west-3") return 82;
        if (Environment.GetEnvironmentVariable("AWS_EC2_METADATA_DISABLED") != "true" || Environment.GetEnvironmentVariable("AWS_CLI_AUTO_PROMPT") != "off") return 83;
        if (PoisonEnvironmentPresent()) return 84;
        int regionIndex = Array.IndexOf(args, "--region");
        if (regionIndex < 0 || regionIndex + 1 >= args.Length || args[regionIndex + 1] != "eu-west-3") return 85;
        if (Mode == "aws-oversize") {
            Console.Out.Write(new string('A', 300000));
            return 0;
        }
        string joined = string.Join("\n", args);
        if (joined.Contains("get-caller-identity")) {
            if (Mode == "tool-tamper") {
                string directory = Path.GetDirectoryName(Environment.GetCommandLineArgs()[0]);
                File.AppendAllText(Path.Combine(directory, "ssh.exe"), "tamper");
            }
            Console.Out.WriteLine("{\"account\":\"633229204288\"}");
            return 0;
        }
        if (joined.Contains("get-instance-port-states")) {
            if (Mode == "firewall-missing") {
                Console.Out.WriteLine("{}");
                return 0;
            }
            if (Mode == "firewall-empty") {
                Console.Out.WriteLine("{\"portStates\":[]}");
                return 0;
            }
            int port = Mode == "firewall-open" ? 80 : (Mode == "firewall-unexpected" ? 3000 : 22);
            if (Mode == "firewall-change") {
                string state = Environment.GetEnvironmentVariable("REFUNDDESK_POSTFLIGHT_FAKE_STATE");
                if (File.Exists(state)) port = 23; else File.WriteAllText(state, "seen");
            }
            Console.Out.WriteLine("{\"portStates\":[{\"fromPort\":" + port + ",\"toPort\":" + port + ",\"protocol\":\"tcp\",\"state\":\"open\",\"cidrs\":[\"192.0.2.44/32\"],\"ipv6Cidrs\":[],\"cidrListAliases\":[]}]}");
            return 0;
        }
        if (joined.Contains("get-instance")) {
            Console.Out.WriteLine("{\"name\":\"refunddesk-sandbox-paris\",\"state\":\"running\",\"publicIpAddress\":\"192.0.2.10\"}");
            return 0;
        }
        return 91;
    }

    private static int RunSsh(string[] args)
    {
        if (PoisonEnvironmentPresent()) return 97;
        if (Environment.GetEnvironmentVariable("AWS_SHARED_CREDENTIALS_FILE") != null || Environment.GetEnvironmentVariable("AWS_CONFIG_FILE") != null) return 98;
        using (MemoryStream input = new MemoryStream()) {
            Console.OpenStandardInput().CopyTo(input);
            byte[] bytes = input.ToArray();
            if (bytes.Length == 0 || bytes[bytes.Length - 1] != 10 || bytes.Contains((byte)0) || bytes.Contains((byte)13)) return 92;
        }
        string joined = string.Join("\n", args);
        string[] required = new string[] {
            "BatchMode=yes", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no",
            "PreferredAuthentications=publickey", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes",
            "IdentityAgent=none", "GSSAPIAuthentication=no", "CheckHostIP=yes", "UpdateHostKeys=no",
            "ForwardAgent=no", "ClearAllForwardings=yes", "PermitLocalCommand=no", "RequestTTY=no",
            "ConnectionAttempts=1", "sudo", "--non-interactive", "/usr/bin/env", "-i",
            "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C", "TZ=UTC",
            "/bin/bash", "--noprofile", "--norc", "-s", "--", "--nonce"
        };
        if (required.Any(value => !args.Contains(value))) return 93;
        int configIndex = Array.IndexOf(args, "-F");
        if (configIndex < 0 || configIndex + 1 >= args.Length || args[configIndex + 1] != "NUL") return 96;
        string[] tail = new string[] {
            "sudo", "--non-interactive", "--", "/usr/bin/env", "-i",
            "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C", "TZ=UTC",
            "/bin/bash", "--noprofile", "--norc", "-s", "--", "--nonce", args[args.Length - 1]
        };
        if (args.Length < tail.Length || !args.Skip(args.Length - tail.Length).SequenceEqual(tail)) return 95;
        string nonce = args.Length == 0 ? "" : args[args.Length - 1];
        if (!Regex.IsMatch(nonce, "^[0-9a-f]{64}$")) return 94;
        if (Mode == "timeout") {
            Thread.Sleep(10000);
            return 0;
        }
        if (Mode == "ssh-oversize") {
            Console.Out.Write(new string('A', 600000));
            return 0;
        }
        string template = File.ReadAllText(Environment.GetEnvironmentVariable("REFUNDDESK_POSTFLIGHT_FAKE_REMOTE_TEMPLATE"));
        string time = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
        string boundNonce = Mode == "nonce-mismatch" ? new string('f', 64) : nonce;
        string output = template.Replace("__NONCE__", boundNonce).Replace("__TIME__", time);
        int remoteExit = 0;
        if (Mode == "remote-fail") {
            output = output.Replace("\"exitCode\":0", "\"exitCode\":20")
                .Replace("\"result\":\"PASS\"", "\"result\":\"FAIL\"")
                .Replace("\"code\":\"PASS_CONTAINED\"", "\"code\":\"WORKER_RUNNING\"")
                .Replace("\"posture\":\"COHERENT_CONTAINED\"", "\"posture\":\"DIVERGENT\"")
                .Replace("\"diagnostics\":[]", "\"diagnostics\":[\"WORKER_RUNNING\"]")
                .Replace("\"workerStopped\":true", "\"workerStopped\":false");
            output = Regex.Replace(output, "(\\\"service\\\":\\\"worker\\\"[^}]*\\\"status\\\":)\\\"EXITED\\\"(,\\\"health\\\":)\\\"NONE\\\"", "$1\"RUNNING\"$2\"HEALTHY\"");
            remoteExit = 20;
        }
        if (Mode == "remote-incomplete") {
            output = output.Replace("\"exitCode\":0", "\"exitCode\":21")
                .Replace("\"result\":\"PASS\"", "\"result\":\"INCOMPLETE\"")
                .Replace("\"code\":\"PASS_CONTAINED\"", "\"code\":\"DATABASE_SNAPSHOT_UNREADABLE\"")
                .Replace("\"posture\":\"COHERENT_CONTAINED\"", "\"posture\":\"UNKNOWN\"")
                .Replace("\"diagnostics\":[]", "\"diagnostics\":[\"DATABASE_SNAPSHOT_UNREADABLE\"]");
            output = output.Replace("\"snapshotAvailable\":true", "\"snapshotAvailable\":false")
                .Replace("\"systemIdentifier\":\"123456789012345678\"", "\"systemIdentifier\":null")
                .Replace("\"activeWorkflows\":0", "\"activeWorkflows\":null")
                .Replace("\"unreleasedPaymentGuards\":0", "\"unreleasedPaymentGuards\":null")
                .Replace("\"activeFinancialJobs\":0", "\"activeFinancialJobs\":null")
                .Replace("\"liveTenants\":0", "\"liveTenants\":null")
                .Replace("\"liveInstallations\":0", "\"liveInstallations\":null")
                .Replace("\"preparedTransactions\":0", "\"preparedTransactions\":null")
                .Replace("\"refundRequests\":2", "\"refundRequests\":null")
                .Replace("\"auditEvents\":9", "\"auditEvents\":null")
                .Replace("\"quiescent\":true", "\"quiescent\":false");
            remoteExit = 21;
        }
        if (Mode == "remote-incomplete-missing") {
            output = output.Replace("\"exitCode\":0", "\"exitCode\":21")
                .Replace("\"result\":\"PASS\"", "\"result\":\"INCOMPLETE\"")
                .Replace("\"code\":\"PASS_CONTAINED\"", "\"code\":\"ACTIVE_REVISION_UNREADABLE\"")
                .Replace("\"posture\":\"COHERENT_CONTAINED\"", "\"posture\":\"UNKNOWN\"")
                .Replace("\"diagnostics\":[]", "\"diagnostics\":[\"ACTIVE_REVISION_UNREADABLE\"]")
                .Replace("\"metadataCoherent\":true", "\"metadataCoherent\":false")
                .Replace("\"containersCoherent\":true", "\"containersCoherent\":false");
            output = Regex.Replace(output, "\"activeRevision\":\"[0-9a-f]{40}\"", "\"activeRevision\":null");
            remoteExit = 21;
        }
        if (Mode == "secret-stderr") {
            Console.Error.WriteLine(string.Join("_", new string[] { "sk", "test", new string('Z', 24) }));
        }
        if (Mode == "cr-output") Console.Out.Write(output + "\r\n"); else Console.Out.Write(output + "\n");
        return remoteExit;
    }
}
'@
    $compiledPath = Join-Path $toolDirectory "fake.exe"
    Add-Type -TypeDefinition $fakeSource -Language CSharp -OutputAssembly $compiledPath -OutputType ConsoleApplication
    [IO.File]::Copy($compiledPath, (Join-Path $toolDirectory "aws.exe"))
    [IO.File]::Copy($compiledPath, (Join-Path $toolDirectory "ssh.exe"))
    [IO.File]::WriteAllText((Join-Path $toolDirectory "identity.fixture"), "fixture identity`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $toolDirectory "known_hosts.fixture"), "fixture known host`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $toolDirectory "aws-credentials.fixture"), "[default]`nfixture=true`n", [Text.UTF8Encoding]::new($false))
    $gitExecutable = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $revision = (& $gitExecutable --no-replace-objects -C $repository rev-parse --verify "HEAD^{commit}").Trim()
    Assert-Contract -Condition ($revision -match "^[0-9a-f]{40}$") -Code "fixture-revision"
    $composeSha256 = (Get-FileHash -LiteralPath (Join-Path $repository "deploy/lightsail/compose.yml") -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($templatePath, (New-RemoteTemplate -Revision $revision -ComposeSha256 $composeSha256), [Text.UTF8Encoding]::new($false))

    $invalidCidrCases = @(
        [pscustomobject]@{ Value = ""; Code = "EXPECTED_SSH_CIDR_INVALID" },
        [pscustomobject]@{ Value = "192.0.2.44/24"; Code = "EXPECTED_SSH_CIDR_INVALID" },
        [pscustomobject]@{ Value = "192.0.2.044/32"; Code = "EXPECTED_SSH_CIDR_INVALID" },
        [pscustomobject]@{ Value = "2001:db8::1/128"; Code = "EXPECTED_SSH_CIDR_INVALID" },
        [pscustomobject]@{ Value = "10.0.0.1/32"; Code = "FIXTURE_SSH_CIDR_INVALID" }
    )
    foreach ($invalidCidrCase in $invalidCidrCases) {
        $invalidCidrEvidence = Join-Path $evidenceDirectory ("invalid-cidr-{0}.json" -f [Guid]::NewGuid().ToString("N"))
        $invalidCidr = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory -EvidencePath $invalidCidrEvidence -TemplatePath $templatePath -Mode "pass" -StatePath $statePath -ExpectedSshCidr $invalidCidrCase.Value
        Assert-Contract -Condition ($invalidCidr.ExitCode -eq 1) -Code "invalid-cidr-exit"
        Assert-Contract -Condition (-not [IO.File]::Exists($invalidCidrEvidence)) -Code "invalid-cidr-evidence"
        Assert-Contract -Condition ($invalidCidr.Stderr -ceq ("postflight-capture-error:{0}`r`n" -f $invalidCidrCase.Code)) -Code "invalid-cidr-safe-error"
    }

    $passEvidence = Join-Path $evidenceDirectory "pass.json"
    $pass = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory -EvidencePath $passEvidence -TemplatePath $templatePath -Mode "pass" -StatePath $statePath
    Assert-Contract -Condition ($pass.ExitCode -eq 0) -Code "pass-exit"
    Assert-Contract -Condition ($pass.Stdout -ceq "POSTFLIGHT_FIXTURE_CAPTURE_COMPLETE`r`n") -Code "pass-stdout"
    Assert-Contract -Condition ([string]::IsNullOrEmpty($pass.Stderr)) -Code "pass-stderr"
    Assert-Contract -Condition ([IO.File]::Exists($passEvidence)) -Code "pass-evidence-missing"
    $passText = [IO.File]::ReadAllText($passEvidence)
    $passDocument = $passText | ConvertFrom-Json
    Assert-Contract -Condition ($passDocument.admission -ceq "FIXTURE_ONLY") -Code "fixture-admission"
    Assert-Contract -Condition ($passDocument.result -ceq "PASS") -Code "fixture-result"
    Assert-Contract -Condition ($passDocument.awsControlPlane.firewallUnchanged -eq $true) -Code "fixture-firewall"
    Assert-Contract -Condition ($passDocument.provenance.fixtureOnly -eq $true) -Code "fixture-provenance"
    Assert-Contract -Condition ($passDocument.provenance.revisionComposeVerified -eq $true) -Code "fixture-revision-compose"
    Assert-Contract -Condition ($null -eq $passDocument.provenance.repositoryHead) -Code "fixture-repository-head"
    Assert-Contract -Condition ($passText -notmatch '(?:192\.0\.2\.10|identity\.fixture|known_hosts\.fixture|REFUNDDESK_POSTFLIGHT_FAKE)') -Code "evidence-private-value"
    Assert-Contract -Condition (-not $passText.Contains($FixtureExpectedSshCidr.Split("/")[0])) -Code "evidence-ssh-cidr"
    Assert-Contract -Condition ($passText -notmatch '\b(?:sk|rk)_(?:live|test)_') -Code "evidence-secret"
    Assert-Contract -Condition ($passDocument.redaction.keyDigestPresent -eq $false) -Code "evidence-key-digest"
    $passItem = Get-Item -LiteralPath $passEvidence -Force
    Assert-Contract -Condition (($passItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -Code "evidence-reparse"
    $passAcl = Get-Acl -LiteralPath $passEvidence
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $requiredEvidenceSids = @($currentSid, "S-1-5-18", "S-1-5-32-544")
    Assert-Contract -Condition ($passAcl.AreAccessRulesProtected) -Code "evidence-acl-protected"
    Assert-Contract -Condition ($passAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $currentSid) -Code "evidence-owner"
    $evidenceRules = @($passAcl.Access)
    Assert-Contract -Condition ($evidenceRules.Count -eq 3) -Code "evidence-acl-count"
    foreach ($rule in $evidenceRules) {
        $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        Assert-Contract -Condition (
            -not $rule.IsInherited -and
            $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $rule.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
            $requiredEvidenceSids -contains $ruleSid
        ) -Code "evidence-acl-rule"
    }
    $passHashBefore = (Get-FileHash -LiteralPath $passEvidence -Algorithm SHA256).Hash
    $duplicateEvidence = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory -EvidencePath $passEvidence -TemplatePath $templatePath -Mode "pass" -StatePath $statePath
    Assert-Contract -Condition ($duplicateEvidence.ExitCode -eq 1) -Code "evidence-create-new-exit"
    Assert-Contract -Condition ((Get-FileHash -LiteralPath $passEvidence -Algorithm SHA256).Hash -ceq $passHashBefore) -Code "evidence-create-new-preserved"

    foreach ($remoteOutcome in @(
        [pscustomobject]@{ Mode = "remote-fail"; ExitCode = 20; Result = "FAIL" },
        [pscustomobject]@{ Mode = "remote-incomplete"; ExitCode = 21; Result = "INCOMPLETE" },
        [pscustomobject]@{ Mode = "remote-incomplete-missing"; ExitCode = 21; Result = "INCOMPLETE" }
    )) {
        $remoteEvidence = Join-Path $evidenceDirectory ("{0}.json" -f $remoteOutcome.Mode)
        $remoteResult = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory -EvidencePath $remoteEvidence -TemplatePath $templatePath -Mode $remoteOutcome.Mode -StatePath $statePath
        Assert-Contract -Condition ($remoteResult.ExitCode -eq $remoteOutcome.ExitCode) -Code ("remote-exit-{0}" -f $remoteOutcome.Mode)
        Assert-Contract -Condition ([IO.File]::Exists($remoteEvidence)) -Code ("remote-evidence-{0}" -f $remoteOutcome.Mode)
        $remoteDocument = [IO.File]::ReadAllText($remoteEvidence) | ConvertFrom-Json
        Assert-Contract -Condition ($remoteDocument.admission -ceq "FIXTURE_ONLY") -Code ("remote-admission-{0}" -f $remoteOutcome.Mode)
        Assert-Contract -Condition ($remoteDocument.result -ceq $remoteOutcome.Result) -Code ("remote-result-{0}" -f $remoteOutcome.Mode)
        if ($remoteOutcome.Mode -ceq "remote-incomplete-missing") {
            Assert-Contract -Condition ($remoteDocument.provenance.revisionComposeVerified -eq $false) -Code "remote-missing-revision-compose"
        }
    }

    $failureModes = @(
        "ssh-oversize",
        "aws-oversize",
        "timeout",
        "secret-stderr",
        "firewall-missing",
        "firewall-empty",
        "firewall-open",
        "firewall-unexpected",
        "firewall-change",
        "nonce-mismatch",
        "cr-output",
        "tool-tamper"
    )
    foreach ($mode in $failureModes) {
        if ([IO.File]::Exists($statePath)) {
            [IO.File]::Delete($statePath)
        }
        $failureEvidence = Join-Path $evidenceDirectory ("{0}.json" -f $mode)
        $caseTimeout = if ($mode -in @("ssh-oversize", "aws-oversize")) { 5 } else { 1 }
        $failure = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory -EvidencePath $failureEvidence -TemplatePath $templatePath -Mode $mode -StatePath $statePath -TimeoutSeconds $caseTimeout
        Assert-Contract -Condition ($failure.ExitCode -eq 1) -Code ("failure-exit-{0}" -f $mode)
        Assert-Contract -Condition (-not [IO.File]::Exists($failureEvidence)) -Code ("failure-evidence-{0}" -f $mode)
        $combined = $failure.Stdout + $failure.Stderr
        Assert-Contract -Condition ($combined -notmatch '\b(?:sk|rk)_(?:live|test)_') -Code ("failure-secret-{0}" -f $mode)
        Assert-Contract -Condition ($combined -match '^postflight-capture-error:[A-Z][A-Z0-9_]{0,63}\r?\n$') -Code ("failure-code-{0}" -f $mode)
        Assert-Contract -Condition ($combined.Length -le 128) -Code ("failure-output-bound-{0}" -f $mode)
    }

    [IO.File]::Copy($compiledPath, (Join-Path $toolDirectory "ssh.exe"), $true)

    $credentialFixturePath = Join-Path $toolDirectory "aws-credentials.fixture"
    $credentialAcl = [IO.File]::GetAccessControl($credentialFixturePath)
    $credentialAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new("S-1-1-0"),
        [Security.AccessControl.FileSystemRights]::Read,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.File]::SetAccessControl($credentialFixturePath, $credentialAcl)
    $unsafeCredentialEvidence = Join-Path $evidenceDirectory "unsafe-credential-acl.json"
    $unsafeCredential = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory -EvidencePath $unsafeCredentialEvidence -TemplatePath $templatePath -Mode "pass" -StatePath $statePath
    Assert-Contract -Condition ($unsafeCredential.ExitCode -eq 1) -Code "unsafe-credential-acl-exit"
    Assert-Contract -Condition (-not [IO.File]::Exists($unsafeCredentialEvidence)) -Code "unsafe-credential-acl-evidence"
    Assert-Contract -Condition ($unsafeCredential.Stderr -ceq "postflight-capture-error:FIXTURE_AWS_CREDENTIAL_FILE_INVALID`r`n") -Code "unsafe-credential-acl-code"
    Set-RestrictedAcl -Path $credentialFixturePath -Directory $false

    $identityFixturePath = Join-Path $toolDirectory "identity.fixture"
    $identityAcl = [IO.File]::GetAccessControl($identityFixturePath)
    $identityAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new("S-1-1-0"),
        [Security.AccessControl.FileSystemRights]::Read,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.File]::SetAccessControl($identityFixturePath, $identityAcl)
    $unsafeAclEvidence = Join-Path $evidenceDirectory "unsafe-acl.json"
    $unsafeAcl = Invoke-WrapperFixture -PowerShellExecutable $powerShellExecutable -WrapperPath $wrapperPath -ToolDirectory $toolDirectory -EvidencePath $unsafeAclEvidence -TemplatePath $templatePath -Mode "pass" -StatePath $statePath
    Assert-Contract -Condition ($unsafeAcl.ExitCode -eq 1) -Code "unsafe-acl-exit"
    Assert-Contract -Condition (-not [IO.File]::Exists($unsafeAclEvidence)) -Code "unsafe-acl-evidence"
    Assert-Contract -Condition ($unsafeAcl.Stderr -ceq "postflight-capture-error:FIXTURE_IDENTITY_INVALID`r`n") -Code "unsafe-acl-code"

    $wrapperSource = [IO.File]::ReadAllText($wrapperPath)
    foreach ($requiredSource in @(
        "ProcessStartInfo",
        "UseShellExecute = `$false",
        "FileMode]::CreateNew",
        "FileShare]::Read",
        "EnvironmentVariables.Clear()",
        "C:\Program Files\Amazon\AWSCLIV2\aws.exe",
        "C:\Windows\System32\OpenSSH\ssh.exe",
        "C:\Program Files\nodejs\node.exe",
        "C:\Program Files\Git\cmd\git.exe",
        "adec66edbf500c5863659e5720a68400aa2a735a0defee7223571c9373e1d537",
        "8607ff933e769e77534b1244e39965bcf1c904dbfd4b9da819bbb71034cfef88",
        "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de",
        "5385ff9ae361ca41e7a31b335fc0d81f2de9c35fc62a165c5e34850d837b59cc",
        "GIT_NO_REPLACE_OBJECTS",
        "VALIDATOR_PROVENANCE_MISMATCH",
        "EVIDENCE_ACL_FAILED",
        "Assert-ExactFirewallClosed",
        "ExpectedSshCidr",
        '"-F", "NUL"',
        "StrictHostKeyChecking=yes",
        "UserKnownHostsFile=",
        "IdentityAgent=none",
        "ClearAllForwardings=yes",
        "/usr/bin/env",
        "--noprofile",
        '"FAIL" { exit 20 }',
        '"INCOMPLETE" { exit 21 }',
        "ReadAsync",
        "PROCESS_STDOUT_LIMIT",
        "PROCESS_TIMEOUT"
    )) {
        Assert-Contract -Condition ($wrapperSource.Contains($requiredSource)) -Code ("source-{0}" -f $requiredSource)
    }
    foreach ($forbiddenSource in @("Start-Process", "ReadToEnd(")) {
        Assert-Contract -Condition (-not $wrapperSource.Contains($forbiddenSource)) -Code ("forbidden-{0}" -f $forbiddenSource)
    }

    [Console]::Out.WriteLine("PASS: invoke-lightsail-postflight contract fixtures")
}
finally {
    $fullTemporaryRoot = [IO.Path]::GetFullPath($temporaryRoot)
    $fullSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (
        $fullTemporaryRoot.StartsWith($fullSystemTemp, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fullTemporaryRoot).StartsWith("refunddesk-postflight-contract-", [StringComparison]::Ordinal)
    ) {
        [IO.Directory]::Delete($fullTemporaryRoot, $true)
    }
}
