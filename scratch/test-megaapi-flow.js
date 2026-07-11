const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

// Load env variables from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function runTest() {
  console.log('🚀 Starting MegaAPI Webhook Integration Test...');

  // 1. Get first account and profile to mock tenancy
  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('account_id, user_id')
    .limit(1);

  if (profileError || !profiles || profiles.length === 0) {
    console.error('❌ No user profiles found in database. Please register a user first.');
    return;
  }

  const { account_id: accountId, user_id: userId } = profiles[0];
  console.log(`📍 Found test tenant. Account ID: ${accountId}, User ID: ${userId}`);

  // 2. Fetch existing config or create a mock one
  const { data: existingConfig, error: configErr } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();

  let testInstanceKey;
  let didInsertConfig = false;

  if (existingConfig) {
    testInstanceKey = existingConfig.phone_number_id;
    console.log(`🔎 Found existing configuration in DB. Using instance key: ${testInstanceKey}`);
    
    // Ensure it is set to MegaAPI for this test
    if (existingConfig.provider_type !== 'megaapi') {
      console.log('🔄 Switching provider type to megaapi for test...');
      await supabase
        .from('whatsapp_config')
        .update({ provider_type: 'megaapi' })
        .eq('id', existingConfig.id);
    }
  } else {
    testInstanceKey = `test_inst_${Date.now()}`;
    console.log(`➕ No existing config. Creating mock MegaAPI config with instance key: ${testInstanceKey}`);
    
    const { error: insertConfigError } = await supabase
      .from('whatsapp_config')
      .insert({
        account_id: accountId,
        user_id: userId,
        phone_number_id: testInstanceKey,
        waba_id: 'api2.megaapi.com.br',
        access_token: 'U2FsdGVkX19mocktoken==================',
        provider_type: 'megaapi',
        status: 'disconnected',
        updated_at: new Date().toISOString(),
      });

    if (insertConfigError) {
      console.error('❌ Failed to insert mock configuration:', insertConfigError);
      return;
    }
    didInsertConfig = true;
  }

  // 3. Mock Webhook Payload from MegaAPI
  const testPhoneNumber = '5561999999999';
  const testMessageId = `mega-test-msg-${Date.now()}`;
  const mockPayload = {
    instance_key: testInstanceKey,
    message: {
      key: {
        remoteJid: `${testPhoneNumber}@s.whatsapp.net`,
        fromMe: false,
        id: testMessageId
      },
      messageType: 'conversation',
      messageData: {
        text: 'Olá! Isto é um teste de integração de entrada da MegaAPI no CRM.'
      },
      pushName: 'Cliente de Teste',
      timestamp: Math.floor(Date.now() / 1000)
    }
  };

  console.log('📤 Sending POST request to webhook endpoint...');
  try {
    const response = await fetch('http://localhost:3000/api/whatsapp/webhook/megaapi', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mockPayload)
    });

    const resData = await response.json();
    console.log(`📥 Webhook response status: ${response.status}`, resData);

    if (response.status !== 200) {
      console.error('❌ Webhook request failed.');
      if (didInsertConfig) await cleanup(accountId, testInstanceKey);
      return;
    }

    // Wait a brief moment for the 'after()' callback to finish database processing
    console.log('⏳ Waiting 3 seconds for async DB processing...');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 4. Verify DB changes
    console.log('🔎 Verifying DB entries...');

    // A. Check contact was created/found
    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('phone', testPhoneNumber)
      .maybeSingle();

    if (contactErr || !contact) {
      console.error('❌ Test failed: Contact was not created or found.', contactErr);
      if (didInsertConfig) await cleanup(accountId, testInstanceKey);
      return;
    }
    console.log(`✅ Success: Contact resolved. Name: ${contact.name}`);

    // B. Check conversation exists
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .maybeSingle();

    if (convErr || !conversation) {
      console.error('❌ Test failed: Conversation was not created or found.', convErr);
      if (didInsertConfig) await cleanup(accountId, testInstanceKey);
      return;
    }
    console.log(`✅ Success: Conversation resolved. ID: ${conversation.id}`);

    // C. Check message is saved
    const { data: message, error: msgErr } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .eq('message_id', testMessageId)
      .maybeSingle();

    if (msgErr || !message) {
      console.error('❌ Test failed: Message was not stored in the database.', msgErr);
      if (didInsertConfig) await cleanup(accountId, testInstanceKey);
      return;
    }
    console.log(`✅ Success: Message stored! Text: "${message.content_text}"`);
    console.log('🎉 Integration test passed successfully!');

  } catch (err) {
    console.error('❌ Fatal error during test execution:', err);
  } finally {
    if (didInsertConfig) {
      await cleanup(accountId, testInstanceKey);
    } else {
      console.log('ℹ️ Retained existing config as it was created by the user.');
    }
  }
}

async function cleanup(accountId, instanceKey) {
  console.log('🧹 Cleaning up mock configuration...');
  const { error } = await supabase
    .from('whatsapp_config')
    .delete()
    .eq('account_id', accountId)
    .eq('phone_number_id', instanceKey);

  if (error) {
    console.error('⚠️ Failed to clean up mock configuration:', error);
  } else {
    console.log('🗑️ Clean up complete.');
  }
}

runTest();
