<#
.SYNOPSIS
  Installs and configures the Dynamics 365 side of the call journey end to end, through the Dataverse API.

.DESCRIPTION
  1. Checks the Conversation table (msdyn_ocliveworkitem) exists.
  2. Imports D365ContactCenterSalesforceCallJourney_1_1_1_0.zip (skipped when that version or newer is installed).
  3. Binds the two connection references of the solution (Dataverse and Salesforce) to existing connections.
  4. Turns the "Sync ended calls to Salesforce" cloud flow on.
  5. Applies the Conversation form fix (Apply-ConversationFormFix.ps1) and checks the content security policy.
  6. Optionally gives security roles access to the "Contact Center Call Review" app and publishes it.
  7. Optionally writes the D365 org URL, the app id and the time zone into the Salesforce custom setting (needs the sf CLI).

  The only thing it cannot do for you is the one-time Salesforce sign-in that creates the Salesforce connection
  (an OAuth consent). If no Connected Salesforce connection exists in the environment, the script prints where to
  create one and stops with exit code 2. Run it again afterwards.

  Sign in first with:  az login   (System Administrator or System Customizer in the environment).
  Safe to run again. Use -WhatIf to preview: it only reads and reports.

.EXAMPLE
  ./Install-D365Solution.ps1 -OrgUrl https://contoso.crm.dynamics.com -SalesforceAlias cc-dev `
      -ShareWithRoles 'Customer Service Representative','Omnichannel agent' `
      -TimeZoneOffset -5 -DaylightSavingRule US -TimeZoneLabel ET
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$OrgUrl,
    [string]$Subscription,
    [string]$SalesforceConnection,
    [string]$DataverseConnection,
    [string[]]$ShareWithRoles,
    [string]$SalesforceAlias,
    [Nullable[double]]$TimeZoneOffset,
    [string]$DaylightSavingRule,
    [string]$TimeZoneLabel,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$OrgUrl = $OrgUrl.TrimEnd('/')
$zip = Join-Path $PSScriptRoot 'D365ContactCenterSalesforceCallJourney_1_1_1_0.zip'
$solutionName = 'D365ContactCenterSalesforceCallJourney'
$solutionVersion = [version]'1.1.1.0'
$flowName = 'D365 Contact Center - Sync ended calls to Salesforce'
$appUnique = 'new_ContactCenterCallReview'

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Get-Token($resource) {
    $a = @('account', 'get-access-token', '--resource', $resource, '--query', 'accessToken', '-o', 'tsv')
    if ($Subscription) { $a += @('--subscription', $Subscription) }
    $t = (& az @a) 2>$null
    if (-not $t) { throw "Could not get a token for $resource. Run 'az login' first (pass -Subscription if you have several)." }
    return $t
}

$h = @{ Authorization = "Bearer $(Get-Token $OrgUrl)"; Accept = 'application/json'; 'Content-Type' = 'application/json; charset=utf-8' }
$api = "$OrgUrl/api/data/v9.2/"
function Dv($path) { (Invoke-RestMethod -Headers $h ($api + $path)).value }

# 0. Table
Step 'Checking the environment'
try { Invoke-RestMethod -Headers $h ($api + "EntityDefinitions(LogicalName='msdyn_ocliveworkitem')?`$select=LogicalName") | Out-Null }
catch { throw 'The table Conversation (msdyn_ocliveworkitem) was not found. This environment does not have Dynamics 365 Contact Center.' }
Write-Host 'Conversation table: found.'

# 1. Import
Step "Solution $solutionName $solutionVersion"
$existing = Dv "solutions?`$filter=uniquename eq '$solutionName'&`$select=version"
$doImport = $true
if ($existing) {
    $cur = [version]$existing[0].version
    Write-Host "Installed version: $cur"
    if ($cur -ge $solutionVersion -and -not $Force) { $doImport = $false; Write-Host 'Already up to date, import skipped (use -Force to import again).' }
}
if ($doImport) {
    if (-not (Test-Path $zip)) { throw "Solution file not found: $zip" }
    if ($PSCmdlet.ShouldProcess($OrgUrl, "import $zip")) {
        $body = @{
            OverwriteUnmanagedCustomizations = $false
            PublishWorkflows                 = $false
            CustomizationFile                = [Convert]::ToBase64String([IO.File]::ReadAllBytes($zip))
            ImportJobId                      = [guid]::NewGuid().ToString()
        } | ConvertTo-Json
        Invoke-RestMethod -Method Post -Headers $h ($api + 'ImportSolution') -Body $body -TimeoutSec 600 | Out-Null
        Write-Host 'Solution imported.'
    }
}

