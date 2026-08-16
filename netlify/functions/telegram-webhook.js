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

    // --- bulk stock list upload: for a retailer's full catalog, not a single photo ---
    if (message.document && /\.xlsx?$/i.test(message.document.file_name || '')) {
      if (!profile) {
        await supabase.from('retailer_profile').insert({ telegram_user_id: fromId });
      }
      await handleXlsSubmission(message, fromId, chatId);
      return ok();
    }

    await sendMessage(chatId, 'Send /start to begin, a photo of a price tag/shelf/flyer to add a listing, or an .xlsx file with your full stock list (columns: item, price, unit).');
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

// Cross-unit price normalization — lets AVA correctly compare, say, a 10kg
// bag against a 5lb bag rather than just sorting by raw price. Genuinely
// unparseable units ("bag", "each", "plate") correctly return null rather
// than guessing — a wrong comparison is worse than an honest gap.
const WEIGHT_TO_LB = { lb:1, lbs:1, pound:1, pounds:1, kg:2.20462, kgs:2.20462, kilogram:2.20462, kilograms:2.20462, g:0.00220462, gram:0.00220462, grams:0.00220462, oz:0.0625, ounce:0.0625, ounces:0.0625 };
const VOLUME_TO_GALLON = { gallon:1, gallons:1, gal:1, liter:0.264172, liters:0.264172, litre:0.264172, litres:0.264172, l:0.264172, floz:0.0078125 };

function parseQuantityUnit(unitText){
  if(!unitText) return null;
  const text = unitText.toLowerCase().trim();
  const match = text.match(/(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kgs?|kilograms?|g|grams?|oz|ounces?|gallons?|gal|liters?|litres?|l|fl\s*oz)\b/);
  if(!match) return null;
  const qty = parseFloat(match[1]);
  const unitToken = match[2].replace(/\s+/g, '');
  if(WEIGHT_TO_LB[unitToken] !== undefined) return { type: 'weight_lb', qtyInStandardUnit: qty * WEIGHT_TO_LB[unitToken] };
  if(VOLUME_TO_GALLON[unitToken] !== undefined) return { type: 'volume_gallon', qtyInStandardUnit: qty * VOLUME_TO_GALLON[unitToken] };
  return null;
}

function computeNormalization(price, unitText){
  const parsed = parseQuantityUnit(unitText);
  if(!parsed || !parsed.qtyInStandardUnit || parsed.qtyInStandardUnit <= 0) return { standard_unit_type: null, price_per_standard_unit: null };
  return { standard_unit_type: parsed.type, price_per_standard_unit: +(price / parsed.qtyInStandardUnit).toFixed(4) };
}

function extractHashtags(text){
  if (!text) return [];
  const matches = text.match(/#(\w+)/g) || [];
  // dedupe, strip the #, lowercase for consistent matching later
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

async function handlePhotoSubmission(message, fromId, chatId) {
  const largest = message.photo[message.photo.length - 1];
  const { base64, mediaType } = await getTelegramFileBase64(largest.file_id);
  const caption = message.caption || '';
  const tags = extractHashtags(caption);

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
    tags,
  }).select().single();

  const preview = extraction.items.map(i => `• ${i.name} — $${i.price}${i.unit ? ' / ' + i.unit : ''}`).join('\n');
  const missingNote = (extraction.missing_fields && extraction.missing_fields.length)
    ? `\n\nCouldn't read: ${extraction.missing_fields.join(', ')}` : '';
  const tagsNote = tags.length ? `\n\nTags: ${tags.map(t => '#' + t).join(' ')}` : '';
  await sendMessage(chatId, `Got it:\n${preview}${missingNote}${tagsNote}\n\nReply YES to confirm and publish, or just send another photo/message to correct it.`);
}

