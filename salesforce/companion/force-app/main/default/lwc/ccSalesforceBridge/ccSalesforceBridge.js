import { LightningElement, api, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import { subscribe as empSubscribe, unsubscribe as empUnsubscribe, onError as empOnError } from 'lightning/empApi';
import { MessageContext, publish, subscribe, unsubscribe, APPLICATION_SCOPE } from 'lightning/messageService';
import USER_ID from '@salesforce/user/Id';
import HOST_REQUEST from '@salesforce/messageChannel/D365EdgeHostRequest__c';
import HOST_RESPONSE from '@salesforce/messageChannel/D365EdgeHostResponse__c';
import HOST_EVENT from '@salesforce/messageChannel/D365EdgeHostEvent__c';
import COMMAND from '@salesforce/messageChannel/ContactCenterCommand__c';
import RESULT from '@salesforce/messageChannel/ContactCenterResult__c';
import findCaller from '@salesforce/apex/ContactCenterService.findCaller';
import startInteraction from '@salesforce/apex/ContactCenterService.startInteraction';
import updateInteraction from '@salesforce/apex/ContactCenterService.updateInteraction';
import completeInteraction from '@salesforce/apex/ContactCenterService.completeInteraction';

const HOST_TIMEOUT_MS = 20000;
const SDK_TIMEOUT_MS = 8000;
const PLATFORM_EVENT = '/event/Contact_Center_Action__e';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVELS = { info: 0, success: 1, warning: 2, error: 3 };

// Embed SDK subscriptions and the host event each one corresponds to.
const SDK_SUBSCRIPTIONS = [
    { module: 'notification', method: 'onNewConversationNotification', event: 'conversation.invited' },
    { module: 'conversation', method: 'onAccept', event: 'conversation.started' },
    { module: 'conversation', method: 'onConversationLoaded', event: 'conversation.loaded' },
    { module: 'conversation', method: 'onReject', event: 'conversation.rejected' },
    { module: 'conversation', method: 'onTransfer', event: 'conversation.transferred' },
    { module: 'conversation', method: 'onStatusChange', event: 'conversation.stateChanged' },
    { module: 'conversation', method: 'onNewMessage', event: 'conversation.messageReceived' },
    { module: 'conversation', method: 'onCustomerSentimentChange', event: 'conversation.sentimentChanged' },
    { module: 'conversation', method: 'onNotesAdded', event: 'conversation.notesAdded' },
    { module: 'conversation', method: 'onConsultStart', event: 'conversation.consultStarted' },
    { module: 'conversation', method: 'onConsultEnd', event: 'conversation.consultEnded' },
    { module: 'presence', method: 'onPresenceChange', event: 'presence.changed' },
    { module: 'notification', method: 'onNewNotification', event: 'notification.received' },
    { module: 'voiceOrVideoCalling', method: 'onHoldChange', event: 'call.hold' },
    { module: 'voiceOrVideoCalling', method: 'onMuteChange', event: 'call.mute' }
];
const SDK_COVERED_EVENTS = new Set([
    ...SDK_SUBSCRIPTIONS.map((s) => s.event),
    'call.held', 'call.resumed', 'call.muted', 'call.unmuted'
]);

function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function findDeep(obj, test, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
    for (const [k, v] of Object.entries(obj)) {
        if (test(k, v)) return v;
        const nested = findDeep(v, test, depth + 1);
        if (nested !== undefined) return nested;
    }
    return undefined;
}

function str(obj, ...keys) {
    const wanted = new Set(keys.map((k) => k.toLowerCase()));
    return findDeep(obj, (k, v) => wanted.has(k.toLowerCase()) && typeof v === 'string' && v.trim() !== '');
}

function phoneOf(obj) {
    return findDeep(obj, (k, v) => /phone|ani|caller(id|number)/i.test(k) && typeof v === 'string' && v.replace(/\D/g, '').length >= 7);
}

function errorText(e) {
    return (e && (e.body?.message || e.message)) || String(e);
}

/**
 * Contact Center Automation bridge.
 * The only component that talks to the Contact Center workspace. It turns Salesforce triggers
 * (quick actions and Flow screens over Lightning Message Service, record-triggered Flows over a
 * platform event) into Embed SDK / host API calls, and writes workspace events back to Salesforce.
 */
export default class CcSalesforceBridge extends NavigationMixin(LightningElement) {
    @api instanceId = '';
    @api placement = 'utility';
    @api autoScreenPop = false;
    @api recordId;

    @wire(MessageContext) messageContext;

    _sdk;
    _sdkHandlerIds = {};
    _pending = new Map();
    _subs = [];
    _empSub;
    _poll;
    _onSdkReady;
    _mirrorNotifications = true;
    _conversations = new Map();
    _focusedConversationId = '';
    _invitesShown = new Set();

    get isUtility() {
        return this.placement !== 'page';
    }

    connectedCallback() {
        this._subscribeLms();
        this._subscribePlatformEvent();
        this._onSdkReady = () => this._attachSdk();
        window.addEventListener('sdkReady', this._onSdkReady);
        let tries = 0;
        this._attachSdk();
        this._poll = setInterval(() => {
            tries += 1;
            if (this._sdk || tries > 40) {
                clearInterval(this._poll);
                this._poll = null;
                if (!this._sdk) this._log('Embed SDK global not visible; using the host API over Lightning Message Service.');
                return;
            }
            this._attachSdk();
        }, 500);
    }

    disconnectedCallback() {
        window.removeEventListener('sdkReady', this._onSdkReady);
        if (this._poll) clearInterval(this._poll);
        Object.keys(this._sdkHandlerIds).forEach((key) => this._removeSdkHandler(key));
        this._subs.forEach((s) => unsubscribe(s));
        this._subs = [];
        if (this._empSub) empUnsubscribe(this._empSub, () => {});
        this._empSub = null;
        this._pending.forEach((p) => clearTimeout(p.timer));
        this._pending.clear();
    }

    // ---------------------------------------------------------------- transport

    _attachSdk() {
        if (this._sdk) return;
        const sdk = window.Microsoft?.CCaaS?.EmbedSDK;
        if (!sdk?.conversation) return;
        this._sdk = sdk;
        this._log('Embed SDK attached.');
        SDK_SUBSCRIPTIONS.forEach((s) => this._addSdkHandler(s));
    }

    _addSdkHandler(s) {
        const fn = this._sdk?.[s.module]?.[s.method];
        if (typeof fn !== 'function') return;
        try {
            const id = fn.call(this._sdk[s.module], (payload) => this._onHostEvent(s.event, payload, s.method));
            this._sdkHandlerIds[s.method] = id === undefined ? true : id;
        } catch (e) {
            this._log(`Could not register ${s.method}: ${errorText(e)}`);
        }
    }

    _removeSdkHandler(method) {
        const id = this._sdkHandlerIds[method];
        delete this._sdkHandlerIds[method];
        const remove = this._sdk?.utility?.removeEventHandlerById;
        if (typeof remove === 'function' && id !== undefined && id !== true) {
            try {
                remove.call(this._sdk.utility, id);
                return 'removeEventHandlerById';
            } catch (e) {
                this._log(`removeEventHandlerById failed: ${errorText(e)}`);
            }
        }
        return 'ignored';
    }

    _subscribeLms() {
        if (this._subs.length) return;
        Promise.resolve().then(() => {
            if (this._subs.length) return;
            if (!this.messageContext) {
                setTimeout(() => this._subscribeLms(), 200);
                return;
            }
            const opts = { scope: APPLICATION_SCOPE };
            this._subs.push(subscribe(this.messageContext, HOST_RESPONSE, (m) => this._onHostResponse(m), opts));
            this._subs.push(subscribe(this.messageContext, HOST_EVENT, (m) => this._onLmsHostEvent(m), opts));
            this._subs.push(subscribe(this.messageContext, COMMAND, (m) => this._onCommand(m), opts));
        });
    }

    _subscribePlatformEvent() {
        if (!this._empErrorHooked) {
            this._empErrorHooked = true;
            empOnError((e) => {
                this._log(`Streaming error: ${JSON.stringify(e)}`);
                clearTimeout(this._empRetry);
                // eslint-disable-next-line @lwc/lwc/no-async-operation
                this._empRetry = setTimeout(() => {
                    if (this._empSub) empUnsubscribe(this._empSub, () => {});
                    this._empSub = null;
                    this._subscribePlatformEvent();
                }, 5000);
            });
        }
        empSubscribe(PLATFORM_EVENT, -1, (msg) => this._onPlatformEvent(msg?.data?.payload))
            .then((sub) => {
                this._empSub = sub;
            })
            .catch((e) => this._log(`Could not subscribe to ${PLATFORM_EVENT}: ${errorText(e)}`));
    }

    _onHostResponse(msg) {
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

    _onLmsHostEvent(msg) {
        if (!msg) return;
        if (this.instanceId && msg.instanceId && msg.instanceId !== this.instanceId) return;
        if (this._sdk && SDK_COVERED_EVENTS.has(msg.eventName)) return;
        let payload;
        try {
            payload = msg.payloadJson ? JSON.parse(msg.payloadJson) : {};
        } catch (e) {
            payload = msg.payloadJson;
        }
        this._onHostEvent(msg.eventName, payload, msg.eventName);
    }

    _host(operation, name, params) {
        if (!this.messageContext) return Promise.reject(new Error('Lightning Message Service is not ready'));
        const requestId = uid();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(requestId);
                reject(new Error(`The workspace did not answer ${operation}:${name} within ${HOST_TIMEOUT_MS / 1000}s.`));
            }, HOST_TIMEOUT_MS);
            this._pending.set(requestId, { resolve, reject, timer });
            publish(this.messageContext, HOST_REQUEST, {
                requestId,
                targetInstanceId: this.instanceId,
                operation,
                name,
                paramsJson: JSON.stringify(params || {})
            });
        });
    }

    /** Prefer the Embed SDK method when it exists; otherwise use the host API request. */
    _call(sdkFn, hostOp, hostName, hostParams) {
        if (this._sdk && sdkFn) {
            try {
                const r = sdkFn(this._sdk);
                if (r !== undefined) {
                    let timer;
                    const timeout = new Promise((resolve, reject) => {
                        timer = setTimeout(() => reject(new Error(`Embed SDK ${hostName || 'call'} timed out`)), SDK_TIMEOUT_MS);
                    });
                    const sdkResult = Promise.race([Promise.resolve(r), timeout]).finally(() => clearTimeout(timer));
                    if (!hostOp) return sdkResult;
                    return sdkResult.catch((e) => {
                        this._log(`${errorText(e)}; using the host API.`);
                        return this._host(hostOp, hostName, hostParams);
                    });
                }
            } catch (e) {
                if (!hostOp) return Promise.reject(e);
            }
        }
        if (!hostOp) return Promise.reject(new Error('Not available'));
        return this._host(hostOp, hostName, hostParams);
    }

    // ---------------------------------------------------------------- SDK operations

    getPresence() {
        return this._call((s) => s.presence?.getPresence?.(), 'query', 'getAgentState', {}).then((d) => d?.presence ?? d);
    }

    getPresenceOptions() {
        return this._call((s) => s.presence?.getPresenceOptions?.(), 'query', 'getPresenceOptions', {}).then((d) => {
            const arr = Array.isArray(d) ? d : d?.options || d?.presenceOptions || [];
            return arr
                .map((o) => ({
                    id: o.id || o.presenceId || o.value,
                    label: o.text || o.name || o.label || o.presenceText || o.id,
                    color: o.color || ''
                }))
                .filter((o) => o.id);
        });
    }

    setPresence(presenceId) {
        return this._call((s) => s.presence?.setPresence?.(presenceId), 'command', 'setPresence', { status: presenceId });
    }

    async getAssignedConversations() {
        const d = await this._call((s) => s.conversation?.getAssignedConversationsList?.(2), 'query', 'getActiveConversations', {});
        return d;
    }

    async getFocusedConversationId() {
        try {
            const d = await this._call((s) => s.conversation?.getFocusedConversationId?.(), 'query', 'getActiveConversations', {});
            const id = typeof d === 'string' ? d : d?.currentConversationId;
            if (id) this._focusedConversationId = id;
        } catch (e) {
            this._log(`getFocusedConversationId: ${errorText(e)}`);
        }
        return this._focusedConversationId;
    }

    getConversationData(conversationId, liveWorkItemId) {
        return this._call((s) => s.conversation?.getConversationData?.(conversationId), 'query', 'getConversationData', {
            conversationId,
            liveWorkItemId
        });
    }

    getTranscript(conversationId, liveWorkItemId) {
        return this._call((s) => s.conversation?.getTranscript?.(conversationId), 'query', 'getConversationTranscript', {
            conversationId,
            liveWorkItemId
        });
    }

    getCopilotSummary(conversationId, liveWorkItemId) {
        const sdkFn = this._sdk?.conversation?.getCopilotSummary ? (s) => s.conversation.getCopilotSummary(liveWorkItemId || conversationId) : null;
        return this._call(sdkFn, 'query', 'getCopilotSummary', { conversationId, liveWorkItemId });
    }

    getHistory(contactName, phone) {
        const esc = (v) => String(v).replace(/'/g, "''");
        const terms = [contactName, phone].filter(Boolean).map((v) => `startswith(subject,'${esc(v)}')`);
        const customerOptions =
            '?$select=subject,statuscode,msdyn_channel,createdon&$top=5&$orderby=createdon desc' +
            (terms.length ? `&$filter=${encodeURIComponent(terms.join(' or '))}` : '');
        const viaFetch = this._call(
            (s) => s.dataverse?.retrieveMultipleRecords?.('msdyn_ocliveworkitems', customerOptions),
            'query',
            'retrieveMultipleRecords',
            { entityLogicalName: 'msdyn_ocliveworkitems', options: customerOptions }
        );
        return viaFetch.then((v) => ({ customer: this._rows(v) }));
    }

    _rows(d) {
        const arr = Array.isArray(d) ? d : d?.entities || d?.value || [];
        const STATUS = { 1: 'Open', 2: 'Active', 3: 'Waiting', 4: 'Closed', 5: 'Wrap-up' };
        const CHANNEL = { 192350000: 'Entity records', 192390000: 'Voice', 192440000: 'Voice', 192360000: 'Live chat', 192370000: 'SMS' };
        return arr.map((r) => ({
            id: r.activityid || r.msdyn_ocliveworkitemid || uid(),
            subject: r.subject || '(no subject)',
            status: r['statuscode@OData.Community.Display.V1.FormattedValue'] || STATUS[r.statuscode] || String(r.statuscode ?? ''),
            channel: r['msdyn_channel@OData.Community.Display.V1.FormattedValue'] || CHANNEL[r.msdyn_channel] || '',
            createdOn: r.createdon || '',
            customer: r['c.fullname'] || r.contactname || String(r.subject || '').split(/\s*[:|]\s*/)[0] || ''
        }));
    }

    addNotification(message, level = LEVELS.info) {
        return this._call((s) => s.notification?.addNewNotification?.({ level, message }), 'command', 'addNotification', { level, message });
    }

    _callCommand(name, conversationId) {
        return this._host('command', name, { conversationId });
    }

    // ---------------------------------------------------------------- commands from Salesforce (LMS)

    async _onCommand(msg) {
        if (!msg?.requestId) return;
        let payload = {};
        try {
            payload = msg.payload ? JSON.parse(msg.payload) : {};
        } catch (e) {
            payload = {};
        }
        let result;
        try {
            const data = await this._execute(msg.operation, payload);
            result = { requestId: msg.requestId, operation: msg.operation, success: true, data: JSON.stringify(data ?? null) };
        } catch (e) {
            result = { requestId: msg.requestId, operation: msg.operation, success: false, error: errorText(e) };
        }
        publish(this.messageContext, RESULT, result);
    }

    async _execute(operation, p) {
        this._log(`command ${operation}`);
        try {
            const r = await this._run(operation, p);
            this._log(`command ${operation} ok ${JSON.stringify(r ?? null).slice(0, 300)}`);
            return r;
        } catch (e) {
            this._log(`command ${operation} failed: ${errorText(e)}`);
            throw e;
        }
    }

    async _run(operation, p) {
        switch (operation) {
            case 'getStatusPanel':
                return this._statusPanel();
            case 'setPresence':
                await this.setPresence(p.presenceId);
                return { presence: await this.getPresence().catch(() => null) };
            case 'setNotificationMirroring':
                return this._setMirroring(p.enabled !== false);
            case 'getState':
                return this._publicState(p.contactId);
            case 'addNotification': {
                await this.addNotification(p.message, p.level ?? LEVELS.info);
                return { sent: true };
            }
            case 'shareWithWorkspace':
                return this._shareWithWorkspace(p.recordId, p.objectApiName);
            case 'toggleHold':
                return this._toggleCall(p.contactId, 'held', 'holdCall', 'resumeCall');
            case 'toggleMute':
                return this._toggleCall(p.contactId, 'muted', 'muteCall', 'unmuteCall');
            case 'setNotes': {
                const conv = await this._activeFor(p.contactId);
                await this._host('command', 'setNotes', { conversationId: conv.conversationId, notes: p.notes });
                return { sent: true };
            }
            case 'getHistory':
                return this.getHistory(p.contactName, p.phone);
            default:
                throw new Error(`Unsupported operation ${operation}`);
        }
    }

    async _statusPanel() {
        const [presence, options, capabilities, queues] = await Promise.allSettled([
            this.getPresence(),
            this.getPresenceOptions(),
            this._host('query', 'getAgentCapabilities', {}),
            this._host('query', 'getAvailableQueues', {})
        ]);
        const val = (r) => (r.status === 'fulfilled' ? r.value : null);
        const q = val(queues);
        const all = Array.isArray(q?.queues) ? q.queues : Array.isArray(q) ? q : [];
        const featured = all.filter((x) => /contoso/i.test(x.name || ''));
        return {
            presence: val(presence),
            options: val(options) || [],
            capabilities: val(capabilities),
            queues: (featured.length ? featured : all.slice(0, 5)).map((x) => ({
                name: x.name,
                type: String(x.queuetype ?? '').endsWith('2') ? 'Voice' : 'Messaging'
            })),
            totalQueues: all.length,
            mirrorNotifications: this._mirrorNotifications,
            sdk: !!this._sdk
        };
    }

    _setMirroring(enabled) {
        this._mirrorNotifications = enabled;
        let how = 'ignored';
        if (this._sdk) {
            const sub = SDK_SUBSCRIPTIONS.find((s) => s.method === 'onNewNotification');
            if (enabled && this._sdkHandlerIds.onNewNotification === undefined) {
                this._addSdkHandler(sub);
                how = 'registered';
            } else if (!enabled) {
                how = this._removeSdkHandler('onNewNotification');
            }
        }
        return { mirrorNotifications: enabled, handler: how };
    }

    _publicState(contactId) {
        const c = contactId ? this._findByContact(contactId) : this._focused();
        return {
            sdk: !!this._sdk,
            active: !!c,
            conversationId: c?.conversationId || null,
            channel: c?.channel || null,
            held: !!c?.held,
            muted: !!c?.muted,
            taskId: c?.taskId || null
        };
    }

    async _shareWithWorkspace(recordId, objectApiName) {
        const conv = await this._activeFor(objectApiName === 'Contact' ? recordId : undefined);
        const entityType = (objectApiName || 'contact').toLowerCase();
        await this._host('command', 'updateCustomerContext', {
            conversationId: conv.conversationId,
            entityType,
            entityId: recordId
        });
        return { shared: true, conversationId: conv.conversationId, entityType };
    }

    async _toggleCall(contactId, flag, onCmd, offCmd) {
        const conv = await this._activeFor(contactId);
        if (conv.channel !== 'Voice') throw new Error('The active conversation is not a call.');
        const next = !conv[flag];
        await this._callCommand(next ? onCmd : offCmd, conv.conversationId);
        this._applyCallFlag(conv, flag, next);
        return { [flag]: next };
    }

    async _activeFor(contactId) {
        await this.getFocusedConversationId();
        const conv = (contactId && this._findByContact(contactId)) || this._focused();
        if (!conv) throw new Error('There is no active contact center conversation.');
        return conv;
    }

    _findByContact(contactId) {
        const id15 = String(contactId).slice(0, 15);
        for (const c of this._conversations.values()) {
            if (c.contactId && String(c.contactId).slice(0, 15) === id15 && !c.completed) return c;
        }
        return undefined;
    }

    _focused() {
        const f = this._conversations.get(this._focusedConversationId);
        if (f && !f.completed) return f;
        return [...this._conversations.values()].reverse().find((c) => !c.completed);
    }

    // ---------------------------------------------------------------- automation from Salesforce (platform event)

    async _onPlatformEvent(e) {
        if (!e) return;
        this._log(`platform event ${e.Operation__c} contact=${e.Contact_Id__c || ''} conv=${e.Conversation_Id__c || ''}`);
        if (e.Requested_By__c && String(e.Requested_By__c).slice(0, 15) !== String(USER_ID).slice(0, 15)) return;
        const conv = this._conversations.get(e.Conversation_Id__c) || (e.Contact_Id__c && this._findByContact(e.Contact_Id__c));
        if (!conv) {
            this._log('platform event ignored: no matching conversation');
            return;
        }
        let p = {};
        try {
            p = e.Payload__c ? JSON.parse(e.Payload__c) : {};
        } catch (err) {
            p = {};
        }
        try {
            if (e.Operation__c === 'addNotification') {
                await this.addNotification(p.message, p.level ?? LEVELS.warning);
                this._toast('Sent to the contact center workspace', p.message, 'info');
            } else if (e.Operation__c === 'setNotes') {
                await this._host('command', 'setNotes', { conversationId: conv.conversationId, notes: p.notes });
                this._toast('Notes synced to the workspace', p.notes, 'success');
            }
        } catch (err) {
            this._toast(`Could not run ${e.Operation__c}`, errorText(err), 'error');
        }
    }

    // ---------------------------------------------------------------- events from the workspace

    _onHostEvent(name, payload, source) {
        this._log(`event ${name} (${source})`, payload);
        const convId = str(payload, 'conversationId');
        if (convId) this._focusedConversationId = convId;
        switch (name) {
            case 'conversation.invited':
                this._onInvited(payload);
                break;
            case 'conversation.started':
            case 'conversation.loaded':
                this._onAccepted(payload);
                break;
            case 'conversation.rejected':
                this._toast('Conversation declined', 'The offer was declined in the workspace.', 'warning');
                break;
            case 'conversation.transferred':
                this._noteFor(payload, 'Conversation transferred in the workspace.');
                break;
            case 'conversation.stateChanged':
                this._onStateChanged(payload);
                break;
            case 'conversation.messageReceived':
                this._onMessage(payload);
                break;
            case 'conversation.sentimentChanged':
                this._onSentiment(payload);
                break;
            case 'conversation.notesAdded':
                this._noteFor(payload, `Workspace note: ${str(payload, 'notes', 'note', 'text', 'content') || '(added)'}`);
                break;
            case 'conversation.consultStarted':
                this._noteFor(payload, 'Consult started in the workspace.');
                break;
            case 'conversation.consultEnded':
                this._noteFor(payload, 'Consult ended in the workspace.');
                break;
            case 'presence.changed': {
                const label = str(payload, 'presenceText', 'text', 'name', 'label', 'status') || 'updated';
                this._toast('Contact center status', `Your status is now ${label}.`, 'info');
                break;
            }
            case 'notification.received':
                if (this._mirrorNotifications) {
                    const text = str(payload, 'message', 'title', 'text') || 'New notification';
                    this._toast('Contact center workspace', text, 'info');
                }
                break;
            case 'call.hold':
                this._onCallFlag(payload, 'held', this._bool(payload, /hold/i));
                break;
            case 'call.held':
            case 'call.resumed':
                this._onCallFlag(payload, 'held', name === 'call.held');
                break;
            case 'call.mute':
                this._onCallFlag(payload, 'muted', this._bool(payload, /mute/i));
                break;
            case 'call.muted':
            case 'call.unmuted':
                this._onCallFlag(payload, 'muted', name === 'call.muted');
                break;
            default:
                break;
        }
    }

    _bool(payload, re) {
        const v = findDeep(payload, (k, val) => re.test(k) && typeof val === 'boolean');
        if (typeof v === 'boolean') return v;
        return payload === true;
    }

    async _onInvited(payload) {
        const key = str(payload, 'conversationId', 'liveWorkItemId') || uid();
        if (this._invitesShown.has(key)) return;
        this._invitesShown.add(key);
        const phone = phoneOf(payload);
        const name = str(payload, 'customerName', 'customerDisplayName', 'contactName', 'displayName');
        const voice = !!phone || /voice|call|phone/i.test(JSON.stringify(payload || {}));
        let who = name || 'a customer';
        try {
            const match = phone || name ? await findCaller({ phone, name }) : null;
            if (match) who = match.name;
        } catch (e) {
            // lookup errors don't block the toast
        }
        this._toast(voice ? `Incoming call from ${who}` : `Incoming chat from ${who}`, 'Accept the conversation in the contact center workspace.', 'info');
    }

    async _onAccepted(payload) {
        const rawId = str(payload, 'conversationId', 'liveWorkItemId');
        const conversationId = rawId && !GUID_RE.test(rawId) ? rawId : (await this.getFocusedConversationId()) || rawId;
        this._log(`accepted ${conversationId}`);
        if (!conversationId) return;
        let conv = this._conversations.get(conversationId);
        if (conv) {
            conv.payload = { ...conv.payload, ...payload };
            const liveWorkItemId = str(payload, 'liveWorkItemId');
            if (GUID_RE.test(liveWorkItemId || '')) conv.liveWorkItemId = liveWorkItemId;
            if (phoneOf(payload) || /voice|phone|call/i.test(str(payload, 'conversationType', 'channel', 'channelType') || '')) conv.channel = 'Voice';
            if (!conv.contactId && !conv.starting) {
                conv.starting = true;
                try {
                    await this._identify(conv, conv.payload);
                } finally {
                    conv.starting = false;
                }
            }
            return;
        }
        conv = { conversationId, payload: { ...payload }, starting: true, held: false, muted: false, channel: phoneOf(payload) ? 'Voice' : '' };
        this._conversations.set(conversationId, conv);
        this._focusedConversationId = conversationId;
        try {
            await this._enrich(conv, payload);
            await this._identify(conv, conv.payload);
        } finally {
            conv.starting = false;
        }
    }

    async _enrich(conv, payload) {
        // getAssignedConversationsList gives the live work item GUID used for Dataverse and Copilot summary.
        try {
            const list = await this.getAssignedConversations();
            const items = Array.isArray(list) ? list : list?.conversations;
            const assigned = Array.isArray(items)
                ? items.find((item) => str(item, 'conversationId', 'id') === conv.conversationId)
                : list;
            const lwi = str(assigned, 'liveWorkItemId');
            if (GUID_RE.test(lwi || '')) conv.liveWorkItemId = lwi;
        } catch (e) {
            this._log(`getAssignedConversationsList: ${errorText(e)}`);
        }
        const fromPayload = str(payload, 'liveWorkItemId');
        if (!conv.liveWorkItemId && GUID_RE.test(fromPayload || '')) conv.liveWorkItemId = fromPayload;

        try {
            conv.data = await this.getConversationData(conv.conversationId, conv.liveWorkItemId);
        } catch (e) {
            this._log(`getConversationData: ${errorText(e)}`);
        }
        const text = JSON.stringify(conv.data || payload || {});
        const channelName = str(conv.data, 'msdyn_channel@OData.Community.Display.V1.FormattedValue', 'channel', 'channelType') || '';
        if (!conv.channel) conv.channel = /voice|phone|call/i.test(channelName) || /"msdyn_channel":"?192(39|44)0000"?/.test(text) ? 'Voice' : 'Chat';
        conv.queue =
            str(conv.data, '_msdyn_cdsqueueid_value@OData.Community.Display.V1.FormattedValue', 'queueName', 'queue') || '';

        if (conv.liveWorkItemId) {
            try {
                const rec = await this._call(
                    (s) => s.dataverse?.retrieveRecord?.('msdyn_ocliveworkitems', conv.liveWorkItemId, '?$select=subject,statuscode,_msdyn_customer_value'),
                    'query',
                    'retrieveRecord',
                    { entityLogicalName: 'msdyn_ocliveworkitems', id: conv.liveWorkItemId, options: '?$select=subject,statuscode,_msdyn_customer_value' }
                );
                conv.subject = rec?.subject;
                conv.record = rec;
                this._log(`enrich data=${JSON.stringify(conv.data || null).slice(0, 400)} rec=${JSON.stringify(rec || null).slice(0, 300)}`);
            } catch (e) {
                this._log(`retrieveRecord: ${errorText(e)}`);
            }
        }
        try {
            const sla = await this._host('query', 'getSlaStatus', { conversationId: conv.conversationId });
            const timers = Array.isArray(sla?.timers) ? sla.timers : [];
            conv.sla = timers.length ? timers.map((t) => `${t.name || 'SLA'}: ${t.status || t.state || ''}`.trim()).join('; ') : 'No SLA timers';
        } catch (e) {
            conv.sla = '';
            this._log(`getSlaStatus: ${errorText(e)}`);
        }
    }

    async _identify(conv, payload) {
        const phone = phoneOf(payload) || phoneOf(conv.data);
        const name =
            str(payload, 'customerName', 'customerDisplayName', 'contactName') ||
            str(conv.data, '_msdyn_customer_value@OData.Community.Display.V1.FormattedValue', 'customerName') ||
            str(conv.record, '_msdyn_customer_value@OData.Community.Display.V1.FormattedValue') ||
            (conv.subject && /^(.+?)\s*[:|-]/.test(conv.subject) ? conv.subject.match(/^(.+?)\s*[:|-]/)[1] : '');
        if (phone && !conv.channel) conv.channel = 'Voice';
        let match;
        try {
            match = await findCaller({ phone, name });
        } catch (e) {
            this._log(`findCaller: ${errorText(e)}`);
        }
        this._log(`identify phone=${phone ? 'yes' : 'no'} name=${name ? 'yes' : 'no'} match=${match ? match.contactId : 'none'} channel=${conv.channel} queue=${conv.queue}`);
        if (!match) {
            if (!conv.unmatchedToast) {
                conv.unmatchedToast = true;
                this._toast('Conversation accepted', 'No Salesforce contact matches this customer yet.', 'warning');
            }
            return;
        }
        conv.contactId = match.contactId;
        conv.contactName = match.name;
        try {
            const interaction = await startInteraction({
                contactId: match.contactId,
                conversationId: conv.conversationId,
                liveWorkItemId: conv.liveWorkItemId || null,
                channel: conv.channel || 'Chat',
                queueName: conv.queue || null
            });
            conv.taskId = interaction.taskId;
            conv.caseId = interaction.caseId;
            const changes = {};
            if (conv.sla) changes.slaStatus = conv.sla;
            if (conv.subject) changes.note = `Workspace subject: ${conv.subject}`;
            if (Object.keys(changes).length) await updateInteraction({ taskId: conv.taskId, changes });
        } catch (e) {
            this._toast('Could not log the interaction', errorText(e), 'error');
        }
        try {
            await this._host('command', 'updateCustomerContext', {
                conversationId: conv.conversationId,
                entityType: 'contact',
                entityId: match.contactId
            });
        } catch (e) {
            this._log(`updateCustomerContext: ${errorText(e)}`);
        }
        const kind = conv.channel === 'Voice' ? 'Call' : 'Chat';
        this._toast(`${kind} with ${match.name}`, `${match.accountName ? match.accountName + ' · ' : ''}Interaction logged on the contact.`, 'success');
        this._refresh(match.contactId);
        this._screenPop(conv, match.contactId, conv.caseId);
    }

    _screenPop(conv, contactId, caseId) {
        if (!this.autoScreenPop || !contactId) return;
        // Pop once per conversation per browser tab. Lightning keeps the previous record page
        // (and its live workspace iframe) cached, so the bridge on the newly opened page must
        // not pop again when the agent later moves to another record.
        const key = `ccBridge.popped.${conv.conversationId}`;
        try {
            if (window.sessionStorage.getItem(key)) return;
            window.sessionStorage.setItem(key, contactId);
        } catch (e) {
            if (conv.popped) return;
        }
        conv.popped = true;
        if (!this.isUtility && this.recordId === contactId) return;
        this._log(`screen pop ${contactId}`);
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId: contactId, objectApiName: 'Contact', actionName: 'view' }
        });
        if (caseId) {
            this._log(`screen pop case ${caseId}`);
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: { recordId: caseId, objectApiName: 'Case', actionName: 'view' }
            });
        }
    }

    _convFor(payload) {
        const ids = [str(payload, 'conversationId'), str(payload, 'liveWorkItemId')].filter(Boolean);
        for (const id of ids) {
            if (this._conversations.has(id)) return this._conversations.get(id);
            for (const c of this._conversations.values()) if (c.liveWorkItemId === id) return c;
        }
        return this._focused();
    }

    _status(payload) {
        const v = findDeep(payload, (k, val) => /^(newStatus|status|state|conversationStatus|statusCode|newState)$/i.test(k) && (typeof val === 'number' || typeof val === 'string'));
        const s = String(v ?? '').toLowerCase();
        if (s === '5' || s.includes('wrap')) return 'wrapup';
        if (s === '4' || s.includes('close') || s.includes('end')) return 'closed';
        if (s === '2' || s === 'active') return 'active';
        return s;
    }

    async _onStateChanged(payload) {
        const state = this._status(payload);
        let conv = this._convFor(payload);
        if (!conv && state === 'active') {
            await this._onAccepted(payload);
            return;
        }
        if (!conv || conv.completed) return;
        if (state === 'wrapup' || state === 'closed') await this._complete(conv);
        else await this._verifyEnded(conv);
    }

    // onStatusChange can report a stale code when a conversation ends; confirm with the live work item,
    // which can take several seconds to move to wrap-up.
    async _verifyEnded(conv, attempts = 1) {
        if (!conv?.liveWorkItemId || conv.completed || conv.completing || conv.verifying) return;
        conv.verifying = true;
        try {
            const opts = '?$select=statuscode';
            for (let i = 0; i < attempts; i++) {
                if (i) await new Promise((r) => setTimeout(r, 4000)); // eslint-disable-line @lwc/lwc/no-async-operation
                try {
                    const rec = await this._call(
                        (s) => s.dataverse?.retrieveRecord?.('msdyn_ocliveworkitems', conv.liveWorkItemId, opts),
                        'query',
                        'retrieveRecord',
                        { entityLogicalName: 'msdyn_ocliveworkitems', id: conv.liveWorkItemId, options: opts }
                    );
                    const code = Number(rec?.statuscode);
                    this._log(`verify ended statuscode=${code}`);
                    if (code === 4 || code === 5) {
                        conv.verifying = false;
                        await this._complete(conv);
                        return;
                    }
                } catch (e) {
                    this._log(`verify ended: ${errorText(e)}`);
                }
            }
        } finally {
            conv.verifying = false;
        }
    }

    async _complete(conv) {
        if (conv.completing || conv.completed) return;
        conv.completing = true;
        let transcript = '';
        let summary = '';
        try {
            const t = await this.getTranscript(conv.conversationId, conv.liveWorkItemId);
            transcript = this._transcriptText(t);
        } catch (e) {
            this._log(`getTranscript: ${errorText(e)}`);
        }
        for (let attempt = 0; attempt < 3 && !summary; attempt++) {
            try {
                const s = await this.getCopilotSummary(conv.conversationId, conv.liveWorkItemId);
                summary = typeof s === 'string' ? s : s?.summary || '';
            } catch (e) {
                this._log(`getCopilotSummary: ${errorText(e)}`);
                await new Promise((r) => setTimeout(r, 4000)); // summary may lag the wrap-up state
            }
        }
        try {
            if (conv.taskId) {
                await completeInteraction({ taskId: conv.taskId, transcript, summary });
                this._toast('Interaction completed', summary ? 'Copilot summary and transcript saved to the activity.' : 'Transcript saved to the activity.', 'success');
                this._refresh(conv.contactId);
            }
            conv.completed = true;
        } catch (e) {
            this._toast('Could not complete the interaction', errorText(e), 'error');
        } finally {
            conv.completing = false;
        }
    }

    _transcriptText(t) {
        if (!t) return '';
        if (typeof t === 'string') return t;
        const msgs = Array.isArray(t) ? t : t.messages || t.transcript || t.value || [];
        if (!Array.isArray(msgs) || !msgs.length) return JSON.stringify(t).slice(0, 20000);
        const nameOf = (v) => (typeof v === 'string' ? v : v && (v.displayName || v.name || v.user?.displayName || v.application?.displayName));
        return msgs
            .map((m) => {
                const who =
                    nameOf(m.from) || nameOf(m.sender) || m.senderDisplayName || m.displayName || m.role ||
                    ({ 1: 'Agent', 2: 'Customer', 3: 'Bot', 4: 'System' }[m.senderType]) || '';
                const text = m.content || m.text || m.message || m.body || '';
                const clean = String(typeof text === 'object' ? text.content || JSON.stringify(text) : text).replace(/<[^>]+>/g, '');
                return `${typeof who === 'string' ? (who === '__system__' ? 'System' : who) : 'Participant'}: ${clean}`;
            })
            .join('\n');
    }

    _onMessage(payload) {
        const conv = this._convFor(payload);
        if (!conv) return;
        conv.messages = (conv.messages || 0) + 1;
        if (/ended the conversation/i.test(str(payload, 'content') || '')) {
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            setTimeout(() => this._verifyEnded(conv, 15), 3000);
        }
    }

    async _onSentiment(payload) {
        const conv = this._convFor(payload);
        if (!conv?.taskId) return;
        const raw = findDeep(payload, (k, v) => /sentiment/i.test(k) && (typeof v === 'string' || typeof v === 'number'));
        if (raw === undefined || raw === conv.sentiment) return;
        conv.sentiment = raw;
        try {
            await updateInteraction({ taskId: conv.taskId, changes: { sentiment: String(raw) } });
            this._refresh(conv.contactId);
        } catch (e) {
            this._log(`updateInteraction sentiment: ${errorText(e)}`);
        }
    }

    async _noteFor(payload, note) {
        const conv = this._convFor(payload);
        if (!conv?.taskId) return;
        try {
            await updateInteraction({ taskId: conv.taskId, changes: { note } });
            this._refresh(conv.contactId);
        } catch (e) {
            this._log(`updateInteraction note: ${errorText(e)}`);
        }
    }

    _onCallFlag(payload, flag, value) {
        const conv = this._convFor(payload);
        if (!conv) return;
        this._applyCallFlag(conv, flag, value);
    }

    async _applyCallFlag(conv, flag, value) {
        const changed = conv[flag] !== value;
        conv[flag] = value;
        if (!changed || !conv.taskId) return;
        try {
            await updateInteraction({ taskId: conv.taskId, changes: { [flag]: value } });
            this._refresh(conv.contactId);
        } catch (e) {
            this._log(`updateInteraction ${flag}: ${errorText(e)}`);
        }
    }

    // ---------------------------------------------------------------- helpers

    _refresh(contactId) {
        if (contactId) notifyRecordUpdateAvailable([{ recordId: contactId }]).catch(() => {});
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message: message || '', variant: variant || 'info' }));
    }

    _log(text, payload) {
        // eslint-disable-next-line no-console
        console.log(`[ccBridge:${this.instanceId || this.placement}] ${text}`, payload === undefined ? '' : JSON.stringify(payload).slice(0, 1500));
    }
}
