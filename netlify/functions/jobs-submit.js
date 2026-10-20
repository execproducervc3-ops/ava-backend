// Public: a customer posts a job. It stays 'pending' until the dispatcher approves it.
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const mirror = require('./photo-mirror');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const ISLANDS = ['Saint Vincent', 'Bequia', 'Mustique', 'Canouan', 'Mayreau', 'Union Island', 'Palm Island', 'Petit Saint Vincent', 'Tobago Cays'];
const CATEGORIES = ['trucking', 'taxi'];
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 3000000;
const DAILY_PER_NUMBER = 3;   // jobs one WhatsApp number may post per 24 hours
const DAILY_PER_IP = 6;       // jobs one connection may post per 24 hours

const reply = (code, obj) => ({ statusCode: code, headers: CORS, body: JSON.stringify(obj) });
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function normaliseNumber(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 7) return '1784' + d;          // local St Vincent number
  if (d.length >= 10 && d.length <= 15) return d;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Bad request.' }); }

  const description = clip(b.description, 800);
  if (description.length < 10) return reply(400, { error: 'Please describe what you need in a sentence or two.' });
  if (!CATEGORIES.includes(b.category)) return reply(400, { error: 'Choose trucking or taxi service.' });
  const island = ISLANDS.find(i => i.toLowerCase() === String(b.island || '').trim().toLowerCase());
  if (!island) return reply(400, { error: 'Choose an island.' });
  const number = normaliseNumber(b.whatsapp);
  if (!number) return reply(400, { error: 'Enter your WhatsApp number, with the country code (for example +1 784 555 0123).' });
  if (b.terms !== true) return reply(400, { error: 'Please tick the box to confirm you understand AVA only introduces customers and providers.' });

  const photos = Array.isArray(b.photos) ? b.photos.slice(0, MAX_PHOTOS) : [];
  const buffers = [];
  for (const p of photos) {
    const buf = Buffer.from(String((p && p.data) || ''), 'base64');
    if (!buf.length) continue;
    if (buf.length > MAX_PHOTO_BYTES) return reply(400, { error: 'A photo is too large. Please use photos under 3 MB.' });
    if (!mirror.sniff(buf)) return reply(400, { error: 'Photos must be JPEG, PNG or WebP.' });
    buffers.push(buf);
  }

  const ip = String((event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || '').split(',')[0].trim();
  const ipHash = ip ? crypto.createHash('sha256').update(ip + '|' + (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(-12)).digest('hex').slice(0, 24) : null;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const byNumber = await supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('whatsapp_number', number).gte('created_at', since);
  if ((byNumber.count || 0) >= DAILY_PER_NUMBER) return reply(429, { error: 'You have posted the maximum number of jobs for today. Please try again tomorrow.' });
  if (ipHash) {
    const byIp = await supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('created_at', since);
    if ((byIp.count || 0) >= DAILY_PER_IP) return reply(429, { error: 'Too many jobs posted from this connection today. Please try again tomorrow.' });
  }

  let urls = [];
  try {
    for (const buf of buffers) urls.push(await mirror.storeBuffer(supabase, buf, 'jobs'));
  } catch (e) { return reply(400, { error: e.message }); }

  const token = crypto.randomBytes(18).toString('base64url');
  const { error } = await supabase.from('jobs').insert({
    token, description, category: b.category, island,
    from_place: clip(b.from, 120) || null, to_place: clip(b.to, 120) || null,
    when_text: clip(b.when, 120) || null, budget_text: clip(b.budget, 60) || null,
    via_whatsapp: true, via_telegram: false, whatsapp_number: number,
    photos: urls, ip_hash: ipHash,
  });
  if (error) { console.error('jobs insert failed:', error.message); return reply(500, { error: 'Could not save your job. Please try again.' }); }
  return reply(200, { ok: true, message: 'Thank you. AVA will check your job, then send your private link on WhatsApp.' });
};