async function handleXlsSubmission(message, fromId, chatId) {
  const { base64 } = await getTelegramFileBase64(message.document.file_id);
  const caption = message.caption || '';
  const tags = extractHashtags(caption);

  let workbook;
  try {
    const XLSX = require('xlsx');
    const buf = Buffer.from(base64, 'base64');
    workbook = XLSX.read(buf, { type: 'buffer' });
  } catch (e) {
    console.error('XLSX parse error:', e);
    await sendMessage(chatId, "I couldn't read that file — make sure it's a real .xlsx spreadsheet.");
    return;
  }

  const XLSX = require('xlsx');
  let rows = [];
  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    sheetRows.forEach(r => { r.__sheet = sheetName; });
    rows = rows.concat(sheetRows);
  }

  if (!rows.length) {
    await sendMessage(chatId, "That file didn't have any rows I could read. Expected columns: item, price, and optionally unit.");
    return;
  }

  // Tolerant of common header variations — retailers won't all use the exact same template.
  const NAME_KEYS = ['item', 'item_name', 'name', 'product'];
  const PRICE_KEYS = ['price', 'cost', 'amount'];
  const UNIT_KEYS = ['unit', 'units', 'size'];

  function findKey(row, candidates) {
    const rowKeys = Object.keys(row);
    for (const cand of candidates) {
      const match = rowKeys.find(k => k.trim().toLowerCase() === cand);
      if (match) return match;
    }
    return null;
  }

  const validItems = [];
  let skippedCount = 0;
  const skippedReasons = new Set();
  const sheetCounts = new Map(); // sheetName -> { valid, skipped }

  for (const row of rows) {
    const sheetName = row.__sheet || 'Sheet1';
    if (!sheetCounts.has(sheetName)) sheetCounts.set(sheetName, { valid: 0, skipped: 0 });
    const counts = sheetCounts.get(sheetName);

    const nameKey = findKey(row, NAME_KEYS);
    const priceKey = findKey(row, PRICE_KEYS);
    const unitKey = findKey(row, UNIT_KEYS);

    const name = nameKey ? String(row[nameKey]).trim() : '';
    const rawPrice = priceKey ? row[priceKey] : null;
    const priceStr = String(rawPrice);
    const isRange = /\d\s*-\s*\d/.test(priceStr) || /\d+\s*to\s*\d+/i.test(priceStr);
    const price = isRange ? NaN : (typeof rawPrice === 'number' ? rawPrice : parseFloat(priceStr.replace(/[^0-9.]/g, '')));

    if (!name) { skippedCount++; counts.skipped++; skippedReasons.add('missing item name'); continue; }
    if (!isFinite(price) || price <= 0) {
      skippedCount++; counts.skipped++;
      skippedReasons.add(isRange ? 'price range not supported — use a single price' : 'missing or invalid price');
      continue;
    }

    validItems.push({ name, price, unit: unitKey ? String(row[unitKey]).trim() : null });
    counts.valid++;
  }

  if (!validItems.length) {
    await sendMessage(chatId, `I couldn't find any usable rows (${skippedCount} skipped: ${[...skippedReasons].join(', ')}). Expected columns: item, price, and optionally unit.`);
    return;
  }

  await supabase.from('submission_draft').insert({
    retailer_telegram_id: fromId,
    items: validItems,
    missing_fields: [],
    status: 'pending',
    photo_url: null,
    tags,
    source_type: 'xls_bulk',
  });

  const sample = validItems.slice(0, 5).map(i => `• ${i.name} — $${i.price}${i.unit ? ' / ' + i.unit : ''}`).join('\n');
  const moreNote = validItems.length > 5 ? `\n...and ${validItems.length - 5} more` : '';
  const skippedNote = skippedCount ? `\n\n${skippedCount} row(s) skipped (${[...skippedReasons].join(', ')})` : '';
  const sheetsWithData = [...sheetCounts.entries()].filter(([, c]) => c.valid > 0);
  const sheetBreakdown = sheetsWithData.length > 1
    ? '\n\nBy sheet:\n' + sheetsWithData.map(([name, c]) => `• ${name}: ${c.valid} item${c.valid === 1 ? '' : 's'}`).join('\n')
    : '';
  await sendMessage(chatId, `Found ${validItems.length} item${validItems.length === 1 ? '' : 's'}${sheetsWithData.length > 1 ? ` across ${sheetsWithData.length} sheets` : ''}:\n${sample}${moreNote}${sheetBreakdown}${skippedNote}\n\nReply YES to publish all ${validItems.length}, or send a corrected file.`);
}

