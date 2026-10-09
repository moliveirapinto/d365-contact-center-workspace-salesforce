import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { sendCommand, errorText } from 'c/ccClient';

export default class CcMuteCall extends LightningElement {
    @api recordId;
    @api objectApiName;

    @api async invoke() {
        try {
            const data = await sendCommand('toggleMute', { contactId: this.recordId });
            this._toast(data && data.muted ? 'Microphone muted' : 'Microphone unmuted', data && data.muted ? 'The customer cannot hear you.' : 'The customer can hear you again.', 'success');
        } catch (e) {
            this._toast('Mute or unmute call', errorText(e), 'error');
        }
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
