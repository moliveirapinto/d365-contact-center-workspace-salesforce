import { LightningElement, api, track, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { MessageContext, publish, subscribe, unsubscribe, APPLICATION_SCOPE } from 'lightning/messageService';
import HOST_REQUEST from '@salesforce/messageChannel/D365EdgeHostRequest__c';
import HOST_RESPONSE from '@salesforce/messageChannel/D365EdgeHostResponse__c';
import HOST_EVENT from '@salesforce/messageChannel/D365EdgeHostEvent__c';
import findByPhone from '@salesforce/apex/CallerLookup.findByPhone';

const REQUEST_TIMEOUT_MS = 20000;
const MAX_LOG = 60;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Events the legacy SDK subscriptions already deliver; LMS copies are suppressed when the SDK is active.
const SDK_COVERED_EVENTS = new Set([
    'conversation.loaded', 'conversation.started', 'conversation.rejected', 'conversation.transferred',
    'conversation.stateChanged', 'conversation.messageReceived', 'conversation.consultStarted',
    'conversation.consultEnded', 'conversation.sentimentChanged', 'conversation.notesAdded',
    'presence.changed', 'conversation.invited', 'notification.received',
    'call.held', 'call.resumed', 'call.muted', 'call.unmuted'
]);

const SDK_SUBSCRIPTIONS = [
    { module: 'conversation', method: 'onConversationLoaded', label: 'Conversation loaded' },
    { module: 'conversation', method: 'onAccept', label: 'Accepted' },
    { module: 'conversation', method: 'onReject', label: 'Rejected' },
    { module: 'conversation', method: 'onTransfer', label: 'Transferred' },
    { module: 'conversation', method: 'onStatusChange', label: 'Status changed' },
    { module: 'conversation', method: 'onNewMessage', label: 'New message' },
    { module: 'conversation', method: 'onConsultStart', label: 'Consult started' },
    { module: 'conversation', method: 'onConsultEnd', label: 'Consult ended' },
    { module: 'conversation', method: 'onCustomerSentimentChange', label: 'Sentiment changed' },
    { module: 'conversation', method: 'onNotesAdded', label: 'Notes added' },
    { module: 'presence', method: 'onPresenceChange', label: 'Presence changed' },
    { module: 'notification', method: 'onNewConversationNotification', label: 'Incoming conversation' },
    { module: 'notification', method: 'onNewNotification', label: 'Notification' },
    { module: 'voiceOrVideoCalling', method: 'onHoldChange', label: 'Hold changed' },
    { module: 'voiceOrVideoCalling', method: 'onMuteChange', label: 'Mute changed' }
];

const STATUS_NAMES = { 2: 'Active', 3: 'Waiting', 4: 'Closed', 5: 'Wrap-up' };

function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function maskPhone(value) {
    // Only E.164 (+15551234567) or NANP-formatted numbers; leaves GUIDs, dates and enums intact.
    const mask = (pre, m) => `${pre}***-***-${m.replace(/\D/g, '').slice(-4)}`;
    return String(value)
        .replace(/(^|[^\w-])(\+\d{10,15})(?![\w-])/g, (_, pre, m) => mask(pre, m))
        .replace(/(^|[^\w-])(\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?![\w-])/g, (_, pre, m) => mask(pre, m));
}

function maskText(value) {
    return maskPhone(String(value))
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
        .replace(/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.dynamics\.com/gi, 'contoso.crm.dynamics.com');
}

function findDeep(obj, test, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return undefined;
    for (const [k, v] of Object.entries(obj)) {
        if (test(k, v)) return v;
        const nested = findDeep(v, test, depth + 1);
        if (nested !== undefined) return nested;
    }
    return undefined;
}

export default class CcSdkExplorer extends NavigationMixin(LightningElement) {
    @api targetInstanceId = '';
    @api placement = 'utility';
    @api autoScreenPop = false;
    @api maskSensitiveData = false;
    @api heading = 'Embed SDK Explorer';

    @wire(MessageContext) messageContext;

    @track log = [];
    @track handlers = [];
    @track caller;
    @track presenceOptions = [];
    @track conversations = [];

    transport = 'detecting';
    lastMethod = 'Choose a method';
    lastCode = '';
    lastTransport = '';
    lastStatus = '';
    lastResult = '';
    focusedConversationId = '';
    focusedLiveWorkItemId = '';
    selectedPresenceId = '';
    notesText = 'Caller verified. Requested a replacement card.';
    notificationText = 'VIP caller: Premier Banking customer on the line.';
    callerStatus = 'Waiting for an inbound call';
    busy = false;

    _sdk;
    _pending = new Map();
    _subs = [];
    _poll;
    _poppedKeys = new Set();
    _onSdkReady;

    connectedCallback() {
        this._subscribeLms();
        this._onSdkReady = () => this._attachSdk();
        window.addEventListener('sdkReady', this._onSdkReady);
        let tries = 0;
        this._attachSdk();
        this._poll = setInterval(() => {
            tries += 1;
            if (this._sdk || tries > 40) {
                clearInterval(this._poll);
                this._poll = null;
                if (!this._sdk && this.transport === 'detecting') {
                    this.transport = 'lms';
                    this._addLog('system', 'Transport', 'Embed SDK global not visible; using the Lightning Message Service host API.');
                }
                return;
            }
            this._attachSdk();
        }, 500);
    }

    disconnectedCallback() {
        window.removeEventListener('sdkReady', this._onSdkReady);
        if (this._poll) clearInterval(this._poll);
        this._subs.forEach((s) => unsubscribe(s));
        this._subs = [];
        this._pending.forEach((p) => clearTimeout(p.timer));
        this._pending.clear();
    }

    // ---------- transport ----------

    _attachSdk() {
        if (this._sdk) return;
        const sdk = window.Microsoft?.CCaaS?.EmbedSDK;
        if (!sdk?.conversation) return;
        this._sdk = sdk;
        this.transport = 'sdk';
        this._addLog('system', 'Transport', 'Microsoft.CCaaS.EmbedSDK detected. SDK methods call the workspace directly.');
        this._registerSdkHandlers();
    }

    _registerSdkHandlers() {
        const list = [];
        SDK_SUBSCRIPTIONS.forEach((s, i) => {
            const handlerId = `h${i + 1}`;
            const entry = { handlerId, key: `${s.module}.${s.method}`, label: s.label, code: `${s.module}.${s.method}`, enabled: true };
            const fn = this._sdk[s.module]?.[s.method];
            if (typeof fn !== 'function') {
                entry.enabled = false;
                entry.unavailable = true;
            } else {
                try {
                    fn((payload) => {
                        const live = this.handlers.find((h) => h.handlerId === handlerId);
                        if (!live || !live.enabled) return;
                        this._onEvent(s.method, payload, 'sdk', s.label);
                    });
                } catch (e) {
                    entry.enabled = false;
                    entry.unavailable = true;
                }
            }
            list.push(entry);
        });
        this.handlers = list;
    }

    _subscribeLms() {
        if (this._subs.length) return;
        // MessageContext may not be wired yet in connectedCallback; defer one tick.
        Promise.resolve().then(() => {
            if (!this.messageContext || this._subs.length) {
                if (!this.messageContext) setTimeout(() => this._subscribeLms(), 200);
                return;
            }
            this._subs.push(subscribe(this.messageContext, HOST_RESPONSE, (m) => this._onLmsResponse(m), { scope: APPLICATION_SCOPE }));
            this._subs.push(subscribe(this.messageContext, HOST_EVENT, (m) => this._onLmsEvent(m), { scope: APPLICATION_SCOPE }));
        });
    }

    _onLmsResponse(msg) {
        const p = msg && this._pending.get(msg.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this._pending.delete(msg.requestId);
        if (msg.success) {
            let data;
            try {
                data = msg.dataJson ? JSON.parse(msg.dataJson) : null;
            } catch (e) {
                data = msg.dataJson;
            }
            p.resolve(data);
        } else {
            p.reject(new Error(msg.errorMessage || 'Request failed'));
        }
    }

    _onLmsEvent(msg) {
        if (!msg) return;
        if (this.targetInstanceId && msg.instanceId && msg.instanceId !== this.targetInstanceId) return;
        if (this._sdk && SDK_COVERED_EVENTS.has(msg.eventName)) return;
        let payload;
        try {
            payload = msg.payloadJson ? JSON.parse(msg.payloadJson) : {};
        } catch (e) {
            payload = msg.payloadJson;
        }
        this._onEvent(msg.eventName, payload, 'lms', msg.eventName);
    }

    _lms(operation, name, params) {
        if (!this.messageContext) return Promise.reject(new Error('Lightning Message Service is not ready'));
        const requestId = uid();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(requestId);
                reject(new Error(`No response from the workspace within ${REQUEST_TIMEOUT_MS / 1000}s. Check Host API Instance ID and Allowed Requests.`));
            }, REQUEST_TIMEOUT_MS);
            this._pending.set(requestId, { resolve, reject, timer });
            publish(this.messageContext, HOST_REQUEST, {
                requestId,
                targetInstanceId: this.targetInstanceId,
                operation,
                name,
                paramsJson: JSON.stringify(params || {})
            });
        });
    }

    // ---------- events ----------

    _onEvent(name, payload, source, label) {
        this._addLog(source, label || name, payload);
        const convId = findDeep(payload, (k, v) => k === 'conversationId' && typeof v === 'string');
        const lwi = findDeep(payload, (k, v) => k === 'liveWorkItemId' && typeof v === 'string');
        if (convId) this.focusedConversationId = convId;
        // Message events can report the chat thread id as liveWorkItemId; keep only GUIDs.
        if (lwi && GUID_RE.test(lwi)) this.focusedLiveWorkItemId = lwi;
        if (name === 'onConversationLoaded' || name === 'conversation.loaded') {
            this._identifyCaller(payload);
        }
        if (name === 'onPresenceChange' || name === 'presence.changed') {
            const id = findDeep(payload, (k, v) => (k === 'id' || k === 'presenceId') && typeof v === 'string');
            if (id) this.selectedPresenceId = id;
        }
    }

    async _identifyCaller(payload, manual = false) {
        const phone = findDeep(payload, (k, v) => /phone/i.test(k) && typeof v === 'string' && /\d{7,}/.test(v.replace(/\D/g, '')));
        const key = findDeep(payload, (k, v) => (k === 'liveWorkItemId' || k === 'conversationId') && typeof v === 'string') || phone;
        if (!phone) {
            if (manual) this.callerStatus = 'No caller phone number on the focused conversation';
            return;
        }
        if (!manual && this._poppedKeys.has(key)) return;
        this._poppedKeys.add(key);
        this.callerStatus = `Looking up caller ${maskPhone(phone)}…`;
        const code = `CallerLookup.findByPhone('${maskPhone(phone)}')`;
        try {
            const match = await findByPhone({ phone });
            if (!match) {
                this.caller = undefined;
                this.callerStatus = `No Salesforce contact matches ${maskPhone(phone)}`;
                this._addLog('apex', 'Caller lookup', { phone: maskPhone(phone), match: null });
                return;
            }
            this.caller = {
                ...match,
                displayPhone: this.maskSensitiveData ? maskPhone(match.phone || '') : match.phone,
                displayEmail: this.maskSensitiveData && match.email ? '***@***' : match.email,
                cases: (match.openCases || []).map((c) => ({ ...c, url: `/lightning/r/Case/${c.id}/view` })),
                hasCases: (match.openCases || []).length > 0
            };
            this.callerStatus = `Caller identified: ${match.name}`;
            this._addLog('apex', 'Caller identified', { contact: match.name, account: match.accountName, code });
            if (this.isUtility && this.autoScreenPop) {
                this[NavigationMixin.Navigate]({
                    type: 'standard__recordPage',
                    attributes: { recordId: match.contactId, objectApiName: 'Contact', actionName: 'view' }
                });
            }
        } catch (e) {
            this.callerStatus = `Caller lookup failed: ${this._err(e)}`;
        }
    }

    // ---------- method catalog ----------

    get ctx() {
        return {
            conversationId: this.focusedConversationId,
            liveWorkItemId: this.focusedLiveWorkItemId || this.focusedConversationId
        };
    }

    _catalog() {
        const c = this.ctx;
        const lwi = c.liveWorkItemId;
        const conv = c.conversationId || lwi;
        const fetchXml =
            '<fetch mapping="logical" distinct="true"><entity name="msdyn_ocliveworkitem">' +
            '<attribute name="subject"/><attribute name="msdyn_channel"/><attribute name="statuscode"/>' +
            (lwi ? `<filter type="and"><condition attribute="activityid" operator="eq" value="${lwi}"/></filter>` : '') +
            '<link-entity name="contact" from="contactid" to="msdyn_customer" visible="false" link-type="outer">' +
            '<attribute name="fullname" alias="contactname"/></link-entity></entity></fetch>';
        return {
            getPresence: {
                code: 'presence.getPresence()',
                sdk: (s) => s.presence.getPresence(),
                lms: ['query', 'getAgentState', {}],
                map: (d) => d?.presence ?? d
            },
            getPresenceOptions: {
                code: 'presence.getPresenceOptions()',
                sdk: (s) => s.presence.getPresenceOptions(),
                lms: ['query', 'getPresenceOptions', {}],
                after: (d) => this._setPresenceOptions(d)
            },
            setPresence: {
                code: `presence.setPresence('${this.selectedPresenceId || '<presenceId>'}')`,
                needs: () => (this.selectedPresenceId ? '' : 'Load presence options and pick one first'),
                sdk: (s) => s.presence.setPresence(this.selectedPresenceId),
                lms: ['command', 'setPresence', { status: this.selectedPresenceId }]
            },
            getAssignedConversationsList: {
                code: 'conversation.getAssignedConversationsList(2)',
                sdk: (s) => s.conversation.getAssignedConversationsList(2),
                lms: ['query', 'getActiveConversations', {}],
                after: (d) => this._captureConversations(d)
            },
            getFocusedConversationId: {
                code: 'conversation.getFocusedConversationId()',
                sdk: (s) => s.conversation.getFocusedConversationId(),
                lms: ['query', 'getActiveConversations', {}],
                map: (d) => (d && typeof d === 'object' && 'currentConversationId' in d ? d.currentConversationId : d),
                after: (d) => {
                    if (typeof d === 'string' && d) this.focusedConversationId = d;
                    if (this._sdk?.conversation?.getAssignedConversationsList) {
                        Promise.resolve(this._sdk.conversation.getAssignedConversationsList(2))
                            .then((r) => this._captureConversations(r))
                            .catch(() => {});
                    }
                }
            },
            getConversationData: {
                code: `conversation.getConversationData('${conv || '<conversationId>'}')`,
                needs: () => (conv ? '' : 'No focused conversation yet'),
                sdk: (s) => s.conversation.getConversationData(conv),
                lms: ['query', 'getConversationData', { conversationId: c.conversationId, liveWorkItemId: lwi }],
                after: (d) => this._identifyCaller(d, true)
            },
            getTranscript: {
                code: `conversation.getTranscript('${conv || '<conversationId>'}')`,
                needs: () => (conv ? '' : 'No focused conversation yet'),
                sdk: (s) => s.conversation.getTranscript(conv),
                lms: ['query', 'getConversationTranscript', { conversationId: c.conversationId, liveWorkItemId: lwi }]
            },
            getCopilotSummary: {
                code: `conversation.getCopilotSummary('${this.focusedLiveWorkItemId || conv || '<liveWorkItemId>'}')`,
                needs: () => (conv ? '' : 'No focused conversation yet'),
                sdk: (s) => s.conversation.getCopilotSummary(this.focusedLiveWorkItemId || conv),
                sdkFn: (s) => s.conversation?.getCopilotSummary,
                lms: ['query', 'getCopilotSummary', { conversationId: c.conversationId, liveWorkItemId: lwi }]
            },
            getConversationDataUsingFetchXML: {
                code: "conversation.getConversationDataUsingFetchXML({ name: 'msdyn_ocliveworkitems', fetchXml })",
                needs: () => (lwi ? '' : 'No focused conversation yet'),
                sdk: (s) => s.conversation.getConversationDataUsingFetchXML({ name: 'msdyn_ocliveworkitems', fetchXml }),
                lms: ['query', 'retrieveMultipleRecords', { entityLogicalName: 'msdyn_ocliveworkitems', options: `?fetchXml=${encodeURIComponent(fetchXml)}` }]
            },
            retrieveRecord: {
                code: `dataverse.retrieveRecord('msdyn_ocliveworkitems', '${lwi || '<liveWorkItemId>'}', '?$select=subject,statuscode')`,
                needs: () => (lwi ? '' : 'No focused conversation yet'),
                sdk: (s) => s.dataverse.retrieveRecord('msdyn_ocliveworkitems', lwi, '?$select=subject,statuscode'),
                lms: ['query', 'retrieveRecord', { entityLogicalName: 'msdyn_ocliveworkitems', id: lwi, options: '?$select=subject,statuscode' }]
            },
            retrieveMultipleRecords: {
                code: "dataverse.retrieveMultipleRecords('msdyn_ocliveworkitems', '?$select=subject,statuscode&$top=3&$orderby=createdon desc')",
                sdk: (s) => s.dataverse.retrieveMultipleRecords('msdyn_ocliveworkitems', '?$select=subject,statuscode&$top=3&$orderby=createdon desc'),
                lms: ['query', 'retrieveMultipleRecords', { entityLogicalName: 'msdyn_ocliveworkitems', options: '?$select=subject,statuscode&$top=3&$orderby=createdon desc' }]
            },
            addNewNotification: {
                code: `notification.addNewNotification({ level: 2, message: '${this.notificationText}' })`,
                sdk: (s) => s.notification.addNewNotification({ level: 2, message: this.notificationText }),
                lms: ['command', 'addNotification', { level: 2, message: this.notificationText }]
            },
            holdCall: this._callCommand('holdCall', c),
            resumeCall: this._callCommand('resumeCall', c),
            muteCall: this._callCommand('muteCall', c),
            unmuteCall: this._callCommand('unmuteCall', c),
            setNotes: {
                code: `host API command setNotes({ conversationId, notes })`,
                needs: () => (c.conversationId ? '' : 'No focused conversation yet'),
                lms: ['command', 'setNotes', { conversationId: c.conversationId, notes: this.notesText }]
            },
            logActivity: {
                code: `host API command logActivity({ conversationId, subject, description })`,
                needs: () => (c.conversationId ? '' : 'No focused conversation yet'),
                lms: ['command', 'logActivity', { conversationId: c.conversationId, subject: 'Card replacement request', description: this.notesText }]
            },
            updateCustomerContext: {
                code: `host API command updateCustomerContext({ conversationId, entityType: 'contact', entityId })`,
                needs: () => (!c.conversationId ? 'No focused conversation yet' : this.caller ? '' : 'Identify the caller first'),
                lms: ['command', 'updateCustomerContext', { conversationId: c.conversationId, entityType: 'contact', entityId: this.caller?.contactId }]
            },
            getAgentCapabilities: { code: 'host API query getAgentCapabilities()', lms: ['query', 'getAgentCapabilities', {}] },
            getSlaStatus: {
                code: 'host API query getSlaStatus({ conversationId })',
                needs: () => (c.conversationId ? '' : 'No focused conversation yet'),
                lms: ['query', 'getSlaStatus', { conversationId: c.conversationId }]
            },
            getAvailableQueues: {
                code: 'host API query getAvailableQueues()',
                lms: ['query', 'getAvailableQueues', {}],
                map: (d) => {
                    const all = Array.isArray(d?.queues) ? d.queues : Array.isArray(d) ? d : null;
                    if (!all) return d;
                    const featured = all.filter((q) => /contoso/i.test(q.name || ''));
                    return {
                        totalQueues: all.length,
                        featured: (featured.length ? featured : all.slice(0, 3)).map((q) => ({
                            name: q.name,
                            type: String(q.queuetype).endsWith('2') ? 'voice' : 'messaging'
                        }))
                    };
                }
            },
            voiceStandalone: {
                code: 'Microsoft.CCaaS.EmbedSDK.voice.startRecording()',
                local: () => {
                    const voice = this._sdk?.voice;
                    if (voice && typeof voice.startRecording === 'function') return voice.startRecording();
                    throw new Error('The Voice module (recording and transcription) is available only in standalone mode, not in embedded workspaces.');
                }
            }
        };
    }

    _callCommand(name, c) {
        return {
            code: `host API command ${name}({ conversationId })`,
            needs: () => (c.conversationId ? '' : 'No focused conversation yet'),
            lms: ['command', name, { conversationId: c.conversationId }]
        };
    }

    _setPresenceOptions(d) {
        const arr = Array.isArray(d) ? d : d?.options || d?.presenceOptions || [];
        this.presenceOptions = arr.map((o) => ({
            label: o.text || o.name || o.label || o.presenceText || o.id,
            value: o.id || o.presenceId || o.value
        })).filter((o) => o.value);
        if (!this.selectedPresenceId && this.presenceOptions.length) this.selectedPresenceId = this.presenceOptions[0].value;
    }

    _captureConversations(d) {
        if (d && !Array.isArray(d) && typeof d.liveWorkItemId === 'string') {
            if (GUID_RE.test(d.liveWorkItemId)) this.focusedLiveWorkItemId = d.liveWorkItemId;
            return;
        }
        const arr = Array.isArray(d) ? d : d?.conversations || [];
        this.conversations = arr;
        const focused = d?.currentConversationId;
        const first = arr.find((x) => (focused ? x.conversationId === focused || x.id === focused : true)) || arr[0];
        if (first) {
            this.focusedConversationId = first.conversationId || first.id || this.focusedConversationId;
            if (GUID_RE.test(first.liveWorkItemId || '')) this.focusedLiveWorkItemId = first.liveWorkItemId;
        }
    }

    async handleMethod(event) {
        const method = event.currentTarget.dataset.method;
        const def = this._catalog()[method];
        if (!def) return;
        this.lastMethod = method;
        this.lastCode = def.code;
        this.lastResult = '';
        const missing = def.needs?.();
        if (missing) {
            this.lastStatus = 'skipped';
            this.lastTransport = '—';
            this.lastResult = missing;
            return;
        }
        this.busy = true;
        this.lastStatus = 'running';
        const started = Date.now();
        try {
            let data;
            if (def.local) {
                this.lastTransport = 'SDK';
                data = await def.local();
            } else if (def.sdk && this._sdk && !(def.sdkFn && typeof def.sdkFn(this._sdk) !== 'function' && def.lms)) {
                this.lastTransport = 'Embed SDK';
                data = await def.sdk(this._sdk);
            } else if (def.lms) {
                const [op, name, params] = def.lms;
                this.lastTransport = `Host API · ${op}:${name}`;
                data = await this._lms(op, name, params);
            } else {
                throw new Error('No transport available');
            }
            if (def.map) data = def.map(data);
            if (def.after) def.after(data);
            this.lastStatus = `success · ${Date.now() - started} ms`;
            this.lastResult = this._fmt(data === undefined ? '(no data returned)' : data);
        } catch (e) {
            this.lastStatus = `error · ${Date.now() - started} ms`;
            this.lastResult = this._err(e);
        } finally {
            this.busy = false;
        }
    }

    handleRemoveHandler(event) {
        const id = event.currentTarget.dataset.id;
        this.handlers = this.handlers.map((h) => (h.handlerId === id ? { ...h, enabled: !h.enabled } : h));
        const h = this.handlers.find((x) => x.handlerId === id);
        this._addLog('system', h.enabled ? 'Handler re-added' : 'removeEventHandlerById', { handlerId: id, event: h.code });
    }

    handlePresencePick(event) {
        this.selectedPresenceId = event.detail.value;
    }

    handleNotesChange(event) {
        this.notesText = event.target.value;
    }

    handleIdentify() {
        this._identifyCaller({ conversationId: this.focusedConversationId, phone: this._lastPhoneHint() }, true);
    }

    handleOpenCaller() {
        if (!this.caller) return;
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId: this.caller.contactId, objectApiName: 'Contact', actionName: 'view' }
        });
    }

    handleClearLog() {
        this.log = [];
    }

    _lastPhoneHint() {
        for (const entry of this.log) {
            if (entry.phone) return entry.phone;
        }
        return undefined;
    }

    // ---------- presentation ----------

    _addLog(source, label, payload) {
        const phone = payload && typeof payload === 'object'
            ? findDeep(payload, (k, v) => /phone/i.test(k) && typeof v === 'string')
            : undefined;
        const status = payload && typeof payload === 'object' ? payload.statusCode ?? payload.status : undefined;
        const entry = {
            id: uid(),
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            source: source === 'sdk' ? 'SDK' : source === 'lms' ? 'LMS' : source === 'apex' ? 'Apex' : 'Info',
            badgeClass: `badge badge-${source}`,
            label: STATUS_NAMES[status] ? `${label} → ${STATUS_NAMES[status]}` : label,
            detail: typeof payload === 'string' ? payload : this._fmt(payload, true),
            phone
        };
        this.log = [entry, ...this.log].slice(0, MAX_LOG);
    }

    _fmt(data, compact = false) {
        let text;
        try {
            text = typeof data === 'string' ? data : JSON.stringify(data, null, compact ? 0 : 2);
        } catch (e) {
            text = String(data);
        }
        if (compact && text && text.length > 220) text = `${text.slice(0, 220)}…`;
        return this.maskSensitiveData ? maskText(text) : text;
    }

    _err(e) {
        const msg = e?.body?.message || e?.message || String(e);
        return this.maskSensitiveData ? maskText(msg) : msg;
    }

    get isUtility() {
        return this.placement === 'utility';
    }

    get rootClass() {
        return `explorer ${this.isUtility ? 'explorer-utility' : 'explorer-page'}`;
    }

    get transportLabel() {
        if (this.transport === 'sdk') return 'Embed SDK + Host API';
        if (this.transport === 'lms') return 'Host API (LMS)';
        return 'Detecting…';
    }

    get transportClass() {
        return `pill ${this.transport === 'sdk' ? 'pill-ok' : this.transport === 'lms' ? 'pill-info' : 'pill-wait'}`;
    }

    get focusedLabel() {
        const id = this.focusedLiveWorkItemId || this.focusedConversationId;
        return id ? `${id.slice(0, 8)}…` : 'none';
    }

    get statusClass() {
        if (this.lastStatus.startsWith('success')) return 'status status-ok';
        if (this.lastStatus.startsWith('error')) return 'status status-err';
        if (this.lastStatus === 'skipped') return 'status status-warn';
        return 'status';
    }

    get hasResult() {
        return !!this.lastCode;
    }

    get hasPresenceOptions() {
        return this.presenceOptions.length > 0;
    }

    get hasLog() {
        return this.log.length > 0;
    }

    get handlerRows() {
        return this.handlers.map((h) => ({
            ...h,
            buttonLabel: h.unavailable ? 'n/a' : h.enabled ? 'Remove' : 'Re-add',
            rowClass: `handler ${h.enabled ? '' : 'handler-off'}`,
            variant: h.enabled ? 'neutral' : 'brand-outline'
        }));
    }

    get hasHandlers() {
        return this.handlers.length > 0;
    }
}
