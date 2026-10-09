import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { sendCommand, errorText } from 'c/ccClient';

export default class CcHoldCall extends LightningElement {
    @api recordId;
    @api objectApiName;

    @api async invoke() {
        try {
            const data = await sendCommand('toggleHold', { contactId: this.recordId });
            this._toast(data && data.held ? 'Call on hold' : 'Call resumed', data && data.held ? 'The customer is on hold in the workspace.' : 'The customer is back on the line.', 'success');
        } catch (e) {
            this._toast('Hold or resume call', errorText(e), 'error');
        }
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
