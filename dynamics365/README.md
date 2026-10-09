# Dynamics 365 solution

| File | Use it for |
|---|---|
| **`D365ContactCenterSalesforceCallJourney_1_1_1_0.zip`** | **Installing.** Import it in make.powerapps.com → Solutions → Import. See [Step 2](../docs/2-install-dynamics365.md). Unmanaged solution. |
| `webresource-source/new_d365cc_evaluationpanefix.js` | Readable copy of the Conversation form fix: Evaluation Details pane + transcript in the Salesforce pop-up (same file that is inside the solution). |

**Upgrading from 1.0.0.0 or 1.1.0.0?** Import the 1.1.1.0 zip over it. (1.1.1.0 retries the call update once after a minute, so a very short call is still completed.) The form library and handler from Step 2.3 stay the same, so there's nothing else to change.

Import-tested in a Dynamics 365 Contact Center environment.
