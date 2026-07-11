const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encryptionKey = process.env.ENCRYPTION_KEY;

if (!supabaseUrl || !supabaseServiceKey || !encryptionKey) {
  console.error('❌ Missing env variables.');
  process.exit(1);
}

// Decryption helper
function decrypt(ciphertext) {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format');
  }
  const [ivHex, ctHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const key = Buffer.from(encryptionKey, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ctHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function diagnose() {
  console.log('🔍 Starting MegaAPI Diagnostics...');
  
  // 1. Fetch config
  const { data: config, error: configErr } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('provider_type', 'megaapi')
    .maybeSingle();

  if (configErr || !config) {
    console.error('❌ No MegaAPI configuration found in DB:', configErr);
    return;
  }

  console.log('📋 Loaded Config from DB:');
  console.log(`   - ID: ${config.id}`);
  console.log(`   - Account ID: ${config.account_id}`);
  console.log(`   - Instance Key: "${config.phone_number_id}"`);
  console.log(`   - Host: "${config.waba_id}"`);
  console.log(`   - Status: "${config.status}"`);

  // 2. Decrypt token
  let token;
  try {
    token = decrypt(config.access_token);
    console.log(`✅ Decryption successful. Decrypted token length: ${token.length}`);
    console.log(`   - Decrypted Token (First 5 chars): "${token.substring(0, 5)}..."`);
  } catch (err) {
    console.error('❌ Token decryption failed. The encryption key might be wrong or token is corrupt:', err.message);
    return;
  }

  // 3. Rebuild API details
  const instanceKey = config.phone_number_id;
  const host = config.waba_id || 'api2.megaapi.com.br';
  const cleanHost = host.replace(/^https?:\/\//, '');

  console.log('\n🌐 Testing MegaAPI endpoints...');

  // A. Check Instance Status
  const statusUrl = `https://${cleanHost}/rest/instance/${instanceKey}`;
  console.log(`   - Checking status at: ${statusUrl}`);
  try {
    const res = await fetch(statusUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`   - Status response code: ${res.status}`);
    const resBody = await res.text();
    console.log(`   - Status response body: ${resBody}`);
  } catch (err) {
    console.error(`   - Status request failed:`, err.message);
  }

  // B. Check QR Code base64
  const qrUrl = `https://${cleanHost}/rest/instance/qrcode_base64/${instanceKey}`;
  console.log(`\n   - Fetching QR Code at: ${qrUrl}`);
  try {
    const res = await fetch(qrUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`   - QR Code response code: ${res.status}`);
    const resBody = await res.text();
    if (resBody.length > 500) {
      console.log(`   - QR Code response body (truncated): ${resBody.substring(0, 300)}...`);
    } else {
      console.log(`   - QR Code response body: ${resBody}`);
    }
  } catch (err) {
    console.error(`   - QR Code request failed:`, err.message);
  }
}

diagnose();
