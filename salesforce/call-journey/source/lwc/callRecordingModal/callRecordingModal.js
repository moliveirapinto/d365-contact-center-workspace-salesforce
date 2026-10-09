import { api } from 'lwc';
import LightningModal from 'lightning/modal';

export default class CallRecordingModal extends LightningModal {
    @api url;
    @api label = 'Call recording & transcript';
    @api subtitle = 'Dynamics 365 Contact Center';
    loading = true;

    handleLoad() {
        this.loading = false;
    }

    handleClose() {
        this.close();
    }
}