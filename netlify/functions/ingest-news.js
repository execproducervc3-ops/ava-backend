const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const FEEDS = [
  { url: 'https://onenewsstvincent.com/feed/', sourceTag: 'rss:onenewsstvincent' },
  { url: 'https://www.iwnsvg.com/feed/', sourceTag: 'rss:iwnsvg' },
];

function unwrapCdata(field){
  if(field === null || field === undefined) return null;
  if(typeof field === 'string') return field;
  if(typeof field === 'object' && '__cdata' in field) return field.__cdata;
  return String(field);
}

// Deliberately does NOT store the source's own excerpt verbatim — writes an
// original, short paraphrase instead. This is the copyright-safe pattern:
// summarize in different words, don't reproduce.
async function paraphraseSummary(title, rawDescription){
  if(!rawDescription) return null;
  try{
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Article headline: "${title}"\nOriginal excerpt: "${rawDescription}"\n\nWrite a short 2-3 sentence summary of what this article is about, entirely in your own words — do not copy or closely mirror the original phrasing. Respond with only the summary, nothing else.`,
        }],
      }),
    });
    if(!res.ok) return null;
    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    return textBlock ? textBlock.text.trim() : null;
  } catch(e){
    console.error('paraphraseSummary error:', e.message);
    return null;
  }
}

async function processFeed(feedUrl, sourceTag){
  const feedResult = { source: sourceTag, fetched: 0, inserted: 0, skipped_duplicate: 0, errors: [] };

  const feedRes = await fetch(feedUrl);
  if(!feedRes.ok){
    feedResult.errors.push(`Feed fetch failed: ${feedRes.status}`);
    return feedResult;
  }
  const xml = await feedRes.text();

  const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: '__cdata' });
  const parsed = parser.parse(xml);
  const rawItems = parsed && parsed.rss && parsed.rss.channel ? parsed.rss.channel.item : null;
  const items = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
  feedResult.fetched = items.length;

  for(const item of items){
    const title = unwrapCdata(item.title);
    const url = unwrapCdata(item.link);
    const pubDateRaw = unwrapCdata(item.pubDate);
    const description = unwrapCdata(item.description);

    if(!title || !url){ continue; }

    try{
      // idempotent pre-check: skip anything already ingested
      // (source_url also has a unique index — this just avoids a wasted Claude call)
      const { data: existing } = await supabase
        .from('knowledge_articles')
        .select('id')
        .eq('source_url', url)
        .maybeSingle();
      if(existing){ feedResult.skipped_duplicate++; continue; }

      const summary = await paraphraseSummary(title, description);
      if(!summary){ feedResult.errors.push(`No summary produced for: ${title}`); continue; }

      const publishedAt = pubDateRaw ? new Date(pubDateRaw).toISOString() : null;

      const { error: insErr } = await supabase.from('knowledge_articles').insert({
        topic: title,
        body: summary,
        sensitivity_tier: 'low',
        review_status: 'published', // auto-publish: validated against real source content on 2026-08-12, spot-checked accurate
        source: sourceTag,
        source_url: url,
        published_at: publishedAt,
      });
      if(insErr){
        if(insErr.code === '23505'){ feedResult.skipped_duplicate++; } // race-safe: unique index caught a duplicate
        else { feedResult.errors.push(`Insert failed for "${title}": ${insErr.message}`); }
        continue;
      }
      feedResult.inserted++;
    } catch(itemErr){
      feedResult.errors.push(`Error processing "${title}": ${itemErr.message}`);
    }
  }

  return feedResult;
}

exports.handler = async () => {
  const bySource = [];
  const totals = { fetched: 0, inserted: 0, skipped_duplicate: 0, errors: 0 };

  for(const feed of FEEDS){
    try{
      const feedResult = await processFeed(feed.url, feed.sourceTag);
      bySource.push(feedResult);
      totals.fetched += feedResult.fetched;
      totals.inserted += feedResult.inserted;
      totals.skipped_duplicate += feedResult.skipped_duplicate;
      totals.errors += feedResult.errors.length;
    } catch(feedErr){
      console.error(`ingest-news error for ${feed.sourceTag}:`, feedErr);
      bySource.push({ source: feed.sourceTag, fetched: 0, inserted: 0, skipped_duplicate: 0, errors: [feedErr.message] });
      totals.errors += 1;
    }
  }

  return { statusCode: 200, body: JSON.stringify({ totals, bySource }) };
};
