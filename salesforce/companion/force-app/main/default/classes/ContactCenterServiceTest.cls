@IsTest
private class ContactCenterServiceTest {
    @TestSetup
    static void setup() {
        Account a = new Account(Name = 'Contoso');
        insert a;
        insert new Contact(FirstName = 'Pat', LastName = 'Caller', Phone = '+1 (555) 010-2030', AccountId = a.Id);
        insert new Contact(FirstName = 'Chat', LastName = 'Only', AccountId = a.Id);
    }

    @IsTest
    static void findCallerByPhoneAndName() {
        Contact pat = [SELECT Id FROM Contact WHERE LastName = 'Caller'];
        Test.setFixedSearchResults(new List<Id>{ pat.Id });
        Assert.areEqual(pat.Id, ContactCenterService.findCaller('15550102030', null).contactId);
        CallerLookup.CallerMatch byName = ContactCenterService.findCaller(null, 'Chat Only');
        Assert.areEqual('Chat Only', byName.name);
        Assert.isNull(ContactCenterService.findCaller(null, 'Nobody Here'));
    }

    @IsTest
    static void callWithoutContactStillLogsTaskOnCase() {
        Case c = new Case(Subject = 'IVR case', Origin = 'Phone');
        c.put('D365_Conversation_Id__c', 'conv-no-contact-1');
        insert c;
        ContactCenterService.CaseMatch m = ContactCenterService.findCase('conv-no-contact-1', null);
        Assert.areEqual(c.Id, m.caseId);
        Assert.isNull(ContactCenterService.findCase('unknown-conv', null));
        ContactCenterService.Interaction i = ContactCenterService.startInteraction(null, 'conv-no-contact-1', null, 'Voice', null);
        Assert.areEqual(c.Id, [SELECT WhatId FROM Task WHERE Id = :i.taskId].WhatId);
        Assert.areEqual(c.Id, i.caseId);
    }

    @IsTest
    static void interactionLifecycle() {
        Contact pat = [SELECT Id FROM Contact WHERE LastName = 'Caller'];
        ContactCenterService.Interaction i = ContactCenterService.startInteraction(
            pat.Id, '19:abc@thread.v2', null, 'Voice', 'Contoso voice'
        );
        Assert.isTrue(i.created);
        ContactCenterService.Interaction again = ContactCenterService.startInteraction(
            pat.Id, '19:abc@thread.v2', '00000000-0000-0000-0000-000000000001', 'Voice', null
        );
        Assert.isFalse(again.created);
        Assert.areEqual(i.taskId, again.taskId);
        Assert.areEqual('19:abc@thread.v2', [SELECT Active_Conversation_Id__c FROM Contact WHERE Id = :pat.Id].Active_Conversation_Id__c);

        ContactCenterService.updateInteraction(i.taskId, new Map<String, Object>{
            'sentiment' => 'Negative', 'slaStatus' => 'Within SLA', 'queue' => 'Q',
            'liveWorkItemId' => '00000000-0000-0000-0000-000000000002',
            'muted' => true, 'held' => true, 'note' => 'first'
        });
        ContactCenterService.updateInteraction(i.taskId, new Map<String, Object>{ 'held' => true, 'note' => 'second', 'sentiment' => '8' });
        ContactCenterService.updateInteraction(i.taskId, new Map<String, Object>{ 'sentiment' => '5' });
        ContactCenterService.updateInteraction(i.taskId, new Map<String, Object>{ 'sentiment' => '2' });
        ContactCenterService.updateInteraction(i.taskId, new Map<String, Object>{ 'sentiment' => 'positive' });
        ContactCenterService.updateInteraction(i.taskId, null);
        Task t = [SELECT Hold_Count__c, Muted__c, Sentiment__c, Description FROM Task WHERE Id = :i.taskId];
        Assert.areEqual(2, t.Hold_Count__c);
        Assert.isTrue(t.Muted__c);
        Assert.areEqual('Positive', t.Sentiment__c);

        ContactCenterService.completeInteraction(i.taskId, 'Customer: hi', 'Customer asked about a card.');
        t = [SELECT Status, Description FROM Task WHERE Id = :i.taskId];
        Assert.areEqual('Completed', t.Status);
        Assert.isTrue(t.Description.contains('Copilot summary'));
        Assert.isNull([SELECT Active_Conversation_Id__c FROM Contact WHERE Id = :pat.Id].Active_Conversation_Id__c);
    }

    @IsTest
    static void startRequiresConversation() {
        try {
            ContactCenterService.startInteraction(null, '', null, 'Chat', null);
            Assert.fail('expected exception');
        } catch (AuraHandledException e) {
            Assert.isNotNull(e);
        }
    }

    @IsTest
    static void publishActionOnlyForActiveConversations() {
        Contact pat = [SELECT Id FROM Contact WHERE LastName = 'Caller'];
        Contact other = [SELECT Id FROM Contact WHERE LastName = 'Only'];
        update new Contact(Id = pat.Id, Active_Conversation_Id__c = '19:abc@thread.v2');

        List<ContactCenterService.ActionRequest> reqs = new List<ContactCenterService.ActionRequest>();
        for (String op : new List<String>{ 'addNotification', 'setNotes', 'clickToDial' }) {
            ContactCenterService.ActionRequest r = new ContactCenterService.ActionRequest();
            r.operation = op;
            r.contactId = pat.Id;
            r.message = 'hello';
            reqs.add(r);
        }
        ContactCenterService.ActionRequest inactive = new ContactCenterService.ActionRequest();
        inactive.operation = 'addNotification';
        inactive.contactId = other.Id;
        reqs.add(inactive);

        Test.startTest();
        ContactCenterService.publishAction(reqs);
        Test.stopTest();
        Assert.areEqual(2, ContactCenterService.lastPublished.size(), 'clickToDial and inactive contacts are skipped');
        Assert.areEqual('addNotification', ContactCenterService.lastPublished[0].Operation__c);
        Assert.areEqual('setNotes', ContactCenterService.lastPublished[1].Operation__c);
    }
}
