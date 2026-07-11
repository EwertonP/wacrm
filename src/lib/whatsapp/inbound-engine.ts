import { createClient } from '@supabase/supabase-js';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

// Lazy-initialized admin client
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

export interface InboundMessagePayload {
  accountId: string;
  configOwnerUserId: string;
  messageId: string;
  fromPhone: string;
  senderName: string;
  messageType: string; // text, image, video, document, audio, location, interactive, reaction
  contentText: string | null;
  mediaUrl?: string | null;
  interactiveReplyId?: string | null;
  timestamp?: string | null; // UNIX timestamp in seconds or ISO string
  replyToWhatsappMessageId?: string | null; // Meta wamid or MegaAPI msg id
}

export async function processInboundMessage(payload: InboundMessagePayload) {
  const {
    accountId,
    configOwnerUserId,
    messageId,
    fromPhone,
    senderName,
    messageType,
    contentText,
    mediaUrl,
    interactiveReplyId,
    timestamp,
    replyToWhatsappMessageId,
  } = payload;

  const senderPhone = normalizePhone(fromPhone);
  const contactName = senderName || senderPhone;

  // 1. Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  // 2. Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  );
  if (!convResult) return;
  const conversation = convResult.conversation;

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    });
  }

  // 3. Handle reaction if it is one
  if (messageType === 'reaction') {
    await handleReaction(messageId, contentText, conversation.id, contactRecord.id);
    return;
  }

  // 4. Resolve reply context
  let replyToInternalId: string | null = null;
  if (replyToWhatsappMessageId) {
    replyToInternalId = await lookupInternalIdByMetaId(
      replyToWhatsappMessageId,
      conversation.id
    );
  }

  // 5. Normalise content type for database
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ]);
  const contentType = ALLOWED_CONTENT_TYPES.has(messageType)
    ? messageType
    : messageType === 'sticker'
      ? 'image'
      : 'text';

  // 6. Check if this is the contact's first inbound message
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0;

  // 7. Parse message timestamp
  let parsedTimestamp = new Date().toISOString();
  if (timestamp) {
    const numericTs = parseInt(timestamp);
    if (!isNaN(numericTs)) {
      // Se for timestamp UNIX (em segundos ou milissegundos)
      const isSeconds = numericTs < 10000000000;
      parsedTimestamp = new Date(numericTs * (isSeconds ? 1000 : 1)).toISOString();
    } else {
      parsedTimestamp = new Date(timestamp).toISOString();
    }
  }

  // 8. Insert message
  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: messageId,
    status: 'delivered',
    created_at: parsedTimestamp,
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId || null,
  });

  if (msgError) {
    console.error('Error inserting message:', msgError);
    return;
  }

  // 9. Update conversation
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${messageType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id);

  if (convError) {
    console.error('Error updating conversation:', convError);
  }

  // 10. Flag broadcast reply
  await flagBroadcastReplyIfAny(accountId, contactRecord.id);

  // 11. Flow runner dispatch
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: messageId,
        }
      : {
          kind: 'text',
          text: contentText ?? '',
          meta_message_id: messageId,
        },
    isFirstInboundMessage,
  });
  const flowConsumed = flowResult.consumed;

  // 12. Run automations
  const inboundText = contentText ?? '';
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = [];

  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply');
    }
  }

  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message');

  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }

  // 13. AI auto-reply
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    });
  }

  // 14. Emit webhook event
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: messageId,
    content_type: contentType,
    text: contentText,
  });
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<{ contact: any; wasCreated: boolean } | null> {
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone
  );

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id);
    }
    return { contact: existingContact, wasCreated: false };
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone);
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('Error creating contact:', createError);
    return null;
  }

  return { contact: newContact, wasCreated: true };
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('Error finding conversation:', findError);
    return null;
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false };
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false };
      }
    }
    console.error('Error creating conversation:', createError);
    return null;
  }

  return { conversation: newConv, created: true };
}

async function handleReaction(
  reactionMessageId: string,
  emoji: string | null,
  conversationId: string,
  contactId: string
) {
  const targetInternalId = await lookupInternalIdByMetaId(
    reactionMessageId,
    conversationId
  );
  if (!targetInternalId) {
    console.warn('[webhook] reaction target message not found; skipping', reactionMessageId);
    return;
  }

  if (!emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId);
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message);
    }
    return;
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    );
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message);
  }
}

async function lookupInternalIdByMetaId(
  metaMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle();

  if (error || !data) return null;
  return data.id as string;
}

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  const { data: recipient, error } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, reply_flag')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !recipient || recipient.reply_flag) return;

  await supabaseAdmin()
    .from('broadcast_recipients')
    .update({ reply_flag: true })
    .eq('id', recipient.id);
}
