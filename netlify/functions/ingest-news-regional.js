// Scheduled: pulls recent Caribbean-wide news from the feeds in news-sources.js, writes a short summary in AVA's
// own words for each story, and stores it with a regional source tag. Separate from ingest-news.js (local SVG
// news) so each gets its own time budget, and so a dead regional feed can never affect local news.
const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');
const { REGIONAL_FEEDS } = require('./news-sources');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const MAX_AGE_DAYS = 7;          // ignore older stories, so a first run does not backfill a feed's whole history
const MAX_NEW_PER_FEED = 6;      // new stories summarised per feed per run
const BUDGET_MS = 24000;         // stop starting new work after this long (scheduled functions are short-lived)
const FEED_TIMEOUT_MS = 6000;

function unwrapCdata(field){
  if(field === null || field === undefined) return null;
  if(typeof field === 'string') return field;
  if(typeof field === 'object' && '__cdata' in field) return field.__cdata;
  return String(field);
}
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);

async function paraphraseSummary(title, rawDescription){
  const excerpt = stripHtml(rawDescription);
  if(!excerpt) return null;
  try{
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Article headline: "${title}"\nOriginal excerpt: "${excerpt}"\n\nWrite a short 2-3 sentence summary of what this article is about, entirely in your own words — do not copy or closely mirror the original phrasing. Respond with only the summary, nothing else.`,
        }],
      }),
    });
    if(!res.ok) return null;
    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    return textBlock ? textBlock.text.trim() : null;
  } catch(e){
    console.error('regional paraphraseSummary error:', e.message);
    return null;
  }
}

async function processFeed(feed, startedAt){
  const out = { source: feed.sourceTag, fetched: 0, inserted: 0, skipped_old: 0, skipped_duplicate: 0, errors: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  let xml;
  try{
    const res = await fetch(feed.url, { signal: ctrl.signal, headers: { 'User-Agent': 'AVA news reader (askvincy.com)' } });
    if(!res.ok){ out.errors.push(`Feed fetch failed: ${res.status}`); return out; }
    xml = await res.text();
  } catch(e){
    out.errors.push(`Feed fetch failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    return out;
  } finally { clearTimeout(timer); }

  const parsed = new XMLParser({ ignoreAttributes: false, cdataPropName: '__cdata' }).parse(xml);
  const raw = parsed && parsed.rss && parsed.rss.channel ? parsed.rss.channel.item : null;
  const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  out.fetched = items.length;
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;

  for(const item of items){
    if(out.inserted >= MAX_NEW_PER_FEED || Date.now() - startedAt > BUDGET_MS) break;
    const title = unwrapCdata(item.title);
    const url = unwrapCdata(item.link);
    const pubRaw = unwrapCdata(item.pubDate);
    if(!title || !url) continue;
    const when = pubRaw ? new Date(pubRaw) : null;
    if(!when || isNaN(when) || when.getTime() < cutoff){ out.skipped_old++; continue; }   // undated stories are skipped too
    try{
      const { data: existing } = await supabase.from('knowledge_articles').select('id').eq('source_url', url).maybeSingle();
      if(existing){ out.skipped_duplicate++; continue; }
      const summary = await paraphraseSummary(title, unwrapCdata(item.description));
      if(!summary){ out.errors.push(`No summary produced for: ${title}`); continue; }
      const { error } = await supabase.from('knowledge_articles').insert({
        topic: title, body: summary, sensitivity_tier: 'low', review_status: 'published',
        source: feed.sourceTag, source_url: url, published_at: when.toISOString(),
      });
      if(error){
        if(error.code === '23505') out.skipped_duplicate++;
        else out.errors.push(`Insert failed for "${title}": ${error.message}`);
        continue;
      }
      out.inserted++;
    } catch(e){
      out.errors.push(`Error processing "${title}": ${e.message}`);
    }
  }
  return out;
}

exports.handler = async () => {
  const startedAt = Date.now();
  const bySource = [];
  // Start from a different feed each run, so if time runs short it is not always the same feeds that miss out.
  const shift = Math.floor(new Date().getUTCHours() / 3) % REGIONAL_FEEDS.length;
  const ordered = [...REGIONAL_FEEDS.slice(shift), ...REGIONAL_FEEDS.slice(0, shift)];
  for(const feed of ordered){
    if(Date.now() - startedAt > BUDGET_MS){ bySource.push({ source: feed.sourceTag, skipped: 'out of time this run' }); continue; }
    try{ bySource.push(await processFeed(feed, startedAt)); }
    catch(e){ console.error('ingest-news-regional error for', feed.sourceTag, e); bySource.push({ source: feed.sourceTag, errors: [e.message] }); }
  }
  console.log('ingest-news-regional', JSON.stringify(bySource));
  return { statusCode: 200, body: JSON.stringify({ bySource }) };
};
