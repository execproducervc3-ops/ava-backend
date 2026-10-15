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

async function cardFor(kind, id){
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  if(kind === 'a'){
    if(!/^[0-9A-Za-z]{10}$/.test(id)) return null;
    const { data: r } = await supabase.from('shared_answers').select('payload, expires_at, hidden').eq('id', id).maybeSingle();
    if(!r || r.hidden || new Date(r.expires_at) < new Date()) return null;
    const d = r.payload || {};
    return { kicker: 'AVA · Answer', title: core.answerTitle(d.q), body: core.plainText(d.text, 220) };
  }
  if(kind === 'l'){
    if(!/^[0-9A-Za-z-]{1,64}$/.test(id)) return null;
    const { data: l } = await supabase.from('directory_listings').select('name, address, island, phone, category').eq('id', id).eq('status', 'active').maybeSingle();
    if(!l) return null;
    return { kicker: [String(l.category || '').replace(/_/g, ' '), l.island].filter(Boolean).join(' · ') || 'AVA · Listing', title: l.name, body: [l.address, l.phone].filter(Boolean).join('  ·  ') };
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
    const svg = cardSvg({ ...card, footer: 'askvincy.com  ·  Ask Vincy Anything' });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
    return { statusCode: 200, isBase64Encoded: true, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }, body: Buffer.from(png).toString('base64') };
  } catch(err){
    console.error('share-image error:', err.message);
    return fallback();
  }
};
