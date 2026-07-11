export interface SendMessagePayload {
  to: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateParams?: string[];
  templateMessageParams?: unknown;
  interactivePayload?: any | null;
  templateBodyText?: string | null;
}

export interface WhatsAppProvider {
  sendMessage(payload: SendMessagePayload): Promise<{ whatsappMessageId: string }>;
  verifyConnection(): Promise<{ connected: boolean; message?: string; rawInfo?: any }>;
  sendPresence?(to: string, presence: 'composing' | 'recording' | 'paused'): Promise<void>;
}
