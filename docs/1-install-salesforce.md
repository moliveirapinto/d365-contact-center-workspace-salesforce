# Step 1 - Install in Salesforce

Do the parts **in this order**. Each part depends on the one before it. Every command below uses a Salesforce CLI alias; sign in once with:

```
sf org login web --alias cc-dev            # add  --instance-url https://test.salesforce.com  for a sandbox
```

> Use a **Developer Edition org, a sandbox or a scratch org**. The Microsoft package in 1.1 is a pre-release and is not meant for production.

## 1.1 Install Microsoft's Contact Center Workspace package

```
sf package install --package 04tak000000aSFVAA2 -o cc-dev --wait 20 --publish-wait 5 --security-type AdminsOnly --no-prompt
```

Browser alternative: `https://login.salesforce.com/packaging/installPackage.apexp?p0=04tak000000aSFVAA2` (use `test.salesforce.com` for a sandbox), then **Install for Admins Only**.

**Before you install**, if the org has an older, hand-made Contact Center utility item (an unmanaged `d365EdgeContainer` component on a utility bar), remove it from the utility bar first. Otherwise the install fails with *"can't remove property layoutPreset"*.

Check: `sf package installed list -o cc-dev` shows **D365ContactCenter**. The package adds 7 Lightning components, including `d365EdgeContainer` (the workspace panel) and `d365OpenCTIAdapter` (inert here; there is no softphone or Call Center).

## 1.2 Deploy the Call Journey package

This creates the `Contact_Center_Call__c` object (the call journey), the flow that creates a journey record for each Case, the timeline and recording components, the Case fields `D365_Conversation_Id__c` and `D365_Call_Recording__c`, the permission set `D365_Contact_Center_Call_Access`, the settings object and the Trusted URL `https://*.dynamics.com`.

Validate first, then deploy (do not unzip the file):

```
sf project deploy start --metadata-dir salesforce/call-journey/D365ContactCenter_CallJourney_Salesforce.zip --single-package -o cc-dev --dry-run --wait 10
sf project deploy start --metadata-dir salesforce/call-journey/D365ContactCenter_CallJourney_Salesforce.zip --single-package -o cc-dev --wait 10
```

Expect **Succeeded, 48 components, 0 errors**. No CLI? Use Workbench (https://workbench.developerforce.com) > migration > Deploy, tick *Single Package* and *Rollback On Error*.

## 1.3 Deploy the companion metadata

The companion adds the automation bridge (`ccSalesforceBridge`), the demo quick actions and flows, the Task field **Call Journey** (`Call_Journey__c`) that links each logged call Task to its journey, the Contact formula fields `Phone_Last10__c` and `Mobile_Last10__c` used to match callers, the permission set **Contact Center Demo** and the Trusted URLs for the workspace portal and Microsoft sign-in.

1. Put your Dynamics 365 environment URL into the FlexiPages. Replace the placeholder `YOUR-ORG.crm.dynamics.com` with your host (for example `contoso.crm.dynamics.com`):

   ```powershell
   Get-ChildItem salesforce/companion/force-app -Recurse -Filter *.flexipage-meta.xml |
     ForEach-Object { (Get-Content $_ -Raw).Replace('YOUR-ORG','contoso') | Set-Content $_ -NoNewline }
   ```
   (bash: `sed -i 's/YOUR-ORG/contoso/g' salesforce/companion/force-app/main/default/flexipages/*.xml`)

   The portal URL inside is `https://portal.us.contactcenterai.powerplatform.com/experience/agent?orgUrl=<your org URL, URL-encoded>#/`.

2. **Back up your Service Console utility bar first.** `LightningService_UtilityBar` in this repo replaces the utility bar of the standard *Service Console* app, adding the workspace panel (**Contact Center**) and the bridge (**Contact Center Automation**). Retrieve your current one if you want to keep it: `sf project retrieve start -o cc-dev -m FlexiPage:LightningService_UtilityBar`.

3. Deploy:

   ```
   cd salesforce/companion
   sf project deploy start -o cc-dev --source-dir force-app --wait 20
   ```

Notes that matter:

- The panel must use layout **compact** (the `embedded` layout has no Copilot panel). The shipped utility bar uses compact, size 1000 x 800, load eagerly.
- **Contact Center Automation** (`ccSalesforceBridge`) must be a normal, visible utility item. A background wrapper does not run it, and then no call Task is logged and nothing pops.
- The bridge needs the permission set (next step). Its field permissions are on `Task.*`, not `Activity.*`.
- The Microsoft kit's Case page layout is not shipped (it fails when the Solutions feature is not enabled).

## 1.4 Assign permission sets

Assign both permission sets to every agent, to the Salesforce user that Copilot Studio uses to create Cases, and to the Salesforce user of the Power Automate connection:

```
sf org assign permset --name Contact_Center_Demo --on-behalf-of agent@example.com -o cc-dev
sf org assign permset --name D365_Contact_Center_Call_Access --on-behalf-of agent@example.com -o cc-dev
```

Check: `SELECT Assignee.Username, PermissionSet.Name FROM PermissionSetAssignment WHERE PermissionSet.Name IN ('Contact_Center_Demo','D365_Contact_Center_Call_Access')`.

## 1.5 Trusted URLs

Setup > **Trusted URLs** must contain these **active** entries (the deployments above create them):

| Name | URL | Needed for |
|---|---|---|
| `D365_CC_Workspace_Portal` | `https://portal.us.contactcenterai.powerplatform.com` | the workspace panel (Frame, Microphone) |
| `D365_CC_Microsoft_Login` | `https://login.microsoftonline.com` | sign-in pop-up |
| `D365_Contact_Center` | `https://*.dynamics.com` | the recording pop-up |

## 1.6 Custom setting

Write the org default of **D365 Contact Center Settings** (Anonymous Apex):

```apex
D365_Contact_Center_Settings__c s = D365_Contact_Center_Settings__c.getOrgDefaults();
s.Org_Url__c = 'https://contoso.crm.dynamics.com';
s.Time_Zone_Offset__c = -5;      // standard-time offset from UTC
s.Daylight_Saving_Rule__c = 'US'; // US, EU or blank
s.Time_Zone_Label__c = 'ET';
upsert s;
```

`App_Id__c` is filled in [Step 2](2-install-dynamics365.md) once the Call Review app exists.

## 1.7 Optional Case extras

- Compact layout *Case Highlights with Call Recording* (Setup > Object Manager > Case > Compact Layouts > Compact Layout Assignment).
- Related list *Contact Center Calls* on Case and Contact layouts.
- Component *Call Timeline (D365 Contact Center)* on the Case record page (Edit Page).
- The Task layout shipped here shows the **Call Journey** lookup, so the logged call opens the journey instead of duplicating it.

Hard-refresh Salesforce (Ctrl+Shift+R) after deploying; Lightning caches pages aggressively.

Next: [Step 2 - Dynamics 365](2-install-dynamics365.md).
