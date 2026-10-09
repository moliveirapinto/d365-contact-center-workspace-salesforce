import { LightningElement, api, wire } from 'lwc';
import { getRelatedListRecords } from 'lightning/uiRelatedListApi';
import { getRecord } from 'lightning/uiRecordApi';
import { refreshApex } from '@salesforce/apex';
import { NavigationMixin } from 'lightning/navigation';
import CallRecordingModal from 'c/callRecordingModal';
import LOCALE from '@salesforce/i18n/locale';
import TIME_ZONE from '@salesforce/i18n/timeZone';
import { iconSrc } from './icons';

const O = 'Contact_Center_Call__c';
const FIELDS = [
    'Name', 'Status__c', 'Call_Received__c', 'Agent_Connected__c', 'Call_Ended__c', 'Queue__c', 'Agent__c',
    'Customer_Sentiment__c', 'Caller_Phone__c', 'Talk_Time_Seconds__c', 'Wait_Time_Seconds__c',
    'Total_Duration_Seconds__c', 'Virtual_Agent_Seconds__c', 'Recording_Url__c'
].map((f) => `${O}.${f}`);
const LIVE_POLL_MS = 15000;

// Same palette as the ServiceNow call journey (Fluent 2).
const BRAND = '#0f6cbd';
const OK = '#107c10';
const BAD = '#b10e1c';
const WARN = '#9d5d00';
const TEXT2 = '#616161';
const TEXT3 = '#8a8a8a';

// sentiment label -> [icon, tone colour]
const SENTIMENT = {
    'Very positive': ['happy', OK], Positive: ['happy', OK], 'Slightly positive': ['smile', OK],
    Neutral: ['neutral', TEXT2],
    'Slightly negative': ['sad', WARN], Negative: ['sad', BAD], 'Very negative': ['angry', BAD]
};

