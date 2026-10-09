import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { sendCommand, errorText } from 'c/ccClient';

export default class CcShareWithWorkspace extends LightningElement {
    @api recordId;
    @api objectApiName;

    @api async invoke() {
        try {
            const data = await sendCommand('shareWithWorkspace', { recordId: this.recordId, objectApiName: this.objectApiName });
            this._toast('Shared with workspace', 'The workspace now has this ' + (this.objectApiName || 'record').toLowerCase() + ' as customer context.', 'success');
        } catch (e) {
            this._toast('Share with workspace', errorText(e), 'error');
        }
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
