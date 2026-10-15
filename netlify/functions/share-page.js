// Serves the public pages behind shared links:
//   /a/<id>  a shared answer (a snapshot AVA actually wrote)
//   /l/<id>  a directory listing, shown live from the directory
// Both come in through redirects in netlify.toml.
const { createClient } = require('@supabase/supabase-js');
const core = require('./share-core');
const template = require('./share-template');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const html = (statusCode, body, extra) => ({ statusCode, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...(extra || {}) }, body });
const DEFAULT_IMAGE = `${core.SITE}/og-image.png`;

function notFound(what){
  return html(404, core.renderPage(template, {
    title: 'Not found | AVA', desc: 'This link is no longer available.', image: DEFAULT_IMAGE, url: core.SITE, robots: 'noindex',
    staticHtml: `<div class="listing"><h1>${core.esc(what)} is no longer available</h1><p>It may have expired or been removed. You can ask AVA again, and she'll find the latest.</p><div class="sharepage-btns"><a class="sharepage-cta" style="margin-left:0" href="/">Ask AVA</a></div></div>`,
    data: {},
  }), { 'Cache-Control': 'no-store' });
}

async function answerPage(id){
  if(!/^[0-9A-Za-z]{10}$/.test(id)) return notFound('That answer');
  const { data: row } = await supabase.from('shared_answers').select('id, question, payload, created_at, expires_at, hidden').eq('id', id).maybeSingle();
  if(!row || row.hidden || new Date(row.expires_at) < new Date()) return notFound('That answer');
  supabase.rpc('bump_shared_answer_views', { p_id: id }).then(() => {}, () => {});
  const d = row.payload || {};
  const when = new Date(d.at || row.created_at);
  const whenTxt = isNaN(when) ? '' : when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/St_Vincent' });
  const photo = (d.placeCards || []).find(c => core.safeHttp(c.photo_url));
  const title = d.q ? `${String(d.q).slice(0, 90)} | AVA` : 'An answer from AVA';
  const url = `${core.SITE}/a/${id}`;
  const staticHtml = `${d.q ? `<div class="msg user"><div class="bubble">${core.esc(d.q)}</div></div>` : ''}<div class="msg ava"><div class="bubble">${String(d.text || '').split(/\n{2,}/).map(p => `<p>${core.esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div></div>
    <div class="sharepage-note">Answered by AVA${whenTxt ? ' on ' + core.esc(whenTxt) : ''}. Prices, schedules and opening details can change, so check before you go.</div>
    <div class="sharepage-btns" style="justify-content:center"><button type="button" class="sharebtn" id="shareThis">&#128279; Share</button></div>`;
  // The client script re-renders the cards; keep the note and share button after it.
  return html(200, core.renderPage(template, {
    title, desc: core.plainText(d.text, 180), image: photo ? photo.photo_url : DEFAULT_IMAGE, url,
    robots: 'noindex, follow', staticHtml, data: { kind: 'a', data: d },
  }));
}

async function listingPage(id){
  if(!/^[0-9A-Za-z-]{1,64}$/.test(id)) return notFound('That listing');
  const { data: l } = await supabase.from('directory_listings')
    .select('id, name, address, island, phone, website, category, is_top_pick, top_pick_note').eq('id', id).eq('status', 'active').maybeSingle();
  if(!l) return notFound('That listing');
  const cat = String(l.category || '').replace(/_/g, ' ');
  const where = [l.address, l.island].filter(Boolean).join(', ');
  const site = core.safeHttp(l.website);
  const tel = l.phone ? String(l.phone).replace(/[^\d+]/g, '') : '';
  const url = `${core.SITE}/l/${l.id}`;
  const desc = [cat && cat[0].toUpperCase() + cat.slice(1), where, l.phone ? 'Tel ' + l.phone : ''].filter(Boolean).join(' · ') + '. Found on AVA, Ask Vincy Anything.';
  const staticHtml = `<div class="listing">
    <h1>${l.is_top_pick ? '<span style="color:var(--gold)">&#9733;</span> ' : ''}${core.esc(l.name)}</h1>
    <div class="meta">${core.esc([cat, l.island].filter(Boolean).join(' · '))}</div>
    ${l.is_top_pick && l.top_pick_note ? `<div class="pick">${core.esc(l.top_pick_note)}</div>` : ''}
    ${l.address ? `<div class="row">&#128205; ${core.esc(where)}</div>` : ''}
    ${tel ? `<div class="row">&#128222; <a href="tel:${core.esc(tel)}">${core.esc(l.phone)}</a></div>` : ''}
    ${site ? `<div class="row">&#127760; <a href="${core.esc(site)}" target="_blank" rel="noopener noreferrer">${core.esc(site.replace(/^https?:\/\//i, '').replace(/\/$/, ''))}</a></div>` : ''}
    <div class="sharepage-btns"><button type="button" class="sharebtn" id="shareThis">&#128279; Share</button>
      <a class="sharebtn" style="text-decoration:none" href="/">Ask AVA about this place</a></div>
  </div>
  <div class="sharepage-note">Listing details are checked by AVA's team but can change; please confirm before you travel.</div>`;
  const ld = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: l.name, url,
    address: { '@type': 'PostalAddress', streetAddress: l.address || undefined, addressLocality: l.island || undefined, addressCountry: 'VC' },
    telephone: l.phone || undefined, sameAs: site || undefined };
  return html(200, core.renderPage(template, { title: `${l.name} | AVA`, desc, image: DEFAULT_IMAGE, url, robots: 'index, follow', staticHtml, data: { kind: 'l' }, ld }));
}

exports.handler = async (event) => {
  try{
    const q = event.queryStringParameters || {};
    const id = decodeURIComponent(String(q.id || '').split('/')[0]);
    if(q.kind === 'a') return await answerPage(id);
    if(q.kind === 'l') return await listingPage(id);
    return notFound('That page');
  } catch(err){
    console.error('share-page error:', err);
    return html(500, 'Something went wrong. Please try again.', { 'Cache-Control': 'no-store' });
  }
};
