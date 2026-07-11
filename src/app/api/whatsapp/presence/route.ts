import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MegaApiProvider } from '@/lib/whatsapp/providers/megaapi';
import { decrypt } from '@/lib/whatsapp/encryption';

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const accountId = profile?.account_id;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Profile not linked to an account.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { to, presence, conversation_id } = body;

    if ((!to && !conversation_id) || !presence) {
      return NextResponse.json(
        { error: 'Missing parameters (to or conversation_id, plus presence are required)' },
        { status: 400 }
      );
    }

    if (!['composing', 'recording', 'paused'].includes(presence)) {
      return NextResponse.json(
        { error: 'Invalid presence value (must be composing, recording, or paused)' },
        { status: 400 }
      );
    }

    let targetPhone = to;
    if (conversation_id) {
      const { data: conv, error: convErr } = await supabase
        .from('conversations')
        .select('id, contacts(phone)')
        .eq('id', conversation_id)
        .eq('account_id', accountId)
        .maybeSingle();

      if (convErr || !conv) {
        return NextResponse.json(
          { error: 'Conversation not found or unauthorized.' },
          { status: 404 }
        );
      }

      // Supabase contacts relationship handles contacts as object or array depending on mapping
      const contactObj = conv.contacts as any;
      const phoneVal = contactObj?.phone;
      if (!phoneVal) {
        return NextResponse.json(
          { error: 'Could not resolve contact phone number.' },
          { status: 400 }
        );
      }
      targetPhone = phoneVal;
    }

    // Buscar a configuração ativa do WhatsApp
    const { data: config, error: configErr } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    if (configErr || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured for this account.' },
        { status: 404 }
      );
    }

    const providerType = config.provider_type || 'meta';

    if (providerType === 'megaapi') {
      const accessToken = decrypt(config.access_token);
      const provider = new MegaApiProvider({
        instanceKey: config.phone_number_id,
        token: accessToken,
        host: config.waba_id,
      });

      if (provider.sendPresence) {
        await provider.sendPresence(targetPhone, presence);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[presence API] Fatal error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
