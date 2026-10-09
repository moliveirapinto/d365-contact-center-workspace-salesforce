/**
 * Salesforce side of the Contact Center Embed SDK demo. Records interactions as
 * Tasks, resolves callers, and lets Flow request workspace actions through the
 * Contact_Center_Action__e platform event. Customer-owned sample code.
 */
public with sharing class ContactCenterService {
    public static final Set<String> FLOW_OPERATIONS = new Set<String>{ 'addNotification', 'setNotes' };
    private static final Integer DESCRIPTION_MAX = 32000;
    @TestVisible private static List<Contact_Center_Action__e> lastPublished = new List<Contact_Center_Action__e>();

    public class Interaction {
        @AuraEnabled public Id taskId;
        @AuraEnabled public Id contactId;
        @AuraEnabled public String conversationId;
        @AuraEnabled public String liveWorkItemId;
        @AuraEnabled public Boolean created;
        @AuraEnabled public Id caseId;
    }

    public class CaseMatch {
        @AuraEnabled public Id caseId;
        @AuraEnabled public Id contactId;
        @AuraEnabled public String contactName;
    }

    /**
     * Finds the Case the IVR created for this conversation (D365_Conversation_Id__c), so the agent
     * gets the Case even when the caller's phone matches no Contact.
     */
    @AuraEnabled
    public static CaseMatch findCase(String conversationId, String liveWorkItemId) {
        List<String> ids = new List<String>();
        for (String s : new List<String>{ liveWorkItemId, conversationId }) {
            if (String.isNotBlank(s)) { ids.add(s); }
        }
        if (ids.isEmpty() || !Schema.getGlobalDescribe().get('Case').getDescribe().fields.getMap().containsKey('D365_Conversation_Id__c')) {
            return null;
        }
        List<Case> cases = Database.query('SELECT Id, ContactId, Contact.Name FROM Case WHERE D365_Conversation_Id__c IN :ids ORDER BY CreatedDate DESC LIMIT 1');
        if (cases.isEmpty()) {
            return null;
        }
        CaseMatch m = new CaseMatch();
        m.caseId = cases[0].Id;
        m.contactId = cases[0].ContactId;
        m.contactName = cases[0].Contact?.Name;
        return m;
    }
    @AuraEnabled
    public static CallerLookup.CallerMatch findCaller(String phone, String name) {
        CallerLookup.CallerMatch match = CallerLookup.findByPhone(phone);
        if (match != null || String.isBlank(name)) {
            return match;
        }
        List<Contact> byName = [
            SELECT Id FROM Contact WHERE Name = :name.trim() ORDER BY LastModifiedDate DESC LIMIT 1
        ];
        if (byName.isEmpty()) {
            return null;
        }
        Contact c = [SELECT Phone, MobilePhone FROM Contact WHERE Id = :byName[0].Id];
        match = CallerLookup.findByPhone(c.Phone != null ? c.Phone : c.MobilePhone);
        if (match == null) {
            match = new CallerLookup.CallerMatch();
            Contact full = [SELECT Id, Name, Title, Email, AccountId, Account.Name FROM Contact WHERE Id = :c.Id];
            match.contactId = full.Id;
            match.name = full.Name;
            match.title = full.Title;
            match.email = full.Email;
            match.accountId = full.AccountId;
            match.accountName = full.Account?.Name;
            match.matchCount = 1;
            match.openCases = new List<CallerLookup.CaseInfo>();
        }
        return match;
    }

    /**
     * Links the interaction Task to the Contact Center call journey record (Contact_Center_Call__c)
     * so the Task opens the journey instead of duplicating it. Matches on the Dynamics 365
     * conversation id, then falls back to the Contact's most recent call. No-op when the
     * journey object is not installed.
     */
    private static void linkJourney(Task t, Id contactId, String liveWorkItemId, String conversationId) {
        if (t == null || t.get('Call_Journey__c') != null
            || !Schema.getGlobalDescribe().containsKey('Contact_Center_Call__c')) {
            return;
        }
        List<String> ids = new List<String>();
        for (String s : new List<String>{ liveWorkItemId, conversationId }) {
            if (String.isNotBlank(s)) { ids.add(s); }
        }
        List<SObject> calls = new List<SObject>();
        if (!ids.isEmpty()) {
            calls = Database.query('SELECT Id, Case__c, Contact__c FROM Contact_Center_Call__c WHERE Conversation_Id__c IN :ids ORDER BY CreatedDate DESC LIMIT 1');
        }
        if (calls.isEmpty() && contactId != null) {
            Datetime since = Datetime.now().addHours(-2);
            calls = Database.query('SELECT Id, Case__c, Contact__c FROM Contact_Center_Call__c WHERE (Contact__c = :contactId OR Case__r.ContactId = :contactId) AND Call_Received__c >= :since ORDER BY Call_Received__c DESC LIMIT 1');
        }
        if (calls.isEmpty()) {
            return;
        }
        SObject call = calls[0];
        t.put('Call_Journey__c', call.Id);
        if (t.WhatId == null && call.get('Case__c') != null) {
            t.WhatId = (Id) call.get('Case__c');
        }
        if (call.get('Contact__c') == null && contactId != null) {
            call.put('Contact__c', contactId);
            update call;
        }
    }
    @AuraEnabled
    public static Interaction startInteraction(
        Id contactId, String conversationId, String liveWorkItemId, String channel, String queueName
    ) {
        if (String.isBlank(conversationId)) {
            throw new AuraHandledException('conversationId is required');
        }
        Interaction result = new Interaction();
        result.contactId = contactId;
        result.conversationId = conversationId;
        List<Task> existing = [
            SELECT Id, WhoId, WhatId, Live_Work_Item_Id__c FROM Task
            WHERE Conversation_Id__c = :conversationId AND IsClosed = false
            ORDER BY CreatedDate DESC LIMIT 1
        ];
        Task t;
        if (!existing.isEmpty()) {
            t = existing[0];
            result.created = false;
            if (String.isNotBlank(liveWorkItemId) && t.Live_Work_Item_Id__c != liveWorkItemId) {
                t.Live_Work_Item_Id__c = liveWorkItemId;
                update t;
            }
        } else {
            String ch = channel == 'Voice' ? 'Voice' : 'Chat';
            t = new Task(
                Subject = ch == 'Voice' ? 'Inbound call' : 'Inbound chat',
                Status = 'In Progress',
                Priority = 'Normal',
                ActivityDate = Date.today(),
                OwnerId = UserInfo.getUserId(),
                WhoId = contactId,
                TaskSubtype = ch == 'Voice' ? 'Call' : 'Task',
                Conversation_Id__c = conversationId,
                Live_Work_Item_Id__c = liveWorkItemId,
                Channel__c = ch,
                Queue__c = queueName == null ? null : queueName.left(120),
                Sync_To_Workspace__c = false
            );
            linkJourney(t, contactId, liveWorkItemId, conversationId);
            if (t.WhatId == null) {
                CaseMatch cm = findCase(conversationId, liveWorkItemId);
                if (cm != null) { t.WhatId = cm.caseId; }
            }
            insert t;
            result.created = true;
        }
        result.taskId = t.Id;
        if (t.WhatId != null && t.WhatId.getSObjectType() == Case.SObjectType) { result.caseId = t.WhatId; }
        result.liveWorkItemId = String.isNotBlank(liveWorkItemId) ? liveWorkItemId : t.Live_Work_Item_Id__c;
        if (contactId != null) {
            update new Contact(Id = contactId, Active_Conversation_Id__c = conversationId);
        }
        return result;
    }

    /**
     * Applies SDK event data to the interaction Task. Supported keys: sentiment,
     * slaStatus, queue, liveWorkItemId, muted (Boolean), held (Boolean, counts holds),
     * note (appended to Description).
     */
    @AuraEnabled
    public static void updateInteraction(Id taskId, Map<String, Object> changes) {
        if (taskId == null || changes == null || changes.isEmpty()) {
            return;
        }
        Task t = [SELECT Id, WhoId, WhatId, Hold_Count__c, Description, Sentiment__c, Call_Journey__c, Conversation_Id__c, Live_Work_Item_Id__c FROM Task WHERE Id = :taskId];
        if (changes.containsKey('sentiment')) {
            String s = normalizeSentiment(String.valueOf(changes.get('sentiment')));
            if (s != null) {
                t.Sentiment__c = s;
                if (t.WhoId != null && t.WhoId.getSObjectType() == Contact.SObjectType) {
                    update new Contact(Id = t.WhoId, Last_Sentiment__c = s);
                }
            }
        }
        if (changes.containsKey('slaStatus')) {
            t.SLA_Status__c = String.valueOf(changes.get('slaStatus')).left(80);
        }
        if (changes.containsKey('queue')) {
            t.Queue__c = String.valueOf(changes.get('queue')).left(120);
        }
        if (changes.containsKey('liveWorkItemId')) {
            t.Live_Work_Item_Id__c = String.valueOf(changes.get('liveWorkItemId')).left(40);
        }
        if (changes.containsKey('muted')) {
            t.Muted__c = changes.get('muted') == true;
        }
        if (t.Call_Journey__c == null) {
            linkJourney(t, t.WhoId, t.Live_Work_Item_Id__c, t.Conversation_Id__c);
        }
        if (changes.get('held') == true) {
            t.Hold_Count__c = (t.Hold_Count__c == null ? 0 : t.Hold_Count__c) + 1;
        }
        if (changes.containsKey('note')) {
            String line = String.valueOf(changes.get('note'));
            t.Description = (String.isBlank(t.Description) ? line : t.Description + '\n' + line).right(DESCRIPTION_MAX);
        }
        update t;
    }

    @AuraEnabled
    public static void completeInteraction(Id taskId, String transcript, String summary) {
        Task t = [SELECT Id, WhoId, WhatId, Description, Call_Journey__c, Conversation_Id__c, Live_Work_Item_Id__c FROM Task WHERE Id = :taskId];
        linkJourney(t, t.WhoId, t.Live_Work_Item_Id__c, t.Conversation_Id__c);
        List<String> parts = new List<String>();
        if (String.isNotBlank(summary)) {
            parts.add('Copilot summary\n' + summary);
        }
        if (String.isNotBlank(t.Description)) {
            parts.add('Agent notes\n' + t.Description);
        }
        if (String.isNotBlank(transcript)) {
            parts.add('Transcript\n' + transcript);
        }
        t.Description = String.join(parts, '\n\n').left(DESCRIPTION_MAX);
        t.Status = 'Completed';
        update t;
        if (t.WhoId != null && t.WhoId.getSObjectType() == Contact.SObjectType) {
            update new Contact(Id = t.WhoId, Active_Conversation_Id__c = null);
        }
    }

    public class ActionRequest {
        @InvocableVariable(label='Operation' description='addNotification or setNotes' required=true)
        public String operation;
        @InvocableVariable(label='Contact Id' description='Contact in the active conversation' required=true)
        public Id contactId;
        @InvocableVariable(label='Message' description='Notification text or notes to send')
        public String message;
        @InvocableVariable(label='Notification level' description='0 info, 1 success, 2 warning, 3 error')
        public Integer level;
    }

    @InvocableMethod(
        label='Send action to Contact Center workspace'
        description='Publishes Contact_Center_Action__e for the agent who has the contact in an active conversation.'
        category='Contact Center'
    )
    public static void publishAction(List<ActionRequest> requests) {
        Set<Id> contactIds = new Set<Id>();
        for (ActionRequest r : requests) {
            if (r.contactId != null && r.contactId.getSObjectType() == Contact.SObjectType) {
                contactIds.add(r.contactId);
            }
        }
        Map<Id, Contact> contacts = new Map<Id, Contact>(
            [SELECT Id, Active_Conversation_Id__c FROM Contact WHERE Id IN :contactIds]
        );
        List<Contact_Center_Action__e> events = new List<Contact_Center_Action__e>();
        for (ActionRequest r : requests) {
            Contact c = contacts.get(r.contactId);
            if (c == null || String.isBlank(c.Active_Conversation_Id__c) || !FLOW_OPERATIONS.contains(r.operation)) {
                continue;
            }
            Map<String, Object> payload = new Map<String, Object>{ 'conversationId' => c.Active_Conversation_Id__c };
            if (r.operation == 'addNotification') {
                payload.put('level', r.level == null ? 0 : r.level);
                payload.put('message', r.message);
            } else {
                payload.put('notes', r.message);
            }
            events.add(new Contact_Center_Action__e(
                Operation__c = r.operation,
                Payload__c = JSON.serialize(payload),
                Contact_Id__c = c.Id,
                Conversation_Id__c = c.Active_Conversation_Id__c,
                Requested_By__c = UserInfo.getUserId()
            ));
        }
        lastPublished = events;
        if (!events.isEmpty()) {
            EventBus.publish(events);
        }
    }

    private static String normalizeSentiment(String raw) {
        if (String.isBlank(raw)) {
            return null;
        }
        String v = raw.toLowerCase();
        if (v.contains('neg')) {
            return 'Negative';
        }
        if (v.contains('pos')) {
            return 'Positive';
        }
        if (v.isNumeric()) {
            // Contact center scale: 0 N/A, 7-9 negative, 10 neutral, 11-13 positive.
            Integer n = Integer.valueOf(v);
            return (n >= 7 && n <= 9) ? 'Negative' : (n >= 11 ? 'Positive' : 'Neutral');
        }
        return 'Neutral';
    }
}
