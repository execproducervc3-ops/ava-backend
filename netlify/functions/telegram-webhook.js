const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

exports.handler = async (event) => {
  console.log('telegram-webhook invoked:', event.httpMethod, 'bodyLength:', event.body ? event.body.length : 0, 'isBase64:', event.isBase64Encoded);

  if (event.httpMethod !== 'POST') return ok();

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  let update;
  try {
    update = JSON.parse(rawBody);
  } catch (e) {
    console.error('Failed to parse Telegram update JSON. Raw body was:', rawBody);
    return ok();
  }

  const message = update.message;
  if (!message || !message.chat) {
    console.log('Update had no message.chat — full update was:', JSON.stringify(update));
    return ok();
  }

  const chatId = message.chat.id;
  const fromId = message.from.id;
  console.log('Processing message from', fromId, 'in chat', chatId, '— text:', message.text, '— has photo:', !!message.photo);

  try {
    let { data: profile } = await supabase
      .from('retailer_profile').select('*').eq('telegram_user_id', fromId).maybeSingle();

    // --- /start: first contact, begin onboarding ---
    if (message.text === '/start') {
      if (!profile) {
        await supabase.from('retailer_profile').insert({ telegram_user_id: fromId });
        await sendMessage(chatId, "Welcome to AVA! I'll help you list your prices and stock so people can find you. What's your business name?");
      } else {
        await sendMessage(chatId, `Welcome back${profile.business_name ? ', ' + profile.business_name : ''}! Send a photo of a price tag, shelf, or flyer any time to add a listing.`);
      }
      return ok();
    }

    // --- confirmation of a pending submission (checked first — a "yes" should
    // always confirm a real pending draft, regardless of what onboarding
    // question is technically still unanswered) ---
    if (message.text && /^(yes|y|confirm)$/i.test(message.text.trim())) {
      const { data: pendingDraft } = await supabase
        .from('submission_draft')
        .select('id')
        .eq('retailer_telegram_id', fromId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (pendingDraft) {
        await confirmLatestDraft(fromId, chatId);
        return ok();
      }
      // no pending draft — fall through so "yes" can still be interpreted
      // as an onboarding answer (e.g. answering the fixed/mobile question)
    }

    // --- collecting business name during onboarding ---
    if (message.text && profile && !profile.business_name) {
      const name = message.text.trim();
      await supabase.from('retailer_profile').update({ business_name: name }).eq('telegram_user_id', fromId);
      await sendMessage(chatId, `Got it — ${name}. Are you a fixed location or a mobile/pop-up vendor? Reply "fixed" or "mobile".`);
      return ok();
    }

    // --- fixed vs mobile ---
    if (message.text && profile && profile.business_name && profile.is_mobile_vendor === null) {
      const isMobile = /mobile|pop.?up/i.test(message.text);
      await supabase.from('retailer_profile').update({ is_mobile_vendor: isMobile }).eq('telegram_user_id', fromId);
      if (isMobile) {
        await sendMessage(chatId, "Got it. Since your location changes, please share your location each time you post — use Telegram's location-share, not typed text. Then send a photo of your price tag, shelf, or flyer whenever you're ready.");
      } else {
        await sendMessage(chatId, "Got it. Please share your location once now (Telegram's location-share button), then send a photo of a price tag, shelf, or flyer whenever you're ready.");
      }
      return ok();
    }

    // --- location share ---
    if (message.location) {
      await supabase.from('retailer_profile').update({
        default_lat: message.location.latitude,
        default_lng: message.location.longitude,
      }).eq('telegram_user_id', fromId);
      await sendMessage(chatId, 'Location saved. Send a photo whenever you have something to list.');
      return ok();
    }

    // --- photo submission: the core feature ---
    if (message.photo && message.photo.length) {
      if (!profile) {
        await supabase.from('retailer_profile').insert({ telegram_user_id: fromId });
      }
      await handlePhotoSubmission(message, fromId, chatId);
      return ok();
    }

    await sendMessage(chatId, 'Send /start to begin, or a photo of a price tag, shelf, or flyer to add a listing.');
    return ok();
  } catch (err) {
    console.error('telegram-webhook error:', err);
    try { await sendMessage(chatId, 'Something went wrong on my end — please try again in a moment.'); } catch (e) {}
    return ok();
  }
};

function ok() {
  return { statusCode: 200, body: 'ok' };
}

async function sendMessage(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function guessMediaType(filePath) {
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

async function getTelegramFileBase64(fileId) {
  const fileRes = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  const filePath = fileData.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const imgRes = await fetch(fileUrl);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return { base64: buf.toString('base64'), mediaType: guessMediaType(filePath) };
}

async function extractWithClaude(base64, mediaType, caption) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: `Read this photo (a price tag, shelf, or flyer from a small retailer in Saint Vincent and the Grenadines). Caption from the sender: "${caption || ''}".
Respond with ONLY JSON, no markdown fences, no preamble, in exactly this shape:
{"items": [{"name": string, "price": number, "unit": string or null}], "missing_fields": [string]}
If several items are visible (e.g. a shelf of tags), return all of them. If a price is genuinely unreadable for an item, leave it out of items and name it in missing_fields instead — do not guess a price.` },
        ],
      }],
    }),
  });
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) return null;
  const clean = textBlock.text.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean); } catch (e) { return null; }
}

