import { WhatsAppProvider, SendMessagePayload } from './provider';

export class MegaApiProvider implements WhatsAppProvider {
  private instanceKey: string;
  private token: string;
  private host: string;

  constructor(settings: { instanceKey: string; token: string; host: string }) {
    this.instanceKey = settings.instanceKey;
    this.token = settings.token;
    this.host = settings.host || 'api2.megaapi.com.br';
  }

  private getUrl(endpoint: string): string {
    // Garantir que o host não comece com http/https
    const cleanHost = this.host.replace(/^https?:\/\//, '');
    return `https://${cleanHost}${endpoint}`;
  }

  async sendMessage(payload: SendMessagePayload): Promise<{ whatsappMessageId: string }> {
    const { to, messageType, contentText, mediaUrl, templateParams, templateBodyText } = payload;

    // MegaAPI espera formato: 55XXXXXXXXXXX@s.whatsapp.net
    const formattedTo = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };

    if (messageType === 'text') {
      const url = this.getUrl(`/rest/sendMessage/${this.instanceKey}/text`);
      const body = {
        messageData: {
          to: formattedTo,
          text: contentText || '',
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`MegaAPI error: ${response.status} - ${response.statusText}`);
      }

      const resData = await response.json();
      return { whatsappMessageId: resData.messageId || resData.id || `mega-${Date.now()}` };
    }

    if (messageType === 'template') {
      // Fallback: compila o template como texto puro e envia
      let text = templateBodyText || '';
      if (templateParams && templateParams.length > 0) {
        templateParams.forEach((param, index) => {
          text = text.replace(new RegExp(`\\{\\{${index + 1}\\}\\}`, 'g'), param);
        });
      }

      const url = this.getUrl(`/rest/sendMessage/${this.instanceKey}/text`);
      const body = {
        messageData: {
          to: formattedTo,
          text,
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`MegaAPI error: ${response.status} - ${response.statusText}`);
      }

      const resData = await response.json();
      return { whatsappMessageId: resData.messageId || resData.id || `mega-${Date.now()}` };
    }

    // Media (image, video, document, audio)
    if (['image', 'video', 'document', 'audio'].includes(messageType)) {
      const url = this.getUrl(`/rest/sendMessage/${this.instanceKey}/mediaUrl`);
      const body = {
        messageData: {
          to: formattedTo,
          url: mediaUrl || '',
          caption: contentText || '',
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`MegaAPI error: ${response.status} - ${response.statusText}`);
      }

      const resData = await response.json();
      return { whatsappMessageId: resData.messageId || resData.id || `mega-${Date.now()}` };
    }

    throw new Error(`Unsupported message type for MegaAPI: ${messageType}`);
  }

  async verifyConnection(): Promise<{ connected: boolean; message?: string; rawInfo?: any }> {
    const url = this.getUrl(`/rest/instance/${this.instanceKey}`);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!response.ok) {
        return {
          connected: false,
          message: `MegaAPI server returned status: ${response.status}`,
        };
      }

      const resData = await response.json();
      // O endpoint retorna { error: false, instance: { key, id, name } }
      if (resData.error === false && resData.instance && resData.instance.id) {
        return {
          connected: true,
          rawInfo: resData.instance,
        };
      }

      return {
        connected: false,
        message: resData.message || 'Instance not connected to WhatsApp',
        rawInfo: resData,
      };
    } catch (err) {
      return {
        connected: false,
        message: err instanceof Error ? err.message : 'Failed to query MegaAPI server',
      };
    }
  }
}
