// Copies an approved photo into AVA's own storage bucket (place-photos), so it keeps
// working even if the original site removes it. Also used for photos you upload yourself.
// Only image bytes are stored: the file type is checked from its first bytes, not its name.
const crypto = require('crypto');
const BUCKET = 'place-photos';
const MAX_BYTES = 6000000;
// Hosts the finders themselves produce. Anything else is refused when copying a candidate.
const FINDER_HOSTS = /^(inaturalist-open-data\.s3\.amazonaws\.com|static\.inaturalist\.org|api\.openverse\.org|api\.openverse\.engineering)$/i;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function isPublicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

async function downloadImage(fetchFn, url, { finderOnly }) {
  if (!isPublicHttpUrl(url)) throw new Error('That image address is not allowed.');
  if (finderOnly && !FINDER_HOSTS.test(new URL(url).hostname)) throw new Error('Unexpected image host.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetchFn(url, { signal: controller.signal, headers: { 'User-Agent': 'AVA-PhotoFinder/1.0 (+https://askvincy.com)' } });
    if (!res.ok) throw new Error(`Image download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Image is larger than 6 MB.');
    return buf;
  } finally { clearTimeout(timer); }
}

async function storeBuffer(supabase, buf, prefix) {
  const type = sniff(buf);
  if (!type) throw new Error('That file is not a JPEG, PNG or WebP image.');
  const path = `${prefix}/${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${EXT[type]}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: type, upsert: true, cacheControl: '31536000' });
  if (error) throw new Error(`Could not store the image: ${error.message}`);
  const pub = supabase.storage.from(BUCKET).getPublicUrl(path);
  const url = pub && pub.data && pub.data.publicUrl;
  if (!url) throw new Error('Could not build the stored image address.');
  return url;
}

async function mirrorRemote(supabase, fetchFn, url, prefix) {
  return storeBuffer(supabase, await downloadImage(fetchFn, url, { finderOnly: true }), prefix);
}

module.exports = { sniff, isPublicHttpUrl, downloadImage, storeBuffer, mirrorRemote, BUCKET, MAX_BYTES };