# 2. Connections
Step 'Connections'
$pa = @{ Authorization = "Bearer $(Get-Token 'https://service.powerapps.com')" }
$envs = (Invoke-RestMethod -Headers $pa 'https://api.powerapps.com/providers/Microsoft.PowerApps/environments?api-version=2016-11-01').value
$envName = ($envs | Where-Object { $_.properties.linkedEnvironmentMetadata.instanceUrl -and $_.properties.linkedEnvironmentMetadata.instanceUrl.TrimEnd('/') -ieq $OrgUrl } | Select-Object -First 1).name
if (-not $envName) { throw "Could not find the Power Platform environment for $OrgUrl." }

function Find-Connection($connector, $wanted, $label, [switch]$Newest) {
    $all = (Invoke-RestMethod -Headers $pa "https://api.powerapps.com/providers/Microsoft.PowerApps/apis/$connector/connections?api-version=2016-11-01&`$filter=environment eq '$envName'").value
    $ok = @($all | Where-Object { $_.properties.statuses -and $_.properties.statuses[0].status -eq 'Connected' })
    if ($wanted) { $ok = @($ok | Where-Object { $_.name -eq $wanted -or $_.properties.displayName -eq $wanted }) }
    if ($ok.Count -ge 1 -and $Newest) { return ($ok | Sort-Object { [datetime]$_.properties.createdTime } -Descending)[0] }
    if ($ok.Count -eq 1) { return $ok[0] }
    if ($ok.Count -gt 1) {
        $list = ($ok | ForEach-Object { "  - $($_.properties.displayName) (id $($_.name), created $($_.properties.createdTime))" }) -join "`n"
        throw "Several Connected $label connections exist. Run again with -$($label)Connection '<name or id>' using one of:`n$list"
    }
    return $null
}
$sf = Find-Connection 'shared_salesforce' $SalesforceConnection 'Salesforce'
if (-not $sf) {
    Write-Warning 'No Connected Salesforce connection exists in this environment.'
    Write-Host ("`nOne manual step: create it once (it needs your Salesforce sign-in, including MFA):`n" +
        "  1. Open https://make.powerapps.com/environments/$envName/connections`n" +
        "  2. New connection > Salesforce > pick Production (or Sandbox) > Create > sign in to the SAME Salesforce org you installed the call journey into.`n" +
        "  3. Run this script again.")
    exit 2
}
$dvc = Find-Connection 'shared_commondataserviceforapps' $DataverseConnection 'Dataverse' -Newest
if (-not $dvc) {
    Write-Warning "No Connected Dataverse connection exists. Create one at https://make.powerapps.com/environments/$envName/connections (New connection > Microsoft Dataverse), then run again."
    exit 2
}
Write-Host "Salesforce connection: $($sf.properties.displayName) ($($sf.name), created $($sf.properties.createdTime))"
Write-Host "  Check this is the connection to the same Salesforce org you installed into: a connection to another org makes the flow end 'successfully' while calls stay In progress."
Write-Host "Dataverse connection:  $($dvc.properties.displayName) ($($dvc.name))"

foreach ($pair in @(@('new_d365cc_salesforce', $sf.name), @('new_d365cc_dataverse', $dvc.name))) {
    $ref = Dv "connectionreferences?`$filter=connectionreferencelogicalname eq '$($pair[0])'&`$select=connectionreferenceid,connectionid"
    if (-not $ref) {
        if ($WhatIfPreference) { Write-Host "(preview) connection reference $($pair[0]) not there yet, it is created by the import."; continue }
        throw "Connection reference $($pair[0]) not found. Did the import succeed?"
    }
    if ($ref[0].connectionid -eq $pair[1]) { Write-Host "$($pair[0]): already bound."; continue }
    if ($PSCmdlet.ShouldProcess($pair[0], "bind to connection $($pair[1])")) {
        Invoke-RestMethod -Method Patch -Headers $h ($api + "connectionreferences($($ref[0].connectionreferenceid))") -Body (@{ connectionid = $pair[1] } | ConvertTo-Json) | Out-Null
        Write-Host "$($pair[0]): bound."
    }
}

# 3. Flow
Step 'Cloud flow'
$flow = Dv "workflows?`$filter=name eq '$flowName' and category eq 5&`$select=workflowid,statecode"
if (-not $flow) {
    if ($WhatIfPreference) { Write-Host '(preview) the flow is created by the import.' }
    else { throw "Flow '$flowName' not found." }
} elseif ($flow[0].statecode -eq 1) {
    Write-Host 'Flow is already On.'
} elseif ($PSCmdlet.ShouldProcess($flowName, 'turn on')) {
    try {
        Invoke-RestMethod -Method Patch -Headers $h ($api + "workflows($($flow[0].workflowid))") -Body (@{ statecode = 1; statuscode = 2 } | ConvertTo-Json) | Out-Null
    } catch {
        Start-Sleep 20
        Invoke-RestMethod -Method Patch -Headers $h ($api + "workflows($($flow[0].workflowid))") -Body (@{ statecode = 1; statuscode = 2 } | ConvertTo-Json) | Out-Null
    }
    Write-Host 'Flow turned on.'
}

