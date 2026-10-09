import { LightningElement, api } from 'lwc';
import { sendCommand, errorText } from 'c/ccClient';

const COLUMNS = [
    { label: 'Subject', fieldName: 'subject', wrapText: true },
    { label: 'Channel', fieldName: 'channel', initialWidth: 100 },
    { label: 'Status', fieldName: 'status', initialWidth: 100 },
    { label: 'Created', fieldName: 'createdOn', type: 'date', initialWidth: 170, typeAttributes: { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' } }
];

export default class CcConversationHistory extends LightningElement {
    @api contactName;
    @api phone;
    columns = COLUMNS;
    loading = true;
    error = '';
    customer = [];

    connectedCallback() {
        this.load();
    }

    async load() {
        this.loading = true;
        this.error = '';
        try {
            const d = await sendCommand('getHistory', { contactName: this.contactName || '', phone: this.phone || '' });
            const key = (r, i) => ({ ...r, key: r.id || `r${i}` });
            this.customer = (d.customer || []).map(key);
        } catch (e) {
            this.error = errorText(e);
        } finally {
            this.loading = false;
        }
    }

    get hasCustomer() {
        return this.customer.length > 0;
    }

    get customerTitle() {
        return `Conversations with ${this.contactName || 'this customer'}`;
    }
}
