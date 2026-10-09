# Step 2 - Dynamics 365 solution

## Automated: one script (recommended)

`dynamics365/Install-D365Solution.ps1` does the whole step through the Dataverse API, so there is nothing to click except one Salesforce sign-in:

| It does | Replaces |
|---|---|
| Imports `D365ContactCenterSalesforceCallJourney_1_1_1_0.zip` (skips if already up to date) | 2.1 import |
| Binds the Dataverse and Salesforce connection references | 2.1 connections and 2.2 |
| Turns the sync flow on | 2.2 |
| Adds the Conversation form fix and publishes | 2.3 |
| Reports whether content security policy needs `frame-ancestors` entries | 2.3 |
| Gives your security roles access to the Call Review app and publishes it | 2.4 |
| Writes the D365 org URL, the app id and the time zone into the Salesforce custom setting | Step 1.6 |

**Prerequisites:** PowerShell 7 (`pwsh`), the Azure CLI, and `az login` with a System Administrator or System Customizer account in the Contact Center environment. For the Salesforce setting also the `sf` CLI signed in to your org.

```
# Preview: only reads, changes nothing
pwsh -File dynamics365/Install-D365Solution.ps1 -OrgUrl https://contoso.crm.dynamics.com -SalesforceAlias cc-dev `
  -ShareWithRoles "Customer Service Representative","Omnichannel agent" `
  -TimeZoneOffset -5 -DaylightSavingRule US -TimeZoneLabel ET -WhatIf

# Apply: same command without -WhatIf
```

Options: `-Subscription` (when `az` has several), `-SalesforceConnection` (name or id, needed when the environment has more than one Connected Salesforce connection), `-DataverseConnection` (optional, the newest is used), `-Force` (import again), `-ShareWithRoles` / `-SalesforceAlias` / time zone options are optional.

**The one manual step - the Salesforce connection.** Creating a connection needs a Salesforce OAuth sign-in (with MFA), which no script can do for you. If the environment has no *Connected* Salesforce connection, the script prints a link and stops (exit code 2):

1. Open `https://make.powerapps.com/environments/<environment id>/connections` (the script prints the exact link).
2. **New connection > Salesforce**, choose Production (or Sandbox to match), Create, and sign in to **the same Salesforce org** you installed Step 1 into.
3. Run the script again.

A connection to another org is the classic failure: the flow ends "successfully" but calls stay *In progress* in Salesforce.

**Only if content security policy is enforced:** the script prints it. Add `https://*.lightning.force.com` and `https://*.my.salesforce.com` (and your My Domain host) to *frame-ancestors* in Power Platform admin center > your environment > Settings > Product > Privacy + Security > Content security policy > App (model-driven) > Configure directives. Microsoft exposes this setting only in the admin center. Only the recording pop-up needs it.

> The script was tested in preview mode (read-only) and its form-fix part is the same API call that was proven live. Its import, connection binding and app sharing steps have not been run end to end in a clean environment yet: if one fails, use the manual steps below and tell us.

---

## Manual steps (fallback)

You need System Administrator (or System Customizer) in the Contact Center environment, and the table **Conversation** (`msdyn_ocliveworkitem`) must exist.

### 2.1 Import the solution

1. https://make.powerapps.com > your Contact Center environment > **Solutions > Import solution > Browse**.
2. Pick `dynamics365/D365ContactCenterSalesforceCallJourney_1_1_1_0.zip` > Next.
3. Connections:
   - **D365 Contact Center - Dataverse**: your Microsoft Dataverse connection.
   - **D365 Contact Center - Salesforce**: create a Salesforce connection (Production or Sandbox to match your org) and sign in with the Salesforce user that received both permission sets in Step 1.4. **It must be the same Salesforce org you deployed to.**
4. Import.

### 2.2 Turn the sync flow on

Solution > Cloud flows > **D365 Contact Center - Sync ended calls to Salesforce** > Turn on. If Turn on is greyed out, open Connection references, select a connection for each, Save, then retry. If you later change the Salesforce connection, edit the connection reference, then turn the flow off and on.

### 2.3 Conversation form fix (call recording pop-up only)

Needed so the *Recording & transcript* pop-up in Salesforce shows the transcript and the evaluation pane (D365 loads them through `window.top.Xrm`, which browsers block when D365 is embedded cross-site). The script `dynamics365/Apply-ConversationFormFix.ps1` does it on its own too; by hand:

1. Tables > **Conversation** > Forms > **Conversation Form** (Main) > Form libraries > Add library > `new_d365cc_evaluationpanefix` > Add.
2. Select the form itself > Events > On load > Event handler: library `new_d365cc_evaluationpanefix.js`, function `D365CC.EvaluationPaneFix.onLoad`, Enabled, **Pass execution context as first parameter**.
3. Save and publish.

### 2.4 Share the Call Review app

Apps > **Contact Center Call Review** > Share > add the agents' security roles (never "everyone"). Open it with Play and copy the `appid=` value from the address bar into Salesforce (`App_Id__c`, Step 1.6).

Next: [Step 3 - Copilot Studio](3-configure-copilot-studio.md).