# 4. Form fix + CSP
Step 'Conversation form fix and content security policy'
$fixArgs = @{ OrgUrl = $OrgUrl }
if ($Subscription) { $fixArgs.Subscription = $Subscription }
& (Join-Path $PSScriptRoot 'Apply-ConversationFormFix.ps1') @fixArgs

# 5. App
Step 'Contact Center Call Review app'
$app = Dv "appmodules?`$filter=uniquename eq '$appUnique'&`$select=appmoduleid,name"
$appId = $null
if (-not $app) {
    if ($WhatIfPreference) { Write-Host '(preview) the app is created by the import.' } else { throw "App $appUnique not found." }
} else {
    $appId = $app[0].appmoduleid
    Write-Host "App id: $appId"
    if ($ShareWithRoles) {
        $root = (Dv "businessunits?`$filter=parentbusinessunitid eq null&`$select=businessunitid")[0].businessunitid
        foreach ($rn in $ShareWithRoles) {
            $r = Dv "roles?`$filter=name eq '$($rn.Replace("'", "''"))' and _businessunitid_value eq $root&`$select=roleid"
            if (-not $r) { Write-Warning "Security role '$rn' not found, skipped."; continue }
            if ($PSCmdlet.ShouldProcess($rn, 'give access to the Call Review app')) {
                try {
                    Invoke-RestMethod -Method Post -Headers $h ($api + "appmodules($appId)/appmoduleroles_association/`$ref") -Body (@{ '@odata.id' = "$($api)roles($($r[0].roleid))" } | ConvertTo-Json) | Out-Null
                    Write-Host "Role '$rn': access granted."
                } catch {
                    if ($_.Exception.Message -match 'duplicate|already') { Write-Host "Role '$rn': already has access." } else { throw }
                }
            }
        }
        if ($PSCmdlet.ShouldProcess('Contact Center Call Review', 'publish')) {
            $pub = @{ ParameterXml = "<importexportxml><appmodules><appmodule>$appId</appmodule></appmodules></importexportxml>" } | ConvertTo-Json
            Invoke-RestMethod -Method Post -Headers $h ($api + 'PublishXml') -Body $pub | Out-Null
        }
    } else {
        Write-Host 'No -ShareWithRoles given: share the app yourself (Apps > Contact Center Call Review > Share), never with "everyone".'
    }
}

# 6. Salesforce custom setting
Step 'Salesforce custom setting'
if ($SalesforceAlias) {
    if (-not (Get-Command sf -ErrorAction SilentlyContinue)) { Write-Warning 'The sf CLI was not found, set the custom setting by hand (Step 1.6).' }
    else {
        $lines = @('D365_Contact_Center_Settings__c s = D365_Contact_Center_Settings__c.getOrgDefaults();', "s.Org_Url__c = '$OrgUrl';")
        if ($appId) { $lines += "s.App_Id__c = '$appId';" }
        if ($null -ne $TimeZoneOffset) { $lines += "s.Time_Zone_Offset__c = $($TimeZoneOffset.ToString([Globalization.CultureInfo]::InvariantCulture));" }
        if ($DaylightSavingRule) { $lines += "s.Daylight_Saving_Rule__c = '$DaylightSavingRule';" }
        if ($TimeZoneLabel) { $lines += "s.Time_Zone_Label__c = '$TimeZoneLabel';" }
        $lines += 'upsert s;'
        if ($PSCmdlet.ShouldProcess($SalesforceAlias, 'write D365 Contact Center Settings')) {
            $tmp = Join-Path ([IO.Path]::GetTempPath()) 'cc-settings.apex'
            Set-Content $tmp $lines
            & sf apex run --file $tmp --target-org $SalesforceAlias | Out-Host
            Remove-Item $tmp -ErrorAction SilentlyContinue
        }
    }
} else {
    Write-Host "No -SalesforceAlias given. Put the Org URL ($OrgUrl) and App Id ($appId) into the custom setting yourself (Step 1.6)."
}

Step 'Done'
Write-Host "Environment: $OrgUrl"
Write-Host "App id:      $appId"
Write-Host 'Remaining by hand: nothing, unless a warning above says otherwise.'