async function uploadPhotoToStorage(base64, mediaType, fromId) {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = mediaType === 'image/png' ? 'png' : (mediaType === 'image/webp' ? 'webp' : 'jpg');
    const path = `${fromId}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('submission-photos').upload(path, buffer, { contentType: mediaType, upsert: false });
    if (error) { console.error('Photo upload failed:', error.message); return null; }
    const { data } = supabase.storage.from('submission-photos').getPublicUrl(path);
    return data ? data.publicUrl : null;
  } catch (e) {
    console.error('Photo upload threw:', e.message);
    return null;
  }
}

async function handlePhotoSubmission(message, fromId, chatId) {
  const largest = message.photo[message.photo.length - 1];
  const { base64, mediaType } = await getTelegramFileBase64(largest.file_id);
  const caption = message.caption || '';

  const extraction = await extractWithClaude(base64, mediaType, caption);
  if (!extraction || !extraction.items || !extraction.items.length) {
    await sendMessage(chatId, "I couldn't read any items from that photo — try a clearer shot, or add a caption with the item name and price.");
    return;
  }

  // Upload after extraction succeeds — no point storing a photo for a submission
  // that's about to be rejected anyway. A failed upload doesn't block the
  // submission itself; it just means no photo_url on this one.
  const photoUrl = await uploadPhotoToStorage(base64, mediaType, fromId);

  const { data: draft } = await supabase.from('submission_draft').insert({
    retailer_telegram_id: fromId,
    items: extraction.items,
    missing_fields: extraction.missing_fields || [],
    status: 'pending',
    photo_url: photoUrl,
  }).select().single();

  const preview = extraction.items.map(i => `• ${i.name} — $${i.price}${i.unit ? ' / ' + i.unit : ''}`).join('\n');
  const missingNote = (extraction.missing_fields && extraction.missing_fields.length)
    ? `\n\nCouldn't read: ${extraction.missing_fields.join(', ')}` : '';
  await sendMessage(chatId, `Got it:\n${preview}${missingNote}\n\nReply YES to confirm and publish, or just send another photo/message to correct it.`);
}

async function confirmLatestDraft(fromId, chatId) {
  const { data: draft } = await supabase.from('submission_draft')
    .select('*')
    .eq('retailer_telegram_id', fromId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!draft) {
    await sendMessage(chatId, "I don't have a pending submission to confirm — send a photo first.");
    return;
  }

  const { data: profile } = await supabase.from('retailer_profile').select('*').eq('telegram_user_id', fromId).maybeSingle();
  let listingId = profile ? profile.directory_listing_id : null;

  if (!listingId) {
    const { data: listing } = await supabase.from('directory_listings').insert({
      category: 'retailer',
      name: (profile && profile.business_name) || `Retailer ${fromId}`,
      lat: profile ? profile.default_lat : null,
      lng: profile ? profile.default_lng : null,
      source: 'community_submission',
      claimed_by_telegram_id: fromId,
    }).select().single();
    listingId = listing.id;
    await supabase.from('retailer_profile').update({ directory_listing_id: listingId }).eq('telegram_user_id', fromId);
  }

  for (const item of draft.items) {
    let canonicalId = null;
    const { data: existing } = await supabase.from('canonical_products').select('id').ilike('name', item.name).maybeSingle();
    if (existing) {
      canonicalId = existing.id;
    } else {
      const { data: created } = await supabase.from('canonical_products')
        .insert({ name: item.name, standard_unit: item.unit || 'each' }).select().single();
      canonicalId = created.id;
    }
    await supabase.from('retail_offers').insert({
      listing_id: listingId,
      canonical_product_id: canonicalId,
      item_name: item.name,
      price: item.price,
      unit: item.unit,
      source_type: 'caption',
      source_submission_id: draft.id,
      photo_url: draft.photo_url,
    });
  }

  await supabase.from('submission_draft').update({ status: 'confirmed' }).eq('id', draft.id);
  await sendMessage(chatId, `Published ${draft.items.length} item${draft.items.length === 1 ? '' : 's'}. Thanks!`);
}