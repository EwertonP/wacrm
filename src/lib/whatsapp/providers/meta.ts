import { WhatsAppProvider, SendMessagePayload } from './provider';
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  verifyPhoneNumber,
} from '../meta-api';

export class MetaProvider implements WhatsAppProvider {
  private phoneNumberId: string;
  private accessToken: string;
  private wabaId: string;

  constructor(settings: any) {
    this.phoneNumberId = settings.phone_number_id || '';
    this.accessToken = settings.access_token || '';
    this.wabaId = settings.waba_id || '';
  }

  async sendMessage(payload: SendMessagePayload): Promise<{ whatsappMessageId: string }> {
    const {
      to,
      messageType,
      contentText,
      mediaUrl,
      filename,
      templateName,
      templateLanguage,
      templateParams,
      templateMessageParams,
      interactivePayload,
    } = payload;

    const args = {
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to,
    };

    switch (messageType) {
      case 'text':
        const textResult = await sendTextMessage({
          ...args,
          text: contentText || '',
        });
        return { whatsappMessageId: textResult.messageId };

      case 'template':
        const templateResult = await sendTemplateMessage({
          ...args,
          templateName: templateName || '',
          language: templateLanguage || 'en_US',
          params: templateParams || [],
          messageParams: templateMessageParams as any,
        });
        return { whatsappMessageId: templateResult.messageId };

      case 'image':
      case 'video':
      case 'document':
      case 'audio':
        const mediaResult = await sendMediaMessage({
          ...args,
          link: mediaUrl || '',
          kind: messageType as any,
          filename: filename || undefined,
        });
        return { whatsappMessageId: mediaResult.messageId };

      case 'interactive':
        if (interactivePayload?.type === 'button') {
          const btnResult = await sendInteractiveButtons({
            ...args,
            bodyText: interactivePayload.bodyText,
            buttons: interactivePayload.buttons,
            headerText: interactivePayload.headerText,
            footerText: interactivePayload.footerText,
          });
          return { whatsappMessageId: btnResult.messageId };
        } else if (interactivePayload?.type === 'list') {
          const listResult = await sendInteractiveList({
            ...args,
            bodyText: interactivePayload.bodyText,
            buttonLabel: interactivePayload.buttonText || '',
            sections: interactivePayload.sections,
            headerText: interactivePayload.headerText,
            footerText: interactivePayload.footerText,
          });
          return { whatsappMessageId: listResult.messageId };
        }
        throw new Error(`Unsupported interactive payload type: ${interactivePayload?.type}`);

      default:
        throw new Error(`Unsupported message type: ${messageType}`);
    }
  }

  async verifyConnection(): Promise<{ connected: boolean; message?: string; rawInfo?: any }> {
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: this.phoneNumberId,
        accessToken: this.accessToken,
      });
      return { connected: true, rawInfo: phoneInfo };
    } catch (err) {
      return {
        connected: false,
        message: err instanceof Error ? err.message : 'Meta API connection failed',
      };
    }
  }
}
