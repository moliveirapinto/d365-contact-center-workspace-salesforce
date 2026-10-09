# Step 3 - Copilot Studio "Leasing Agent"

The repo ships a ready-made voice IVR agent, **Leasing Agent**, as a solution (`copilot-studio/LeasingAgentSalesforce_1_0_0_0.zip`, unmanaged). It answers the call, and when the caller wants a person its **Escalate** topic:

1. reads the caller's phone number,
2. looks up the Salesforce **Contact** whose Phone or Mobile matches (last 10 digits, via `Phone_Last10__c` / `Mobile_Last10__c`),
3. creates a **Case** with that Contact and Account, `Origin = Phone`, and the Dynamics 365 conversation id in `D365_Conversation_Id__c`,
4. transfers the call to a human agent.

The text and branding are generic ("Contoso Leasing"); edit the topics freely.

Already have your own agent? Skip the import and apply [your-own-agent.md](your-own-agent.md) instead.

## 3.1 Import

1. https://make.powerapps.com > the **same environment as Contact Center** > Solutions > Import solution > `LeasingAgentSalesforce_1_0_0_0.zip`.
2. When asked for connections, create a **Salesforce** connection (Production/Sandbox to match) and sign in with the Salesforce user that holds both permission sets.
3. Import. You get the agent *Leasing Agent* (schema `maulabs_LeasingAgent`) with 26 components.

## 3.2 Re-bind the Salesforce connection

Open the agent in https://copilotstudio.microsoft.com > **Topics > Escalate**. For each Salesforce action (*Get records* for the Contact, *Create record* for the Case) open it and select your Salesforce connection if it shows *Connection needed*. Also check Tools / Actions: remove or fix any Salesforce item that shows an error.

## 3.3 Check the conversation-id topic

Topic **D365 Context Variables** must exist and set the global variable `Global.msdyn_ConversationId` (see [`copilot-studio/source/d365-context-variables-topic.yaml`](../copilot-studio/source/d365-context-variables-topic.yaml)). In Variables > Global > `msdyn_ConversationId`, **External sources can set values** must be ticked. Contact Center fills it in on every call.

## 3.4 Publish

Publish the agent. If it will answer live callers, confirm that first.

## 3.5 Connect it to your voice channel

Dynamics 365 **Customer Service admin center** > Customer support > **Workstreams** > your **Voice** workstream > **Behaviors / Bots** (the section where the Copilot Studio agent is selected) > choose **Leasing Agent**. Make sure the workstream's routing sends escalations to a queue with your agents in it, and that the agent presence in the workspace is *Available*. This part is done in the Dynamics 365 UI and cannot be scripted.

## Notes

- **Phone matching** uses the Contact's *Phone* or *Mobile*; format does not matter, only the last 10 digits. No match is fine: the Case is simply created without a Contact.
- A Salesforce user creates the Case, so that user needs *Create* on Case and the permission set `D365_Contact_Center_Call_Access`.
- `Escalate` also writes `AccountId` when the Contact has one.
- The IVR needs a **voice** channel already working in Contact Center (a phone number and a voice workstream); this repo does not provision one.

Next: [Step 4 - Test](4-test-and-troubleshoot.md).
