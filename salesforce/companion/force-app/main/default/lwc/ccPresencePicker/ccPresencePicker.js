import { LightningElement } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { sendCommand, errorText } from 'c/ccClient';

function describeCapabilities(c) {
    if (!c) return '';
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x.name || x.capability || JSON.stringify(x))).join(', ');
    if (typeof c === 'string') return c;
    const list = c.capabilities || c.channels || c.skills;
    if (Array.isArray(list)) return describeCapabilities(list);
    const on = Object.entries(c).filter(([, v]) => v === true).map(([k]) => k.replace(/^(can|is)/, '').replace(/([a-z])([A-Z])/g, '$1 $2'));
    if (on.length) return on.join(', ');
    return Object.entries(c)
        .filter(([, v]) => ['string', 'number'].includes(typeof v))
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
}

export default class CcPresencePicker extends LightningElement {
    loading = true;
    saving = false;
    error = '';
    current = '';
    selected = '';
    options = [];
    queues = [];
    totalQueues = 0;
    capabilities = '';
    mirror = true;

    connectedCallback() {
        this.load();
    }

    async load() {
        this.loading = true;
        this.error = '';
        try {
            const d = await sendCommand('getStatusPanel');
            this.options = (d.options || []).map((o) => ({ label: o.label, value: o.id }));
            const p = d.presence || {};
            const currentId = p.id || p.presenceId || '';
            this.current = p.text || p.presenceText || p.name || (this.options.find((o) => o.value === currentId) || {}).label || 'Unknown';
            this.selected = currentId || (this.options[0] && this.options[0].value) || '';
            this.queues = (d.queues || []).map((q, i) => ({ key: `q${i}`, ...q }));
            this.totalQueues = d.totalQueues || 0;
            this.capabilities = describeCapabilities(d.capabilities) || 'Not reported';
            this.mirror = d.mirrorNotifications !== false;
        } catch (e) {
            this.error = errorText(e);
        } finally {
            this.loading = false;
        }
    }

    get hasQueues() {
        return this.queues.length > 0;
    }

    get queueCaption() {
        return this.totalQueues > this.queues.length ? `Showing ${this.queues.length} of ${this.totalQueues} queues` : '';
    }

    get setDisabled() {
        return this.saving || !this.selected;
    }

    handlePick(event) {
        this.selected = event.detail.value;
    }

    async handleSet() {
        this.saving = true;
        try {
            const d = await sendCommand('setPresence', { presenceId: this.selected });
            const label = (this.options.find((o) => o.value === this.selected) || {}).label || 'updated';
            this.current = (d && d.presence && (d.presence.text || d.presence.presenceText)) || label;
            this.dispatchEvent(new ShowToastEvent({ title: 'Status updated', message: `Your contact center status is ${label}.`, variant: 'success' }));
        } catch (e) {
            this.dispatchEvent(new ShowToastEvent({ title: 'Could not set status', message: errorText(e), variant: 'error' }));
        } finally {
            this.saving = false;
        }
    }

    async handleMirror(event) {
        const enabled = event.target.checked;
        try {
            await sendCommand('setNotificationMirroring', { enabled });
            this.mirror = enabled;
            this.dispatchEvent(
                new ShowToastEvent({
                    title: enabled ? 'Notification mirroring on' : 'Notification mirroring off',
                    message: enabled ? 'Workspace notifications appear as Salesforce toasts.' : 'The workspace notification handler was removed.',
                    variant: 'info'
                })
            );
        } catch (e) {
            event.target.checked = !enabled;
            this.dispatchEvent(new ShowToastEvent({ title: 'Could not change mirroring', message: errorText(e), variant: 'error' }));
        }
    }
}
