// Public: "See it on you". Sends the visitor's photo and one garment photo to Google's Virtual Try-On model
// and returns the picture. The visitor's photo is used once and never stored or logged.
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const PER_IP_DAILY = Number(process.env.TRYON_PER_IP_DAILY || 4);
const GLOBAL_DAILY = Number(process.env.TRYON_GLOBAL_DAILY || 100);
const MAX_BYTES = 4000000;
const ON_A_BREAK = 'The outfit preview is on a break, try again in a bit.';

const reply = (code, obj) => ({ statusCode: code, headers: CORS, body: JSON.stringify(obj) });

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length > 7 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length > 11 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

// --- Google access goes through AVA's own relay inside the Google project (no key file anywhere).
const RELAY_URL = () => process.env.TRYON_RELAY_URL || '';
const RELAY_SECRET = () => process.env.TRYON_RELAY_SECRET || '';

// --- Daily counters
async function bump(key, day, by) {
  const cur = await supabase.from('tryon_usage').select('n').eq('key', key).eq('day', day).maybeSingle();
  const n = Math.max(0, ((cur.data && cur.data.n) || 0) + by);
  await supabase.from('tryon_usage').upsert({ key, day, n });
  return n;
}
async function current(key, day) {
  const cur = await supabase.from('tryon_usage').select('n').eq('key', key).eq('day', day).maybeSingle();
  return (cur.data && cur.data.n) || 0;
}

// The garment photo must come from AVA's own storage, never an arbitrary address.
function allowedProductUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.host === new URL(process.env.SUPABASE_URL).host;
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Bad request.' }); }

  if (!RELAY_URL() || !RELAY_SECRET()) return reply(503, { error: ON_A_BREAK, unavailable: true });

  const person = Buffer.from(String(b.person || '').replace(/^data:[^,]*,/, ''), 'base64');
  if (!person.length) return reply(400, { error: 'Please add a photo of yourself.' });
  if (person.length > MAX_BYTES) return reply(400, { error: 'That photo is too large. Please use a smaller one.' });
  const personType = sniff(person);
  if (!personType) return reply(400, { error: 'Photos must be JPEG, PNG or WebP.' });
  if (b.consent !== true) return reply(400, { error: 'Please tick the box to confirm you are happy for your photo to be sent to our AI image service for this preview.' });
  if (!allowedProductUrl(b.product_url)) return reply(400, { error: 'That item cannot be previewed.' });

  const day = new Date().toISOString().slice(0, 10);
  const ip = String((event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || '').split(',')[0].trim();
  const ipKey = 'ip:' + (ip ? crypto.createHash('sha256').update(ip + '|' + (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(-12)).digest('hex').slice(0, 24) : 'unknown');
  if (await current('all', day) >= GLOBAL_DAILY) return reply(429, { error: 'The outfit preview has reached its limit for today. Please try again tomorrow.' });
  if (await current(ipKey, day) >= PER_IP_DAILY) return reply(429, { error: 'You have used all your outfit previews for today. Please try again tomorrow.' });

  let productBuf, productType;
  try {
    const pr = await fetch(b.product_url);
    if (!pr.ok) throw new Error('product fetch ' + pr.status);
    productBuf = Buffer.from(await pr.arrayBuffer());
    productType = sniff(productBuf);
    if (!productType || productBuf.length > MAX_BYTES * 2) throw new Error('bad product image');
  } catch (e) {
    return reply(400, { error: 'That item cannot be previewed.' });
  }

  await bump('all', day, 1); await bump(ipKey, day, 1);
  const refund = async () => { try { await bump('all', day, -1); await bump(ipKey, day, -1); } catch (e) {} };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 22000);
    let res;
    try {
      res = await fetch(RELAY_URL(), {
        method: 'POST', signal: ctrl.signal,
        headers: { 'x-relay-secret': RELAY_SECRET(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{
            personImage: { image: { bytesBase64Encoded: person.toString('base64') } },
            productImages: [{ image: { bytesBase64Encoded: productBuf.toString('base64') } }],
          }],
          parameters: { sampleCount: 1 },
        }),
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      console.error('tryon: Google returned', res.status);   // status only; never log the photos
      await refund();
      if (res.status === 400) return reply(422, { error: 'We could not make a preview from that photo. Try a clear, full-length photo with good light.' });
      return reply(503, { error: ON_A_BREAK, unavailable: true });
    }
    const data = await res.json();
    const p = data && data.predictions && data.predictions[0];
    if (!p || !p.bytesBase64Encoded) {
      await refund();
      return reply(422, { error: 'We could not make a preview from that photo. Try a clear, full-length photo with good light.' });
    }
    return reply(200, { image: `data:${p.mimeType || 'image/png'};base64,${p.bytesBase64Encoded}` });
  } catch (e) {
    console.error('tryon error:', e.name === 'AbortError' ? 'timeout' : e.message);
    await refund();
    return reply(503, { error: ON_A_BREAK, unavailable: true });
  }
};
