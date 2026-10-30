// Serves the public pages behind shared links:
//   /a/<id>  a shared answer (a snapshot AVA actually wrote)
//   /l/<id>  a directory listing, shown live from the directory
// Both come in through redirects in netlify.toml.
const { createClient } = require('@supabase/supabase-js');
const core = require('./share-core');
const { getBusinessPostings, ageText } = require('./business-data');

// Price answers get a preview that says what the offer is, e.g.
// "Lettuce from RB SALES, $5.00/lb, on AVA". Returns null for anything else.
function priceAnswerPreview(d){
  const groups = Array.isArray(d.retailResults) ? d.retailResults.filter(g => g && Array.isArray(g.results) && g.results.length) : [];
  if (groups.length !== 1) return null;            // shopping lists and other answers keep the normal title
  const g = groups[0];
  const offers = g.results.filter(r => r && r.retailer && Number(r.price) > 0);
  if (!offers.length) return null;
  const cheapest = offers.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
  const price = '$' + Number(cheapest.price).toFixed(2) + (cheapest.unit ? '/' + String(cheapest.unit).slice(0, 12) : '');
  const raw = String(g.product || cheapest.item_name || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  if (!raw) return null;
  const product = raw[0].toUpperCase() + raw.slice(1);
  const vendors = new Set(offers.map(r => String(r.retailer).trim().toLowerCase())).size;
  return vendors === 1
    ? { title: `${product} from ${String(cheapest.retailer).trim().slice(0, 60)}, ${price}, on AVA`, desc: 'Prices from vendors on AVA. Tap to see the vendor and send an enquiry.' }
    : { title: `${product} from ${price} at ${vendors} vendors, on AVA`, desc: 'Prices from vendors on AVA. Tap to compare and send an enquiry.' };
}
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
  const { data: row, error: readErr } = await supabase.from('shared_answers').select('id, question, payload, created_at, expires_at, hidden').eq('id', id).maybeSingle();
  if(readErr){ console.error('share-page read error:', readErr.message); throw new Error('read failed: ' + readErr.message); }
  if(!row) { console.error('share-page: no shared answer with id', id); return notFound('That answer'); }
  if(row.hidden || new Date(row.expires_at) < new Date()) return notFound('That answer');
  supabase.rpc('bump_shared_answer_views', { p_id: id }).then(() => {}, () => {});
  const d = row.payload || {};
  const when = new Date(d.at || row.created_at);
  const whenTxt = isNaN(when) ? '' : when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/St_Vincent' });
  const photo = (d.placeCards || []).find(c => core.safeHttp(c.photo_url));
  // Retailer-submitted product photos (single or multi-item lookups) also count.
  const retailFlat = (Array.isArray(d.retailResults) ? d.retailResults : []).flatMap(r => Array.isArray(r && r.results) ? r.results : [r]);
  const retailPhoto = retailFlat.find(r => r && core.safeHttp(r.photo_url));
  const shareImage = photo ? photo.photo_url : retailPhoto ? retailPhoto.photo_url : `${core.SITE}/og/a/${id}`;
  const pricePreview = priceAnswerPreview(d);
  const title = pricePreview ? pricePreview.title : core.answerTitle(d.q) + ' | AVA';
  const url = `${core.SITE}/a/${id}`;
  const staticHtml = `${d.q ? `<div class="msg user"><div class="bubble">${core.esc(d.q)}</div></div>` : ''}<div class="msg ava"><div class="bubble">${String(d.text || '').split(/\n{2,}/).map(p => `<p>${core.esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div></div>
    <div class="sharepage-note">Answered by AVA${whenTxt ? ' on ' + core.esc(whenTxt) : ''}. Prices, schedules and opening details can change, so check before you go.</div>
    <div class="sharepage-btns" style="justify-content:center">${(d.signupCard || /askvincy\.com\/#list/.test(String(d.text || ''))) ? `<a class="sharebtn" href="${core.SITE}/#list" style="text-decoration:none">List my business</a>` : ''}<button type="button" class="sharebtn" id="shareThis">&#128279; Share</button></div>`;
  // The client script re-renders the cards; keep the note and share button after it.
  return html(200, core.renderPage(template, {
    title, desc: pricePreview ? pricePreview.desc : core.plainText(d.text, 180), image: shareImage, url,
    robots: 'noindex, follow', staticHtml, data: { kind: 'a', data: d },
  }));
}

async function listingPage(id){
  if(!/^[0-9A-Za-z-]{1,64}$/.test(id)) return notFound('That listing');
  const { data: l, error: listErr } = await supabase.from('directory_listings')
    .select('id, name, address, island, phone, website, category, is_top_pick, top_pick_note, photo_url, menu_image_url, menu_updated_at, subscribed_until').eq('id', id).eq('status', 'active').maybeSingle();
  if(listErr){ console.error('share-page listing error:', listErr.message); throw new Error('read failed: ' + listErr.message); }
  if(!l) return notFound('That listing');
  const cat = String(l.category || '').replace(/_/g, ' ');
  const where = [l.address, l.island].filter(Boolean).join(', ');
  const site = core.safeHttp(l.website);
  const tel = l.phone ? String(l.phone).replace(/[^\d+]/g, '') : '';
  const url = `${core.SITE}/l/${l.id}`;
  const photo = core.safeHttp(l.photo_url);
  const desc = [cat && cat[0].toUpperCase() + cat.slice(1), where, l.phone ? 'Tel ' + l.phone : ''].filter(Boolean).join(' · ') + '. Found on AVA, Ask Vincy Anything.';
  let posts = { offers: [], events: [] };
  try { posts = await getBusinessPostings(supabase, l); } catch (e) { console.error('share-page postings error:', e.message); }
  const priceFmt = (o) => '$' + Number(o.price).toFixed(2) + (o.unit ? '/' + o.unit : '');
  const postsHtml = (posts.offers.length ? `<div class="bizposts"><h2 style="font-size:15px;margin:18px 0 6px">Current prices</h2>${posts.offers.map(o => `<div class="row" style="justify-content:space-between;align-items:center;gap:10px;${o.stale ? 'opacity:.55' : ''}">${core.safeHttp(o.photo_url) ? `<img class="photo-clickable" src="${core.esc(core.safeHttp(o.photo_url))}" data-full-photo="${core.esc(core.safeHttp(o.photo_url))}" alt="" loading="lazy" style="width:52px;height:52px;border-radius:8px;object-fit:cover">` : ''}<span style="flex:1">${core.esc(o.item_name)}<br><small style="color:var(--soft)">${core.esc(ageText(o.age_days))}</small></span><b>${core.esc(priceFmt(o))}</b></div>`).join('')}</div>` : '')
    + (posts.events.length ? `<div class="bizposts"><h2 style="font-size:15px;margin:18px 0 6px">Upcoming events</h2>${posts.events.map(ev => `<div class="row" style="display:block"><b>${core.esc(ev.title)}</b><br><small style="color:var(--soft)">${core.esc([ev.when, ev.venue].filter(Boolean).join(' · '))}</small></div>`).join('')}</div>` : '');
  const menuUrl = posts.subscribed ? core.safeHttp(l.menu_image_url) : '';
  const menuHtml = menuUrl ? `<div class="bizposts"><h2 style="font-size:15px;margin:18px 0 6px">Menu</h2><img class="listing-photo" style="max-height:none;height:auto;object-fit:contain;width:100%;border-radius:12px" src="${core.esc(menuUrl)}" alt="${core.esc(l.name)} menu"><p style="margin:6px 0 0;font-size:12px"><a href="${core.esc(menuUrl)}" target="_blank" rel="noopener noreferrer">Open full size</a></p><p style="margin:10px 0 0"><a class="sharebtn" style="text-decoration:none;background:var(--teal);color:#fff;border-color:var(--teal)" href="/?order=${encodeURIComponent(l.id)}">Place order</a></p></div>` : '';
  const staticHtml = `<div class="listing">
    ${photo ? `<img class="listing-photo photo-clickable" src="${core.esc(photo)}" data-full-photo="${core.esc(photo)}" alt="${core.esc(l.name)}">` : ''}
    <h1>${l.is_top_pick ? '<span style="color:var(--gold)">&#9733;</span> ' : ''}${core.esc(l.name)}</h1>
    <div class="meta">${core.esc([cat, l.island].filter(Boolean).join(' · '))}</div>
    ${l.is_top_pick && l.top_pick_note ? `<div class="pick">${core.esc(l.top_pick_note)}</div>` : ''}
    ${l.address ? `<div class="row">&#128205; ${core.esc(where)}</div>` : ''}
    ${tel ? `<div class="row">&#128222; <a href="tel:${core.esc(tel)}">${core.esc(l.phone)}</a></div>` : ''}
    ${site ? `<div class="row">&#127760; <a href="${core.esc(site)}" target="_blank" rel="noopener noreferrer">${core.esc(site.replace(/^https?:\/\//i, '').replace(/\/$/, ''))}</a></div>` : ''}
    <div class="sharepage-btns"><button type="button" class="sharebtn" id="shareThis">&#128279; Share</button>
      <a class="sharebtn" style="text-decoration:none" href="/">Ask AVA about this place</a></div>
    ${menuHtml}
    ${postsHtml}
  </div>
  <div class="sharepage-note">Listing details are checked by AVA's team but can change; please confirm before you travel.</div>`;
  const ld = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: l.name, url,
    address: { '@type': 'PostalAddress', streetAddress: l.address || undefined, addressLocality: l.island || undefined, addressCountry: 'VC' },
    telephone: l.phone || undefined, sameAs: site || undefined, image: photo || undefined };
  return html(200, core.renderPage(template, { title: menuUrl ? `${l.name} menu | AVA` : `${l.name} | AVA`, desc, image: menuUrl || photo || `${core.SITE}/og/l/${l.id}`, url, robots: 'index, follow', staticHtml, data: { kind: 'l' }, ld }));
}

exports.handler = async (event) => {
  try{
    const q = event.queryStringParameters || {};
    let kind = q.kind, id = String(q.id || '').split('/')[0];
    // Netlify may not fill the id into the redirect's query string, so also read it from the address that was opened.
    if(!kind || !id || id.startsWith(':')){
      let p = '';
      try{ p = new URL(event.rawUrl).pathname; } catch(e){ p = event.path || ''; }
      const m = p.match(/\/(a|l)\/([^/?#]+)/);
      if(m){ kind = m[1]; id = m[2]; }
    }
    id = decodeURIComponent(id);
    if(kind === 'a') return await answerPage(id);
    if(kind === 'l') return await listingPage(id);
    return notFound('That page');
  } catch(err){
    console.error('share-page error:', err);
    return html(500, `<!doctype html><meta charset="utf-8"><title>Error | AVA</title><p style="font-family:sans-serif;padding:24px">Something went wrong loading this page. Please try again in a moment.<br><small>${core.esc(String(err.message || '').slice(0, 160))}</small></p>`, { 'Cache-Control': 'no-store' });
  }
};
