// One-time vendor codes: shared by the admin function (creates them) and the
// Telegram bot (redeems them).
const crypto = require('crypto');

const CODE_DAYS = 7;
// No 0/O/1/I/L, so a code read aloud or typed by hand is not mistaken.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randomCode = () => 'AVA-' + Array.from(crypto.randomBytes(6), b => ALPHABET[b % ALPHABET.length]).join('');
const normaliseCode = (s) => String(s || '').trim().toUpperCase();
const validCodeShape = (s) => /^AVA-[A-Z0-9]{6}$/.test(s);

// Redeem a code for a Telegram account. Never throws for a bad code: returns
// { ok:false, reply } so the bot can answer plainly.
async function claimVendorCode(supabase, rawCode, fromId) {
  const code = normaliseCode(rawCode);
  const invalid = { ok: false, reply: "That code isn't valid, has expired or was already used. Please ask AVA's team for a new one. You can also register yourself by sending /start." };
  if (!validCodeShape(code)) return invalid;

  const { data: row } = await supabase.from('vendor_codes').select('*').eq('code', code).maybeSingle();
  if (!row || row.status !== 'active' || new Date(row.expires_at).getTime() <= Date.now()) return invalid;

  const { data: listing } = await supabase.from('directory_listings')
    .select('id, name, category, claimed_by_telegram_id').eq('id', row.listing_id).maybeSingle();
  if (!listing) return invalid;

  const owner = listing.claimed_by_telegram_id;
  const ownedByOther = owner != null && Number(owner) !== Number(fromId);
  if (ownedByOther && row.kind !== 'reconnect') {
    return { ok: false, reply: "This business is already connected to another Telegram account. Please ask AVA's team to reconnect it." };
  }

  const { data: profile } = await supabase.from('retailer_profile').select('telegram_user_id, directory_listing_id').eq('telegram_user_id', fromId).maybeSingle();
  if (profile && profile.directory_listing_id && String(profile.directory_listing_id) !== String(listing.id)) {
    return { ok: false, reply: 'This Telegram account is already connected to a different business. Please ask AVA\'s team for help.' };
  }

  // Use the code first, atomically, so two taps can never both succeed.
  const { data: used } = await supabase.from('vendor_codes')
    .update({ status: 'used', used_at: new Date().toISOString(), used_by_telegram_id: fromId })
    .eq('id', row.id).eq('status', 'active').select('id');
  if (!used || !used.length) return invalid;

  if (ownedByOther) {
    await supabase.from('retailer_profile').update({ directory_listing_id: null }).eq('telegram_user_id', owner);
  }
  await supabase.from('directory_listings').update({ claimed_by_telegram_id: fromId }).eq('id', listing.id);

  const isEvents = listing.category === 'promoter';
  const fields = { directory_listing_id: listing.id, business_name: listing.name, account_type: isEvents ? 'events' : 'prices', is_mobile_vendor: isEvents ? false : null };
  if (profile) await supabase.from('retailer_profile').update(fields).eq('telegram_user_id', fromId);
  else await supabase.from('retailer_profile').insert({ telegram_user_id: fromId, ...fields });

  return {
    ok: true, listing, previousOwner: ownedByOther ? owner : null,
    reply: isEvents
      ? `Welcome, ${listing.name}. You're connected. Send a photo of an event flyer and I will read the details back to you to confirm.`
      : `Welcome, ${listing.name}. You're connected. Are you a fixed location or a mobile/pop-up vendor? Reply "fixed" or "mobile".`,
  };
}

module.exports = { CODE_DAYS, randomCode, normaliseCode, validCodeShape, claimVendorCode };
