// Draws the preview picture for a shared answer or listing: /og/a/<id> and /og/l/<id>.
// If anything is missing (package, font, row) it falls back to the standard AVA picture, so links never break.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const core = require('./share-core');
const { cardSvg } = require('./og-card');

const FALLBACK = `${core.SITE}/og-image.png`;
const fallback = () => ({ statusCode: 302, headers: { Location: FALLBACK, 'Cache-Control': 'no-store' }, body: '' });

function fontFiles(){
  const dirs = [path.join(__dirname, 'fonts'), process.env.LAMBDA_TASK_ROOT && path.join(process.env.LAMBDA_TASK_ROOT, 'netlify/functions/fonts'), process.env.LAMBDA_TASK_ROOT && path.join(process.env.LAMBDA_TASK_ROOT, 'fonts')].filter(Boolean);
  for(const d of dirs){
    const f = ['Inter-Regular.ttf', 'Inter-Bold.ttf'].map(n => path.join(d, n));
    if(f.every(x => fs.existsSync(x))) return f;
  }
  return null;
}

// Only photos stored in AVA's own storage are ever fetched for a card.
async function fetchPhoto(url){
  try{
    const u = new URL(String(url || '')), host = new URL(process.env.SUPABASE_URL).host;
    if(u.protocol !== 'https:' || u.host !== host) return null;
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 3000);
    let r; try{ r = await fetch(u.href, { signal: ctrl.signal }); } finally { clearTimeout(t); }
    if(!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if(!buf.length || buf.length > 3000000) return null;
    const type = buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg' : (buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : null);
    return type ? `data:${type};base64,${buf.toString('base64')}` : null;
  } catch(e){ return null; }
}

async function cardFor(kind, id){
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  if(kind === 'a'){
    if(!/^[0-9A-Za-z]{10}$/.test(id)) return null;
    const { data: r } = await supabase.from('shared_answers').select('payload, expires_at, hidden').eq('id', id).maybeSingle();
    if(!r || r.hidden || new Date(r.expires_at) < new Date()) return null;
    const d = r.payload || {};
    const clean = (t) => core.decodeEntities(t || '').replace(/\s+/g, ' ').trim();

    // 1. A price answer: the product, the cheapest price, and its photo
    const groups = Array.isArray(d.retailResults) ? d.retailResults.filter(g => g && Array.isArray(g.results) && g.results.length) : [];
    if(groups.length === 1){
      const g = groups[0];
      const offers = g.results.filter(x => x && x.retailer && Number(x.price) > 0);
      if(offers.length){
        const cheapest = offers.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
        const vendors = new Set(offers.map(x => String(x.retailer).trim().toLowerCase())).size;
        const raw = clean(g.product || cheapest.item_name);
        const product = raw ? raw[0].toUpperCase() + raw.slice(1) : 'Prices on AVA';
        const amount = '$' + Number(cheapest.price).toFixed(2) + (cheapest.unit ? '/' + String(cheapest.unit).slice(0, 12) : '');
        return {
          type: 'price', kicker: 'Prices on AVA', title: product,
          body: vendors === 1 ? clean(cheapest.item_name) : `Compared across ${vendors} vendors`,
          price: { amount, lead: vendors > 1 ? 'FROM' : 'PRICE', note: vendors === 1 ? clean(cheapest.retailer) : 'at ' + clean(cheapest.retailer) },
          photo: await fetchPhoto(cheapest.photo_url),
        };
      }
    }
    // 2. A news answer: lead headline, two more, and today's date
    const news = Array.isArray(d.newsResults) ? d.newsResults.filter(x => x && x.topic) : [];
    if(news.length){
      const when = new Date(d.at || Date.now());
      const ok = !isNaN(when);
      const fmt = (o) => ok ? when.toLocaleDateString('en-GB', { timeZone: 'America/St_Vincent', ...o }) : '';
      return {
        type: 'news', kicker: 'News', title: clean(news[0].topic),
        items: news.slice(1, 4).map(x => clean(x.topic)), more: Math.max(0, news.length - 4),
        dateTile: ok ? { day: fmt({ day: 'numeric' }), mon: fmt({ month: 'short' }).toUpperCase().replace('.', ''), year: fmt({ year: 'numeric' }) } : null,
      };
    }
    // 3. Anything else
    const pv = core.answerPreview(d);
    return { type: 'answer', kicker: 'AVA Answer', title: pv ? pv.title.replace(/(, on AVA| \| AVA)$/, '') : core.answerTitle(d.q), body: (pv && pv.desc) || core.plainText(d.text, 220) };
  }
  if(kind === 'l'){
    if(!/^[0-9A-Za-z-]{1,64}$/.test(id)) return null;
    const { data: l } = await supabase.from('directory_listings').select('name, address, island, phone, category, photo_url').eq('id', id).eq('status', 'active').maybeSingle();
    if(!l) return null;
    return {
      type: 'listing', kicker: String(l.category || '').replace(/_/g, ' ') || 'Local business', title: l.name,
      body: [l.address, l.island, l.phone].filter(Boolean).join('  ·  '),
      photo: await fetchPhoto(l.photo_url),
    };
  }
  return null;
}

exports.handler = async (event) => {
  try{
    const q = event.queryStringParameters || {};
    let kind = q.kind, id = String(q.id || '').split('/')[0];
    if(!kind || !id || id.startsWith(':')){
      let p = ''; try{ p = new URL(event.rawUrl).pathname; } catch(e){ p = event.path || ''; }
      const m = p.match(/\/og\/(a|l)\/([^/?#]+)/); if(m){ kind = m[1]; id = m[2]; }
    }
    const card = await cardFor(kind, decodeURIComponent(id));
    const fonts = fontFiles();
    if(!card || !fonts) return fallback();
    const { Resvg } = require('@resvg/resvg-js');
    const svg = cardSvg(card);
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
    return { statusCode: 200, isBase64Encoded: true, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }, body: Buffer.from(png).toString('base64') };
  } catch(err){
    console.error('share-image error:', err.message);
    return fallback();
  }
};
