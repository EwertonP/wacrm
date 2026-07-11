import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/whatsapp/encryption';

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data?.account_id) return null;
  return data.account_id as string;
}

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json({ error: 'No account linked to user' }, { status: 403 });
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    if (configError || !config) {
      return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 404 });
    }

    if (config.provider_type !== 'megaapi') {
      return NextResponse.json({ error: 'Active provider is not MegaAPI' }, { status: 400 });
    }

    const instanceKey = config.phone_number_id;
    const host = config.waba_id || 'api2.megaapi.com.br';
    const cleanHost = host.replace(/^https?:\/\//, '');
    const token = decrypt(config.access_token);

    const url = `https://${cleanHost}/rest/instance/${instanceKey}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `MegaAPI error: ${response.status} - ${response.statusText}` },
        { status: 502 }
      );
    }

    const resData = await response.json();
    const isConnected = resData.error === false && resData.instance && (resData.instance.status === 'connected' || resData.instance.user?.id);

    const newStatus = isConnected ? 'connected' : 'disconnected';

    // Se o status mudou, atualizar no banco de dados
    if (newStatus !== config.status) {
      await supabase
        .from('whatsapp_config')
        .update({
          status: newStatus,
          connected_at: isConnected ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', config.id);
    }

    return NextResponse.json({
      connected: isConnected,
      status: newStatus,
      rawInfo: resData.instance || null,
    });
  } catch (err) {
    console.error('[megaapi status GET] Fatal error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
