const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

async function checkAuth(providedPassword){
  const { data: authRow } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const storedHash = authRow ? authRow.password_hash : null;
  return storedHash && providedPassword && await bcrypt.compare(providedPassword, storedHash);
}

// Real Claude + web_search research call, same mechanism already proven
// tonight for scholarships and reference knowledge — never writes to any
// table directly, only ever returns a draft for a human to review.
async function callClaudeWithSearch(prompt){
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20260209', name: 'web_search' }, { type: 'code_execution_20260120', name: 'code_execution' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if(!res.ok) throw new Error(`Anthropic request failed: ${res.status}`);
  const data = await res.json();
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const jsonMatch = textBlocks.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if(!jsonMatch) throw new Error('No JSON found in research response');
  return JSON.parse(jsonMatch[0]);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const providedPassword = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  if (!(await checkAuth(providedPassword))) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (event.httpMethod === 'GET' && action === 'list_gaps') {
      const { data: rows, error } = await supabase
        .from('unanswered_queries')
        .select('query_text, category_guess')
        .eq('resolved', false)
        .order('occurred_at', { ascending: false })
        .limit(2000);
      if (error) throw error;

      // Exact-text grouping only — a known, honest limitation, not hidden.
      const grouped = new Map();
      for (const row of (rows || [])) {
        const key = row.query_text.trim().toLowerCase();
        if (!grouped.has(key)) grouped.set(key, { query_text: row.query_text, category_guess: row.category_guess, count: 0 });
        grouped.get(key).count += 1;
      }
      const results = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 30);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results }) };
    }

    if (event.httpMethod === 'POST' && action === 'research') {
      const body = JSON.parse(event.body || '{}');
      const { query_text, category_guess } = body;
      if (!query_text) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'query_text is required' }) };

      const isPoi = (category_guess || '').includes('points_of_interest') || (category_guess || '').includes('directory');

      const prompt = isPoi
        ? `Research real, verifiable places in Saint Vincent and the Grenadines related to this gap in our database: "${query_text}". Use web search across multiple independent sources. Return ONLY a JSON array, no other text, of objects shaped exactly like: [{"name": "...", "category": "beach|hiking_trail|waterfall|historic_site|marine_park|garden", "island": "...", "description": "2-4 sentences, original synthesis in your own words, not copied text", "source_url": "..."}]. Return between 1 and 5 places — only what real search results genuinely support. If a place is only mentioned in passing with thin detail, still include it but say so honestly in the description rather than padding it out.`
        : `Research this gap in our Saint Vincent and the Grenadines knowledge base: "${query_text}". Use web search across multiple independent sources. Return ONLY a JSON object, no other text, shaped exactly like: {"category": "geography|history|government|culture|economy|practical|music", "title": "...", "summary": "3-5 sentences, original synthesis in your own words, not copied text", "source_url": "..."}.`;

      const draft = await callClaudeWithSearch(prompt);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ draft, is_poi: isPoi }) };
    }

    if (event.httpMethod === 'POST' && action === 'publish_poi') {
      const body = JSON.parse(event.body || '{}');
      const { places, query_text } = body;
      if (!Array.isArray(places) || !places.length) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'places array is required' }) };
      }

      // Explicit check-then-insert-or-update rather than relying on Supabase's
      // client to correctly forward a functional-index conflict target
      // (the real unique index is on lower(name), island) — this is fully
      // testable and doesn't depend on an unverified pass-through behavior.
      let publishedCount = 0;
      for (const p of places) {
        const { data: existing } = await supabase
          .from('points_of_interest')
          .select('id')
          .ilike('name', p.name)
          .eq('island', p.island)
          .maybeSingle();

        const row = {
          name: p.name, category: p.category, island: p.island, description: p.description,
          source_url: p.source_url || null, last_verified_at: new Date().toISOString(), active: true,
        };

        if (existing) {
          const { error } = await supabase.from('points_of_interest').update(row).eq('id', existing.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from('points_of_interest').insert(row);
          if (error) throw error;
        }
        publishedCount += 1;
      }

      if (query_text) {
        await supabase.from('unanswered_queries').update({ resolved: true }).ilike('query_text', query_text);
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, published: publishedCount }) };
    }

    if (event.httpMethod === 'POST' && action === 'publish_reference') {
      const body = JSON.parse(event.body || '{}');
      const { category, title, summary, source_url, query_text } = body;
      if (!category || !title || !summary) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'category, title, and summary are required' }) };
      }
      const { error } = await supabase.from('reference_knowledge')
        .upsert({ category, title, summary, source_url: source_url || null, last_verified_at: new Date().toISOString(), active: true }, { onConflict: 'category' });
      if (error) throw error;

      if (query_text) {
        await supabase.from('unanswered_queries').update({ resolved: true }).ilike('query_text', query_text);
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST' && action === 'dismiss') {
      const body = JSON.parse(event.body || '{}');
      if (!body.query_text) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'query_text is required' }) };
      const { error } = await supabase.from('unanswered_queries').update({ resolved: true }).ilike('query_text', body.query_text);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('admin-research error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