const secs = (n) => {
    if (n === null || n === undefined || n === '') return null;
    const v = Math.round(Number(n));
    if (v < 60) return `${v}s`;
    const m = Math.floor(v / 60);
    const s = String(v % 60).padStart(2, '0');
    return m < 60 ? `${m}m ${s}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(LOCALE, { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }) : '');
const dateLong = (iso) => new Date(iso).toLocaleDateString(LOCALE, { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

export default class CallTimeline extends NavigationMixin(LightningElement) {
    @api recordId;
    @api objectApiName;
    wired;
    records = [];
    loaded = false;
    timer;

    get relatedListId() {
        return 'Contact_Center_Calls__r';
    }

    // On a Contact Center Call record page the card shows that single call; on a Case/Contact it lists related calls.
    get isCallRecord() {
        return this.objectApiName === O;
    }

    get parentId() {
        return this.isCallRecord ? undefined : this.recordId;
    }

    get callId() {
        return this.isCallRecord ? this.recordId : undefined;
    }

    get showListHeader() {
        return !this.isCallRecord;
    }

    get showDetailsLink() {
        return !this.isCallRecord;
    }

    @wire(getRecord, { recordId: '$callId', fields: FIELDS })
    wiredSingle(result) {
        if (!this.isCallRecord) return;
        this.wired = result;
        if (result.data) {
            this.records = [{ id: result.data.id, fields: result.data.fields }];
            this.loaded = true;
            this.schedulePoll();
        } else if (result.error) {
            this.records = [];
            this.loaded = true;
        }
    }

    @wire(getRelatedListRecords, {
        parentRecordId: '$parentId',
        relatedListId: '$relatedListId',
        fields: FIELDS,
        sortBy: [`${O}.Call_Received__c`],
        pageSize: 50
    })
    wiredCalls(result) {
        if (this.isCallRecord) return;
        this.wired = result;
        if (result.data) {
            this.records = result.data.records || [];
            this.loaded = true;
            this.schedulePoll();
        } else if (result.error) {
            this.records = [];
            this.loaded = true;
        }
    }

    disconnectedCallback() {
        clearTimeout(this.timer);
    }

    schedulePoll() {
        clearTimeout(this.timer);
        if (this.records.some((r) => r.fields.Status__c.value !== 'Completed')) {
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            this.timer = setTimeout(() => refreshApex(this.wired), LIVE_POLL_MS);
        }
    }

    handleRefresh() {
        refreshApex(this.wired);
    }

    get hasCalls() {
        return this.calls.length > 0;
    }

    get callCountLabel() {
        const n = this.calls.length;
        return `${n} call${n === 1 ? '' : 's'}`;
    }

    get calls() {
        return [...this.records]
            .map((r) => this.toView(r))
            .sort((a, b) => (b.received || '').localeCompare(a.received || ''))
            .map((c, i) => ({ ...c, wrapClass: i ? 'call call-next' : 'call' }));
    }

    toView(r) {
        const v = (f) => r.fields[f] && r.fields[f].value;
        const received = v('Call_Received__c');
        const connected = v('Agent_Connected__c');
        const done = v('Status__c') === 'Completed';
        const sentiment = v('Customer_Sentiment__c');
        const [sentIcon, sentColor] = SENTIMENT[sentiment] || ['neutral', TEXT2];
        const wait = secs(v('Wait_Time_Seconds__c'));
        const sep = LOCALE.toLowerCase().startsWith('en') ? ' at ' : ' · ';

        // [icon, label, meta, state] with state: done | active | live | pending
        const raw = [
            ['call_inbound', 'Call received', time(received), 'done'],
            ['bot', 'Virtual agent', secs(v('Virtual_Agent_Seconds__c')) || (done ? '' : 'handling'), 'done'],
            ['queue', `${v('Queue__c') || 'Voice'} queue`, wait ? `waited ${wait}` : '', connected || done ? 'done' : 'active'],
            ['headset', v('Agent__c') || 'Agent', connected ? `answered ${time(connected)}` : done ? '' : 'connecting', done ? 'done' : connected ? 'active' : 'pending'],
            [done ? 'check' : 'live', done ? 'Call ended' : 'In progress', done ? time(v('Call_Ended__c')) : 'live', done ? 'done' : 'live']
        ];
        const iconColor = { done: '#ffffff', live: BAD, active: BRAND, pending: TEXT3 };
        const steps = raw.map(([icon, label, meta, state], i) => ({
            key: `${r.id}-${i}`,
            icon: iconSrc(icon, iconColor[state]),
            label,
            meta,
            dotClass: `dot dot-${state}`,
            hasConnector: i > 0,
            // a connector is filled once the step it leads to has been reached
            connClass: i > 0 && (i < 3 || (i === 3 && (connected || done)) || (i === 4 && done)) ? 'conn conn-on' : 'conn'
        }));

        return {
            id: r.id,
            name: v('Name'),
            recordUrl: `/lightning/r/${O}/${r.id}/view`,
            received,
            whenFull: received ? `${dateLong(received)}${sep}${time(received)}` : '',
            statusLabel: done ? 'Completed' : 'Live',
            statusClass: done ? 'status status-done' : 'status status-live',
            headerIcon: iconSrc('call_inbound', BRAND),
            playIcon: iconSrc('play', '#ffffff'),
            openIcon: iconSrc('open', TEXT2),
            timerIcon: iconSrc('timer', BRAND),
            micIcon: iconSrc('mic', BRAND),
            phoneIcon: iconSrc('phone', BRAND),
            sentimentIcon: iconSrc(sentIcon, sentColor),
            steps,
            total: secs(v('Total_Duration_Seconds__c')) || (done ? '-' : 'Live'),
            talk: secs(v('Talk_Time_Seconds__c')),
            sentiment,
            phone: v('Caller_Phone__c'),
            agentName: v('Agent__c'),
            url: v('Recording_Url__c')
        };
    }

    openRecording(event) {
        event.preventDefault();
        const c = this.calls.find((x) => x.id === event.currentTarget.dataset.id);
        if (!c || !c.url) return;
        const when = c.received
            ? new Date(c.received).toLocaleString(LOCALE, { timeZone: TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            : '';
        CallRecordingModal.open({
            size: 'full',
            url: c.url,
            label: 'Call recording and transcript',
            subtitle: [when, c.agentName, 'Dynamics 365 Contact Center'].filter(Boolean).join(' · '),
            description: 'Dynamics 365 Contact Center conversation'
        });
    }

    openCall(event) {
        event.preventDefault();
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId: event.currentTarget.dataset.id, objectApiName: O, actionName: 'view' }
        });
    }
}