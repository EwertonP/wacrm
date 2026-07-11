import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { processInboundMessage } from '@/lib/whatsapp/inbound-engine';

export const maxDuration = 60;

let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    console.log('[megaapi webhook] received raw payload:', JSON.stringify(body));

    const instanceKey = body.instance_key || body.instanceKey || body.instance;
    if (!instanceKey) {
      console.warn('[megaapi webhook] Ignored: missing instanceKey. Body keys:', Object.keys(body));
      return NextResponse.json({ error: 'Missing instanceKey' }, { status: 400 });
    }

    // Resolve where the message envelope is (contains key, pushName, timestamp)
    let envelope: any = null;
    if (body.key) {
      envelope = body;
    } else if (body.data && body.data.key) {
      envelope = body.data;
    } else if (body.message && body.message.key) {
      envelope = body.message;
    }

    if (!envelope) {
      console.warn('[megaapi webhook] Ignored: no message envelope with key found. Body keys:', Object.keys(body));
      return NextResponse.json({ status: 'ignored_non_message' }, { status: 200 });
    }

    const key = envelope.key;
    if (!key || key.fromMe === true) {
      return NextResponse.json({ status: 'ignored_outbound' }, { status: 200 });
    }

    // Buscar a configuração do WhatsApp no banco correspondente a este instanceKey
    const { data: config, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('*')
      .eq('phone_number_id', instanceKey)
      .eq('provider_type', 'megaapi')
      .maybeSingle();

    if (configError || !config) {
      console.error('[megaapi webhook] No configuration found for instanceKey:', instanceKey, configError);
      return NextResponse.json({ error: 'Instance not configured in CRM' }, { status: 404 });
    }

    // Mapear o payload da MegaAPI para a estrutura padronizada
    const remoteJid = key.remoteJid || '';
    if (
      remoteJid.endsWith('@g.us') || 
      remoteJid.endsWith('@broadcast') || 
      remoteJid.endsWith('@newsletter') ||
      remoteJid.includes('status@broadcast')
    ) {
      console.log('[megaapi webhook] Ignored group, broadcast, or newsletter message from:', remoteJid);
      return NextResponse.json({ status: 'ignored_non_personal' }, { status: 200 });
    }
    const fromJid = key.senderPn || remoteJid;
    const fromPhone = fromJid.split('@')[0];
    const messageId = key.id || `mega-in-${Date.now()}`;
    const senderName = envelope.pushName || fromPhone;
    const timestamp = envelope.timestamp || envelope.messageTimestamp;

    // Resolve the message content object (which contains conversation, extendedTextMessage, etc.)
    let messageContent = envelope.messageData || envelope.message || {};
    if (typeof messageContent === 'string') {
      messageContent = { conversation: messageContent };
    }

    // Resolve messageType (conversation, extendedTextMessage, imageMessage, etc.)
    let messageType = envelope.messageType;
    if (!messageType) {
      const contentKeys = Object.keys(messageContent);
      if (contentKeys.length > 0) {
        messageType = contentKeys[0];
      } else {
        messageType = 'conversation';
      }
    }

    let contentText: string | null = null;
    let mediaUrl: string | null = null;
    let typeMapped = 'text';

    const data = messageContent[messageType] || messageContent || {};

    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      contentText = typeof data === 'string' ? data : data.text || data.conversation || '';
      typeMapped = 'text';
    } else if (messageType === 'imageMessage') {
      contentText = data.caption || null;
      mediaUrl = data.url || data.mediaUrl || null;
      typeMapped = 'image';
    } else if (messageType === 'videoMessage') {
      contentText = data.caption || null;
      mediaUrl = data.url || data.mediaUrl || null;
      typeMapped = 'video';
    } else if (messageType === 'documentMessage') {
      contentText = data.fileName || data.caption || 'Documento';
      mediaUrl = data.url || data.mediaUrl || null;
      typeMapped = 'document';
    } else if (messageType === 'audioMessage') {
      mediaUrl = data.url || data.mediaUrl || null;
      typeMapped = 'audio';
    } else {
      contentText = typeof data === 'string' ? data : data.text || data.conversation || '[Mensagem do WhatsApp]';
      typeMapped = 'text';
    }

    // Usar a convenção "after" do NextJS para processar a mensagem de forma assíncrona
    // para liberar a requisição do webhook da MegaAPI imediatamente com 200 OK.
    after(async () => {
      try {
        await processInboundMessage({
          accountId: config.account_id,
          configOwnerUserId: config.user_id,
          messageId,
          fromPhone,
          senderName,
          messageType: typeMapped,
          contentText,
          mediaUrl,
          timestamp: timestamp ? String(timestamp) : null,
        });
      } catch (err) {
        console.error('[megaapi webhook] Error processing inbound message:', err);
      }
    });

    return NextResponse.json({ status: 'received' }, { status: 200 });
  } catch (err) {
    console.error('[megaapi webhook] Fatal webhook error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// Suporte para validação de rota (alguns gateways mandam GET para testar a URL)
export async function GET() {
  return NextResponse.json({ status: 'MegaAPI webhook active' }, { status: 200 });
}
