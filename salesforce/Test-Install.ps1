<#
.SYNOPSIS
  Read-only health check for the Salesforce side of the install. Explains why the Contact / Case pop-ups
  or the call Task do not appear. Changes nothing.

.EXAMPLE
  pwsh -File salesforce/Test-Install.ps1 -Alias cc-dev -Username agent@example.com
#>
param(
    [Parameter(Mandatory = $true)][string]$Alias,
    [string]$Username
)
$ErrorActionPreference = 'Continue'
$script:bad = 0
function Q($soql, [switch]$Tooling) {
    $a = @('data', 'query', '-o', $Alias, '-q', $soql, '--json')
    if ($Tooling) { $a += '--use-tooling-api' }
    $r = (& sf @a 2>$null | Out-String | ConvertFrom-Json)
    if ($r.status -ne 0) { return $null }
    return , @($r.result.records)
}
function Ok($m) { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function Bad($m, $fix) { $script:bad++; Write-Host "  [FAIL] $m" -ForegroundColor Red; if ($fix) { Write-Host "         FIX: $fix" -ForegroundColor Yellow } }
function Info($m) { Write-Host "  [info] $m" }
function Head($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

$org = (& sf org display -o $Alias --json 2>$null | Out-String | ConvertFrom-Json).result
if (-not $org) { Write-Host "Cannot reach org '$Alias'. Run: sf org login web --alias $Alias"; exit 1 }
if (-not $Username) { $Username = $org.username }
Write-Host "Org: $($org.instanceUrl)   user checked: $Username"

Head '1. Packages and components'
$pk = Q "SELECT SubscriberPackage.Name FROM InstalledSubscriberPackage" -Tooling
if ($pk -and ($pk | Where-Object { $_.SubscriberPackage.Name -match 'D365ContactCenter' })) { Ok 'Microsoft package D365ContactCenter is installed' }
else { Bad 'Microsoft package D365ContactCenter not found' 'sf package install --package 04tak000000aSFVAA2 -o <alias> --wait 20 --publish-wait 5 --security-type AdminsOnly --no-prompt' }
foreach ($c in 'ContactCenterService', 'CallerLookup') {
    if ((Q "SELECT Id FROM ApexClass WHERE Name='$c'" -Tooling).Count) { Ok "Apex class $c" } else { Bad "Apex class $c is missing" 'Deploy salesforce/companion (Step 1.3)' }
}
foreach ($c in 'ccSalesforceBridge', 'd365EdgeContainer') {
    if ((Q "SELECT Id FROM LightningComponentBundle WHERE DeveloperName='$c'" -Tooling).Count) { Ok "LWC $c" } else { Bad "LWC $c is missing" 'Install the package (1.1) and deploy the companion (1.3)' }
}
if ((Q "SELECT Id FROM CustomObject WHERE DeveloperName='Contact_Center_Call'" -Tooling).Count) { Ok 'Call journey object Contact_Center_Call__c' } else { Bad 'Contact_Center_Call__c is missing' 'Deploy the call journey package (1.2)' }

Head '2. Permission sets for the user'
$ps = Q "SELECT PermissionSet.Name FROM PermissionSetAssignment WHERE Assignee.Username='$Username'"
foreach ($n in 'Contact_Center_Demo', 'D365_Contact_Center_Call_Access') {
    if ($ps -and ($ps | Where-Object { $_.PermissionSet.Name -eq $n })) { Ok "$n assigned" }
    else { Bad "$n is NOT assigned to $Username (the bridge cannot log the call Task or read Cases without it)" "sf org assign permset --name $n --on-behalf-of $Username -o $Alias" }
}

Head '3. Fields used by the pop-up logic'
foreach ($f in @(@('Task', 'Conversation_Id__c'), @('Task', 'Call_Journey__c'), @('Task', 'Live_Work_Item_Id__c'), @('Contact', 'Phone_Last10__c'), @('Contact', 'Mobile_Last10__c'), @('Case', 'D365_Conversation_Id__c'))) {
    $d = (& sf sobject describe -o $Alias -s $f[0] --json 2>$null | Out-String | ConvertFrom-Json).result
    if ($d -and ($d.fields | Where-Object { $_.name -eq $f[1] })) { Ok "$($f[0]).$($f[1])" }
    else { Bad "$($f[0]).$($f[1]) is missing or not visible to this user" 'Deploy the companion (1.3) and the call journey package (1.2) and assign both permission sets (1.4)' }
}
Head '4. Service Console utility bar'
$fp = Q "SELECT Metadata FROM FlexiPage WHERE DeveloperName='LightningService_UtilityBar'" -Tooling
if (-not $fp -or -not $fp.Count) { Bad 'LightningService_UtilityBar not found' 'Deploy the companion (1.3)' }
else {
    $m = $fp[0].Metadata
    $items = @(); foreach ($r in $m.flexiPageRegions) { foreach ($i in $r.itemInstances) { $items += [pscustomobject]@{ Region = $r.name; Name = $i.componentInstance.componentName; Props = $i.componentInstance.componentInstanceProperties } } }
    $bridge = $items | Where-Object { $_.Name -match 'ccSalesforceBridge' }
    $panel = $items | Where-Object { $_.Name -match 'd365EdgeContainer' }
    if (-not $bridge) { Bad 'The automation bridge (ccSalesforceBridge) is NOT in the Service Console utility bar. This is the pop-up engine.' 'Deploy the companion (1.3): it adds the bridge to LightningService_UtilityBar' }
    elseif ($bridge.Region -ne 'utilityItems') { Bad "The bridge sits in '$($bridge.Region)'. It does NOT run there (no Task, no pop-ups)." 'Make it a normal utility item (blank label and no icon are fine)' }
    else { Ok 'Bridge is a normal utility item' }
    if (-not $panel) { Bad 'The Contact Center panel (d365EdgeContainer) is not in the utility bar' 'Deploy the companion (1.3)' } else { Ok 'Contact Center panel is in the utility bar' }
    foreach ($pi in @($panel, $bridge)) {
        if ($pi) {
            $json = ($pi.Props | ConvertTo-Json -Depth 5)
            if ($json -match 'YOUR-ORG') { Bad "$($pi.Name): still contains the placeholder YOUR-ORG (the panel cannot reach Dynamics 365)" 'Replace YOUR-ORG.crm.dynamics.com with your D365 host in the flexipages and redeploy (Step 1.3)' }
        }
    }
    if ($panel) {
        $lay = ($panel.Props | Where-Object { $_.name -eq 'layout' }).value
        if ($lay -and $lay -ne 'compact') { Bad "Panel layout is '$lay'; it must be 'compact' (other layouts have no Copilot panel)" 'Set layout to compact' } else { Ok 'Panel layout is compact' }
    }
    if ($bridge) {
        $ap = ($bridge.Props | Where-Object { $_.name -eq 'autoScreenPop' }).value
        if ($ap -eq 'true') { Ok 'autoScreenPop is true' } else { Bad "autoScreenPop is '$ap' on the bridge: nothing will pop up" 'Set autoScreenPop to true on the bridge utility item' }
        $iid = ($bridge.Props | Where-Object { $_.name -eq 'instanceId' }).value
        $hid = if ($panel) { ($panel.Props | Where-Object { $_.name -eq 'hostApiInstanceId' }).value }
        if ($iid -and $hid -and $iid -ne $hid) { Bad "Bridge instanceId '$iid' differs from the panel's hostApiInstanceId '$hid'" "Set both to the same value (shipped: utility)" } elseif ($iid) { Ok "instanceId matches ($iid)" }
    }
}

Head '5. Which app the user opens'
$apps = Q "SELECT DeveloperName, Label, NavType FROM AppDefinition WHERE NavType='Console'"
if ($apps) { Info ('Console apps in this org: ' + (($apps | ForEach-Object { "$($_.Label) [$($_.DeveloperName)]" }) -join '; ')) }
Info 'The utility bar we deploy belongs to the standard "Service Console" app (LightningService). If your agents use a DIFFERENT console app (for example a custom one), they will not get the panel or the bridge. Open Setup > App Manager > your app > Utility Items and add the Contact Center panel and the Contact Center Automation item there.'

Head '6. Trusted URLs'
$tu = Q "SELECT DeveloperName, IsActive, EndpointUrl FROM CspTrustedSite" -Tooling
foreach ($n in 'D365_CC_Workspace_Portal', 'D365_CC_Microsoft_Login', 'D365_Contact_Center') {
    $r = $tu | Where-Object { $_.DeveloperName -eq $n }
    if ($r -and $r.IsActive) { Ok "$n active ($($r.EndpointUrl))" } else { Bad "$n missing or inactive" 'Deploy the companion (1.3) / call journey package (1.2)' }
}

Head '7. Did the bridge ever run? (evidence from the data)'
$t = Q "SELECT Id, Subject, Conversation_Id__c, Call_Journey__c, WhatId, CreatedDate FROM Task WHERE Conversation_Id__c != null ORDER BY CreatedDate DESC LIMIT 3"
if ($t -and $t.Count) { Ok "$($t.Count) call Task(s) with a conversation id exist (latest $($t[0].CreatedDate)). The bridge logged calls." ; if (-not $t[0].WhatId) { Info 'The latest Task has no Case (WhatId): the Case did not exist yet when the call was accepted, or no journey record was found, so there was no Case to pop.' } }
else { Bad 'No call Task has ever been logged. The bridge never ran, or an older bridge version stopped because no Contact matched the caller (fixed in the current version: redeploy the companion, Step 1.3).' 'Check sections 2 and 4 above, hard-refresh (Ctrl+Shift+R), then place a test call from a number saved on a Contact (Phone or Mobile)' }
$cc = Q "SELECT Id, Name, Case__c, Contact__c, CreatedDate FROM Contact_Center_Call__c ORDER BY CreatedDate DESC LIMIT 3"
if ($cc -and $cc.Count) { Ok "Latest call journey: $($cc[0].Name) (Case linked: $([bool]$cc[0].Case__c))" } else { Info 'No call journey records yet (no call came through the IVR Case flow).' }

Head 'Summary'
if ($script:bad -eq 0) { Write-Host 'Everything checked looks right. If pop-ups still fail: hard-refresh with Ctrl+Shift+R, make sure the Contact Center panel shows Connected and your presence is Available, and call from a number stored on a Contact (Phone or Mobile).' -ForegroundColor Green }
else { Write-Host "$($script:bad) problem(s) found. Fix the FAIL items above (each has a FIX line) and run this script again." -ForegroundColor Red }
