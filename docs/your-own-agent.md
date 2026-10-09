# Using your own Copilot Studio agent

Make three changes in your existing voice agent, in this order.

## A. Conversation id

Add a topic **D365 Context Variables** (from blank, open the code editor) with the contents of [`copilot-studio/source/d365-context-variables-topic.yaml`](../copilot-studio/source/d365-context-variables-topic.yaml). In Variables > Global > `msdyn_ConversationId` tick **External sources can set values**.

## B. Find the Contact by phone

Before the Case is created, add Salesforce **Get records** on **Contact** with:

- `Topic.CallerLast10` = last 10 digits of `Text(System.Activity.From.Name)` (strip everything that is not a digit, then `Right(..., 10)`),
- `$filter` = `Phone_Last10__c eq '<last10>' or Mobile_Last10__c eq '<last10>'`.

The two fields come from the Salesforce companion deployment (Step 1.3).

## C. Create the Case with the Contact and the conversation id

On the Salesforce **Create record** action (object **Case**) refresh the action so it sees the new fields, then set:

| Case field | Value |
|---|---|
| `Origin` | `"Phone"` |
| `SuppliedPhone` | `Text(System.Activity.From.Name)` |
| `D365_Conversation_Id__c` | `If(IsBlank(Global.msdyn_ConversationId), "", Text(Global.msdyn_ConversationId))` |
| `ContactId` | `If(IsBlank(First(Topic.CallerContact.value).Id), Blank(), First(Topic.CallerContact.value).Id)` |
| `AccountId` | `If(IsBlank(First(Topic.CallerContact.value).AccountId), Blank(), First(Topic.CallerContact.value).AccountId)` |

Keep your own Subject and Description. The `If(IsBlank(...))` guard lets test-pane conversations (which have no Dynamics 365 id) still create a Case. Do the same in any retry *Create record* for Case, then publish.
