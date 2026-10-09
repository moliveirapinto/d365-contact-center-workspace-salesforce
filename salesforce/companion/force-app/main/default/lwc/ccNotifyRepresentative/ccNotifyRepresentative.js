import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { sendCommand, errorText } from 'c/ccClient';

export default class CcNotifyRepresentative extends LightningElement {
    @api recordId;
    @api objectApiName;

    @api async invoke() {
        try {
            const data = await sendCommand('addNotification', { level: 2, message: this.objectApiName === 'Case' ? 'Salesforce: this case needs priority attention. Review it before you close the conversation.' : 'Salesforce: priority customer. Review open cases before you close the conversation.' });
            this._toast('Notification sent', 'The representative sees it in the contact center workspace.', 'success');
        } catch (e) {
            this._toast('Notify representative', errorText(e), 'error');
        }
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
