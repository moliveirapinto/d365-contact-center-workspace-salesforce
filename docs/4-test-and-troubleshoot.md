# Step 4 - Test and troubleshoot

## First sign-in

Open the Service Console. The **Contact Center** utility item opens the workspace panel (about 1000 x 800). Click it and sign in with your Dynamics 365 agent account in the Microsoft pop-up. Set your presence to **Available**.

- Pop-up blocked: allow pop-ups for your Salesforce domain.
- Panel blank or cannot sign in: allow third-party cookies for `[*.]dynamics.com`, `[*.]microsoftonline.com`, `[*.]contactcenterai.powerplatform.com` and your Salesforce domain, and use a normal (not private) window.
- Blocked/empty icon: a Trusted URL is missing or inactive (Step 1.5); the browser console names the one to fix.
- HTTP 400 *Request Too Long*: clear cookies for dynamics.com and microsoftonline.com.

## Test call

1. Call your Contact Center number from a phone whose number is on a Salesforce Contact (Phone or Mobile).
2. Talk to the IVR and ask for a person.
3. Accept the call in the workspace panel.
4. Expect:
   - The **Contact** record and then the **Case** open automatically.
   - The Case has the Contact, `Origin = Phone` and `D365_Conversation_Id__c` filled in.
   - A **Contact Center Call** record exists, linked to the Case, with status *In progress*, and the Call Journey card shows on the Case.
   - A **Task** (*Inbound call*) is logged on the Contact, related to the Case, and its *Call Journey* field opens the journey.
5. End the call. Within one to two minutes the journey shows **Completed**, with queue, agent, talk/wait time and sentiment (the quality score follows once Dynamics 365 has evaluated the call).
6. *Recording & transcript* opens a pop-up with the player, transcript and evaluation pane.

Salesforce-only smoke test (no call): create a Case with `D365_Conversation_Id__c='00000000-0000-0000-0000-installtest01'`; within about 15 seconds a `Contact_Center_Call__c` with that conversation id and status *In progress* appears. Delete both records afterwards.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Journey stays **In progress** after the call ended | The sync flow's Salesforce connection points to another org, or the connection reference is unbound. Fix the connection reference (Step 2.2). Flow runs show *Succeeded* with an ending step `No_Salesforce_case_for_this_call`; open the run and look at the `Update_Salesforce_call` action for the Salesforce error. |
| Contact does not match the caller | Contact needs the caller's number in **Mobile Phone** (or the Account Phone). Business phone is ignored by D365 matching. |
| Case has no Contact | No Contact matched the last 10 digits; check `Phone_Last10__c` / `Mobile_Last10__c` and that the Salesforce user in the Copilot Studio connection can read Contacts. |
| No Case at all | Escalate topic: reconnect the Salesforce connection; check the Case *Create record* action has no error. |
| No call Task, nothing pops | **Contact Center Automation** must be a normal utility item (not hidden in a wrapper); permission set `Contact_Center_Demo` must be assigned (Task field permissions). Hard-refresh with Ctrl+Shift+R. |
| Case does not pop | The journey record must exist when you accept: check the flow `D365CC_Create_Call_From_Case` is active and the Case has `D365_Conversation_Id__c`. |
| Blank **Transcript** in the pop-up | Step 2.3 (Conversation form fix) not done. |
| Package install fails *can't remove property layoutPreset* | Remove the older unmanaged `d365EdgeContainer` utility item first (Step 1.1). |
| Panel is gone or layout is wrong | The utility item must use layout **compact**; `embedded` has no Copilot panel. |
| D365 widget crashes (sad face) | Check for thousands of `appnotification` records (for example from workforce-management schedule updates) in the D365 environment; delete them. |
| Salesforce shows stale pages | Ctrl+Shift+R. |

## Uninstall

1. Utility bar: restore your backup of `LightningService_UtilityBar`.
2. Salesforce: remove the permission set assignments, then delete the components of Step 1.3 and 1.2 (Setup > Deploy or `sf project delete source`), then uninstall the Microsoft package (Setup > Installed Packages).
3. Dynamics 365: delete the solution *D365 Contact Center - Salesforce Call Journey* and the form library handler.
4. Copilot Studio: delete the solution *Leasing Agent (Salesforce)* or the agent, and unbind it from the voice workstream.
