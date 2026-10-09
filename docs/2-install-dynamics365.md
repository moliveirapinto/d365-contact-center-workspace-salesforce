# Step 2 - Dynamics 365 solution

You need System Administrator (or System Customizer) in the Contact Center environment, and the table **Conversation** (`msdyn_ocliveworkitem`) must exist.

## 2.1 Import the solution

1. https://make.powerapps.com > choose your Contact Center environment > **Solutions > Import solution > Browse**.
2. Pick `dynamics365/D365ContactCenterSalesforceCallJourney_1_1_1_0.zip` > Next.
3. Connections:
   - **D365 Contact Center - Dataverse**: your Microsoft Dataverse connection.
   - **D365 Contact Center - Salesforce**: create a Salesforce connection (Production or Sandbox login to match your org) and sign in with the Salesforce user that received both permission sets in Step 1.4. **It must be the same Salesforce org you deployed to.** If an older connection to a different org is picked, the flow runs "successfully" but the call stays *In progress* in Salesforce (Salesforce answers *duplicate value* and the flow hides the error).
4. Import.

## 2.2 Turn the sync flow on

Solution > Cloud flows > **D365 Contact Center - Sync ended calls to Salesforce** > Turn on. If Turn on is greyed out, open Connection references, select a connection for each, Save, then retry.

If you later change the Salesforce connection, edit the **connection reference** (Solutions > Connection references > the Salesforce one > select the new connection), then turn the flow off and on.

## 2.3 Conversation form fix (call recording pop-up only)

Needed so the *Recording & transcript* pop-up in Salesforce shows the transcript and the evaluation pane (D365 loads them through `window.top.Xrm`, which browsers block when D365 is embedded cross-site).

1. Tables > **Conversation** > Forms > **Conversation Form** (Main) > Form libraries > Add library > `new_d365cc_evaluationpanefix` > Add.
2. Select the form itself > Events > On load > Event handler: library `new_d365cc_evaluationpanefix.js`, function `D365CC.EvaluationPaneFix.onLoad`, Enabled, **Pass execution context as first parameter**.
3. Save and publish.

Also, if Power Platform admin center > your environment > Settings > Privacy + Security > Content security policy has **Enforce** on for model-driven apps, add `https://*.lightning.force.com` and `https://*.my.salesforce.com` (and your My Domain host) to *frame-ancestors*.

## 2.4 Share the Call Review app

Apps > **Contact Center Call Review** > Share > add the agents' security roles. Open it with Play and copy the `appid=` value from the address bar into Salesforce (`App_Id__c`, see Step 1.6).

Next: [Step 3 - Copilot Studio](3-configure-copilot-studio.md).
