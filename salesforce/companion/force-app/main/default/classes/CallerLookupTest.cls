@IsTest
private class CallerLookupTest {
    @IsTest
    static void findsContactBySosl() {
        Account a = new Account(Name = 'Test Account');
        insert a;
        Contact c = new Contact(LastName = 'Caller', FirstName = 'Test', Phone = '+15550101234', AccountId = a.Id);
        insert c;
        insert new Case(Subject = 'Open case', ContactId = c.Id, Status = 'New');
        Test.setFixedSearchResults(new List<Id>{ c.Id });

        Test.startTest();
        CallerLookup.CallerMatch m = CallerLookup.findByPhone('+1 (555) 010-1234');
        Test.stopTest();

        System.assertNotEquals(null, m);
        System.assertEquals(c.Id, m.contactId);
        System.assertEquals('Test Account', m.accountName);
        System.assertEquals(1, m.openCases.size());
    }

    @IsTest
    static void fallsBackToSoql() {
        Contact c = new Contact(LastName = 'Mobile', MobilePhone = '555-010-9876');
        insert c;
        CallerLookup.CallerMatch m = CallerLookup.findByPhone('15550109876');
        System.assertNotEquals(null, m);
        System.assertEquals(c.Id, m.contactId);
    }

    @IsTest
    static void ignoresShortOrMissingNumbers() {
        System.assertEquals(null, CallerLookup.findByPhone(null));
        System.assertEquals(null, CallerLookup.findByPhone('123'));
        System.assertEquals(null, CallerLookup.findByPhone('5550000000'));
    }
}
