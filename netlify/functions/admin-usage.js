// Admin API: AVA usage numbers for the admin Usage panel. Read-only.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

// ESTIMATE ONLY. US dollars per million tokens for the chat model (Sonnet 5.5),
// and per web search. Edit these if prices change; the Anthropic Console shows
// the real bill. Covers AVA chat only, not the research agents or Telegram bot.
const PRICE = { input: 2, output: 10, cacheWrite: 4, cacheRead: 0.1, perSearch: 0.01 };
const costOf = d =>
  (d.input_tokens * PRICE.input + d.output_tokens * PRICE.output +
   d.cache_write_tokens * PRICE.cacheWrite + d.cache_read_tokens * PRICE.cacheRead) / 1e6 +
  d.web_searches * PRICE.perSearch;

async function checkAuth(pw){
  const { data } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = data ? data.password_hash : null;
  return !!(hash && pw && await bcrypt.compare(pw, hash));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const pw = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if (!(await checkAuth(pw))) return json(401, { error: 'Unauthorized' });

  try {
    const { data, error } = await supabase.rpc('usage_summary');
    if (error) throw error;
    const s = data || {};
    const num = v => Number(v || 0);
    const daily = (s.daily || []).map(d => {
      const row = {
        day: d.day, questions: num(d.questions), failures: num(d.failures), visitors: num(d.visitors),
        input_tokens: num(d.input_tokens), output_tokens: num(d.output_tokens),
        cache_read_tokens: num(d.cache_read_tokens), cache_write_tokens: num(d.cache_write_tokens), web_searches: num(d.web_searches),
      };
      row.est_cost = Math.round(costOf(row) * 100) / 100;
      return row;
    });
    const today = s.today;
    const addDays = (iso, n) => new Date(new Date(iso + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
    const sumCost = fromDay => Math.round(daily.filter(d => d.day >= fromDay).reduce((a, d) => a + d.est_cost, 0) * 100) / 100;
    const w = s.windows || {};
    const pct = (f, q) => q ? Math.round(f / q * 1000) / 10 : 0;
    return json(200, {
      today,
      questions: { today: num(w.q_today), week: num(w.q_week), month: num(w.q_month) },
      visitors: { today: num(w.v_today), week: num(w.v_week), month: num(w.v_month) },
      failure_rate_pct: { today: pct(num(w.fail_today), num(w.q_today)), week: pct(num(w.fail_week), num(w.q_week)), month: pct(num(w.fail_month), num(w.q_month)) },
      est_cost_usd: { today: sumCost(today), week: sumCost(addDays(today, -6)), month: sumCost(addDays(today, -29)) },
      tools: (s.tools || []).map(t => ({ tool: t.tool, uses: num(t.uses) })),
      daily: daily.slice(0, 14),
      businesses: (s.businesses || []).map(b => ({
        listing_id: b.listing_id, name: b.name || '(removed listing)', island: b.island, kind: b.kind,
        subscribed_until: b.subscribed_until, shown_7d: num(b.shown_7d), shown_30d: num(b.shown_30d), visitors_30d: num(b.visitors_30d),
      })),
      note: 'Cost is an estimate for AVA chat only. The Anthropic Console has the real bill.',
    });
  } catch (err) {
    console.error('admin-usage error:', err);
    return json(500, { error: err.message });
  }
};
