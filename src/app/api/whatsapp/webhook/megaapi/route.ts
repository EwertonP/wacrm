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
    console.log('[megaapi webhook] received payload:', JSON.stringify(body));

    const instanceKey = body.instance_key;
    if (!instanceKey) {
      return NextResponse.json({ error: 'Missing instance_key' }, { status: 400 });
    }

    const msgData = body.message;
    if (!msgData) {
      // Pode ser um evento de conexão ou status, retornar 200 OK
      return NextResponse.json({ status: 'ignored_non_message' }, { status: 200 });
    }

    const key = msgData.key;
    if (!key || key.fromMe === true) {
      // Ignorar mensagens enviadas por nós mesmos (outbound) para evitar duplicação
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
    const fromJid = key.remoteJid || '';
    const fromPhone = fromJid.split('@')[0];
    const messageId = key.id || `mega-in-${Date.now()}`;
    const senderName = msgData.pushName || fromPhone;
    const messageType = msgData.messageType || 'conversation';
    const timestamp = msgData.timestamp;

    let contentText: string | null = null;
    let mediaUrl: string | null = null;
    let typeMapped = 'text';

    const data = msgData.messageData || {};

    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      contentText = data.text || data.conversation || '';
      typeMapped = 'text';
    } else if (messageType === 'imageMessage') {
      contentText = data.caption || null;
      mediaUrl = data.url || null;
      typeMapped = 'image';
    } else if (messageType === 'videoMessage') {
      contentText = data.caption || null;
      mediaUrl = data.url || null;
      typeMapped = 'video';
    } else if (messageType === 'documentMessage') {
      contentText = data.fileName || data.caption || 'Documento';
      mediaUrl = data.url || null;
      typeMapped = 'document';
    } else if (messageType === 'audioMessage') {
      mediaUrl = data.url || null;
      typeMapped = 'audio';
    } else {
      // Fallback para tipos desconhecidos
      contentText = data.text || data.conversation || '[Mensagem do WhatsApp]';
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
