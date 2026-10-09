import { createMessageContext, releaseMessageContext, publish, subscribe, unsubscribe, APPLICATION_SCOPE } from 'lightning/messageService';
import COMMAND from '@salesforce/messageChannel/ContactCenterCommand__c';
import RESULT from '@salesforce/messageChannel/ContactCenterResult__c';

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Sends a command to the Contact Center Automation bridge on the same page and waits for its result.
 * Works from headless quick actions and Flow screen components (no wired MessageContext needed).
 */
export function sendCommand(operation, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const context = createMessageContext();
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
        let sub;
        let timer;
        const done = (fn, value) => {
            clearTimeout(timer);
            if (sub) unsubscribe(sub);
            releaseMessageContext(context);
            fn(value);
        };
        timer = setTimeout(
            () => done(reject, new Error('The contact center workspace did not respond. Make sure the workspace is open and signed in.')),
            timeoutMs
        );
        sub = subscribe(
            context,
            RESULT,
            (msg) => {
                if (!msg || msg.requestId !== requestId) return;
                if (msg.success) {
                    let data = null;
                    try {
                        data = msg.data ? JSON.parse(msg.data) : null;
                    } catch (e) {
                        data = msg.data;
                    }
                    done(resolve, data);
                } else {
                    done(reject, new Error(msg.error || 'The request failed.'));
                }
            },
            { scope: APPLICATION_SCOPE }
        );
        publish(context, COMMAND, { requestId, operation, payload: JSON.stringify(payload || {}) });
    });
}

export function errorText(e) {
    return (e && (e.body?.message || e.message)) || String(e);
}