// Flags a submission for manual review only when there's a real signal —
// Claude's own extraction uncertainty ignored at confirmation, or a price
// that's a wild outlier vs. other retailers or vs. this retailer's own
// history for the same product. Most submissions never trip any of this.
function detectFlagReason(item, listingId, existingOffersForProduct, hasMissingFields, isFirstEverSubmission){
  if(isFirstEverSubmission) return "First submission from a new retailer — not yet vetted. Review once, then future submissions flow through normally.";
  if(hasMissingFields) return "Claude flagged uncertainty reading part of this submission, and the retailer confirmed anyway";

  const normalized = computeNormalization(item.price, item.unit);
  const thisIsNormalized = normalized.price_per_standard_unit !== null;
  const thisValue = thisIsNormalized ? normalized.price_per_standard_unit : item.price;

  const otherRetailerOffers = (existingOffersForProduct || []).filter(o => o.listing_id !== listingId);
  const sameRetailerOffers = (existingOffersForProduct || []).filter(o => o.listing_id === listingId);

  if(otherRetailerOffers.length){
    const comparableValues = otherRetailerOffers
      .map(o => (thisIsNormalized && o.price_per_standard_unit) ? o.price_per_standard_unit : o.price)
      .filter(v => v !== null && v !== undefined && v > 0);
    if(comparableValues.length){
      const avg = comparableValues.reduce((a, b) => a + b, 0) / comparableValues.length;
      if(thisValue > avg * 3 || thisValue < avg / 3){
        return `Price is ${thisValue > avg ? 'far higher' : 'far lower'} than other retailers' listings for this product (this: ~$${thisValue.toFixed(2)}${thisIsNormalized ? '/std unit' : ''}, others average ~$${avg.toFixed(2)})`;
      }
    }
  }

  if(sameRetailerOffers.length){
    const priorValues = sameRetailerOffers
      .map(o => (thisIsNormalized && o.price_per_standard_unit) ? o.price_per_standard_unit : o.price)
      .filter(v => v !== null && v !== undefined && v > 0);
    if(priorValues.length){
      const priorAvg = priorValues.reduce((a, b) => a + b, 0) / priorValues.length;
      if(thisValue > priorAvg * 3 || thisValue < priorAvg / 3){
        return `Big jump from this retailer's own prior listing for this product (this: ~$${thisValue.toFixed(2)}, their prior average: ~$${priorAvg.toFixed(2)})`;
      }
    }
  }

  return null;
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

  // Bulk operations instead of N sequential round-trips per item — a photo
  // submission has a handful of items, but a stock-list XLS upload can have
  // hundreds, and the old per-item loop risked a function timeout at exactly
  // the scale this feature is meant for.
  const items = draft.items;

  const { data: allCanonical } = await supabase.from('canonical_products').select('id, name');
  const canonicalMap = new Map((allCanonical || []).map(p => [p.name.toLowerCase(), p.id]));

  // Dedupe new products both against what already exists AND within this
  // batch itself (two rows in the same stock list can share a name).
  const newProducts = new Map();
  for (const item of items) {
    const key = item.name.toLowerCase();
    if (!canonicalMap.has(key) && !newProducts.has(key)) {
      newProducts.set(key, item);
    }
  }

  if (newProducts.size) {
    const { data: created } = await supabase.from('canonical_products')
      .insert([...newProducts.values()].map(item => ({ name: item.name, standard_unit: item.unit || 'each' })))
      .select();
    for (const c of (created || [])) canonicalMap.set(c.name.toLowerCase(), c.id);
  }

  const productIds = [...new Set(items.map(item => canonicalMap.get(item.name.toLowerCase())).filter(Boolean))];
  const { data: existingOffers } = await supabase
    .from('retail_offers')
    .select('canonical_product_id, listing_id, price, price_per_standard_unit')
    .in('canonical_product_id', productIds.length ? productIds : ['00000000-0000-0000-0000-000000000000'])
    .in('review_status', ['auto_published', 'approved']); // only compare against trusted existing data

  const offersByProduct = new Map();
  for(const o of (existingOffers || [])){
    if(!offersByProduct.has(o.canonical_product_id)) offersByProduct.set(o.canonical_product_id, []);
    offersByProduct.get(o.canonical_product_id).push(o);
  }

  const hasMissingFields = !!(draft.missing_fields && draft.missing_fields.length);

  // Checked once per confirmation, not per item — this must run before the
  // current batch inserts, or it would just see its own rows and never
  // correctly detect a genuinely new retailer's first submission.
  const { data: priorOffers } = await supabase
    .from('retail_offers')
    .select('id')
    .eq('listing_id', listingId)
    .limit(1);
  const isFirstEverSubmission = !priorOffers || !priorOffers.length;
  const flaggedItems = [];

  const offersToInsert = items.map((item, idx) => {
    const normalized = computeNormalization(item.price, item.unit);
    const productId = canonicalMap.get(item.name.toLowerCase()) || null;
    const existingForProduct = productId ? (offersByProduct.get(productId) || []) : [];
    const flagReason = detectFlagReason(item, listingId, existingForProduct, hasMissingFields, isFirstEverSubmission);
    if(flagReason) flaggedItems.push({ idx, reason: flagReason });

    return {
      listing_id: listingId,
      canonical_product_id: productId,
      item_name: item.name,
      price: item.price,
      unit: item.unit,
      standard_unit_type: normalized.standard_unit_type,
      price_per_standard_unit: normalized.price_per_standard_unit,
      review_status: flagReason ? 'pending_review' : 'auto_published',
      source_type: draft.source_type || 'caption',
      source_submission_id: draft.id,
      photo_url: draft.photo_url,
      tags: draft.tags || [],
    };
  });
  const { data: insertedOffers } = await supabase.from('retail_offers')
    .upsert(offersToInsert, { onConflict: 'listing_id,canonical_product_id', ignoreDuplicates: false })
    .select();

  if(flaggedItems.length && insertedOffers){
    const reviewRows = flaggedItems
      .filter(f => insertedOffers[f.idx])
      .map(f => ({
        item_type: 'submission',
        reference_id: insertedOffers[f.idx].id,
        reason: f.reason,
        status: 'pending',
      }));
    if(reviewRows.length) await supabase.from('review_queue').insert(reviewRows);
  }

  await supabase.from('submission_draft').update({ status: 'confirmed' }).eq('id', draft.id);
  await sendMessage(chatId, `Published ${draft.items.length} item${draft.items.length === 1 ? '' : 's'}. Thanks!`);
}
