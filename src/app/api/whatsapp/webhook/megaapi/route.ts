import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { processInboundMessage } from '@/lib/whatsapp/inbound-engine';
import { decrypt } from '@/lib/whatsapp/encryption';

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
      // Sincronizar status de conexão dinamicamente via webhook
      if (body.status && instanceKey) {
        console.log(`[megaapi webhook] Received status update: ${body.status} for instance: ${instanceKey}`);
        
        let dbStatus = 'disconnected';
        if (body.status === 'connected' || body.status === 'authenticated') {
          dbStatus = 'connected';
        }
        
        const { error: updateErr } = await supabaseAdmin()
          .from('whatsapp_config')
          .update({
            status: dbStatus,
            connected_at: dbStatus === 'connected' ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
          })
          .eq('phone_number_id', instanceKey)
          .eq('provider_type', 'megaapi');
          
        if (updateErr) {
          console.error('[megaapi webhook] Failed to update connection status in DB:', updateErr);
        } else {
          console.log('[megaapi webhook] Successfully updated connection status in DB to:', dbStatus);
        }
        
        return NextResponse.json({ status: 'status_updated' }, { status: 200 });
      }

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
        let finalMediaUrl = mediaUrl;

        // Se for uma mensagem de mídia (imagem, vídeo, documento, áudio), baixamos e subimos para o Supabase Storage
        if (mediaUrl && ['image', 'video', 'document', 'audio'].includes(typeMapped)) {
          try {
            console.log(`[megaapi webhook] Downloading media message keys for ${typeMapped}...`);
            const decryptedToken = decrypt(config.access_token);
            const cleanHost = (config.waba_id || 'api2.megaapi.com.br').replace(/^https?:\/\//, '');
            const downloadUrl = `https://${cleanHost}/rest/instance/downloadMediaMessage/${instanceKey}`;

            const downloadRes = await fetch(downloadUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${decryptedToken}`,
              },
              body: JSON.stringify({
                messageKeys: {
                  mediaKey: data.mediaKey || '',
                  directPath: data.directPath || '',
                  url: data.url || '',
                  mimetype: data.mimetype || '',
                  messageType: messageType.replace('Message', ''),
                },
              }),
            });

            if (downloadRes.ok) {
              const downloadData = await downloadRes.json();
              const mediaContent = downloadData && (downloadData.data || downloadData.base64);
              if (mediaContent) {
                // Extrair o base64 puro
                const base64Str = mediaContent.includes(',')
                  ? mediaContent.split(',')[1]
                  : mediaContent;
                const buffer = Buffer.from(base64Str, 'base64');

                // Determinar extensão e nome do arquivo
                const mime = data.mimetype || 'application/octet-stream';
                const ext = mime.split('/')[1]?.split(';')[0] || 'bin';
                const path = `account-${config.account_id}/${Date.now()}-inbound-${messageId}.${ext}`;

                // Fazer upload para o Supabase Storage (bucket chat-media)
                const { error: uploadErr } = await supabaseAdmin()
                  .storage
                  .from('chat-media')
                  .upload(path, buffer, {
                    contentType: mime,
                    upsert: true,
                  });

                if (uploadErr) {
                  console.error('[megaapi webhook] Supabase Storage upload failed:', uploadErr.message);
                  await supabaseAdmin()
                    .from('whatsapp_config')
                    .update({ last_registration_error: `[DEBUG UPLOAD ERR] ${uploadErr.message}` })
                    .eq('phone_number_id', instanceKey);
                } else {
                  // Obter URL pública
                  const { data: { publicUrl } } = supabaseAdmin()
                    .storage
                    .from('chat-media')
                    .getPublicUrl(path);

                  finalMediaUrl = publicUrl;
                  console.log('[megaapi webhook] Successfully uploaded media to Supabase Storage:', finalMediaUrl);
                  await supabaseAdmin()
                    .from('whatsapp_config')
                    .update({ last_registration_error: `[DEBUG SUCCESS] Media uploaded. size=${buffer.length}` })
                    .eq('phone_number_id', instanceKey);
                }
              } else {
                console.error('[megaapi webhook] downloadMediaMessage returned no base64:', downloadData);
                await supabaseAdmin()
                  .from('whatsapp_config')
                  .update({ last_registration_error: `[DEBUG NO BASE64] ${JSON.stringify(downloadData)}` })
                  .eq('phone_number_id', instanceKey);
              }
            } else {
              const statusText = downloadRes.statusText || '';
              console.error(`[megaapi webhook] downloadMediaMessage failed with status: ${downloadRes.status} ${statusText}`);
              await supabaseAdmin()
                .from('whatsapp_config')
                .update({ last_registration_error: `[DEBUG FETCH ERR] Status: ${downloadRes.status} ${statusText}` })
                .eq('phone_number_id', instanceKey);
            }
          } catch (mediaErr) {
            const errStr = mediaErr instanceof Error ? mediaErr.message : String(mediaErr);
            console.error('[megaapi webhook] Failed to download/upload media:', mediaErr);
            await supabaseAdmin()
              .from('whatsapp_config')
              .update({ last_registration_error: `[DEBUG EXCEPTION] ${errStr}` })
              .eq('phone_number_id', instanceKey);
          }
        }

        await processInboundMessage({
          accountId: config.account_id,
          configOwnerUserId: config.user_id,
          messageId,
          fromPhone,
          senderName,
          messageType: typeMapped,
          contentText,
          mediaUrl: finalMediaUrl,
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
