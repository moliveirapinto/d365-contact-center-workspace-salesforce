/**
 * Resolves an inbound caller's phone number to a Salesforce Contact for the
 * Contact Center SDK Explorer. Customer-owned sample code; runs with sharing.
 */
public with sharing class CallerLookup {
    public class CaseInfo {
        @AuraEnabled public Id id;
        @AuraEnabled public String caseNumber;
        @AuraEnabled public String subject;
        @AuraEnabled public String status;
        @AuraEnabled public String priority;
    }

    public class CallerMatch {
        @AuraEnabled public Id contactId;
        @AuraEnabled public String name;
        @AuraEnabled public String title;
        @AuraEnabled public String phone;
        @AuraEnabled public String email;
        @AuraEnabled public Id accountId;
        @AuraEnabled public String accountName;
        @AuraEnabled public Integer matchCount;
        @AuraEnabled public List<CaseInfo> openCases;
    }

    @AuraEnabled
    public static CallerMatch findByPhone(String phone) {
        String digits = phone == null ? '' : phone.replaceAll('[^0-9]', '');
        if (digits.length() < 7) {
            return null;
        }
        String last10 = digits.length() > 10 ? digits.substring(digits.length() - 10) : digits;

        List<Contact> matches = new List<Contact>();
        List<List<SObject>> found = [
            FIND :last10 IN PHONE FIELDS
            RETURNING Contact(Id, Name, Title, Phone, MobilePhone, Email, AccountId, Account.Name ORDER BY LastModifiedDate DESC LIMIT 5)
        ];
        if (!found.isEmpty()) {
            matches.addAll((List<Contact>) found[0]);
        }
        if (matches.isEmpty()) {
            String pattern = '%' + last10.right(4);
            for (Contact c : [
                SELECT Id, Name, Title, Phone, MobilePhone, Email, AccountId, Account.Name
                FROM Contact
                WHERE Phone LIKE :pattern OR MobilePhone LIKE :pattern
                ORDER BY LastModifiedDate DESC
                LIMIT 20
            ]) {
                String p = c.Phone == null ? '' : c.Phone.replaceAll('[^0-9]', '');
                String m = c.MobilePhone == null ? '' : c.MobilePhone.replaceAll('[^0-9]', '');
                if (p.endsWith(last10) || m.endsWith(last10)) {
                    matches.add(c);
                }
            }
        }
        if (matches.isEmpty()) {
            return null;
        }

        Contact c = matches[0];
        CallerMatch result = new CallerMatch();
        result.contactId = c.Id;
        result.name = c.Name;
        result.title = c.Title;
        result.phone = c.Phone != null ? c.Phone : c.MobilePhone;
        result.email = c.Email;
        result.accountId = c.AccountId;
        result.accountName = c.Account?.Name;
        result.matchCount = matches.size();
        result.openCases = new List<CaseInfo>();
        for (Case cs : [
            SELECT Id, CaseNumber, Subject, Status, Priority
            FROM Case
            WHERE ContactId = :c.Id AND IsClosed = false
            ORDER BY CreatedDate DESC
            LIMIT 3
        ]) {
            CaseInfo ci = new CaseInfo();
            ci.id = cs.Id;
            ci.caseNumber = cs.CaseNumber;
            ci.subject = cs.Subject;
            ci.status = cs.Status;
            ci.priority = cs.Priority;
            result.openCases.add(ci);
        }
        return result;
    }
}
