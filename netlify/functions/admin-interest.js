const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Reusable core logic, deliberately independent of HTTP or any particular
// delivery mechanism — this is what a future MCP tool would call directly,
// the same way AVA's other query functions (queryRetailPriceDB etc.) are
// already shared between the conversational tool-use loop and whatever
// else might need them later.
async function getProductInterestSummary(){
  // Aggregate only — raw device hashes never leave this function, only the
  // resulting counts. Grouping in JS since Supabase's query builder doesn't
  // support COUNT(DISTINCT ...) directly.
  const { data: rows, error } = await supabase
    .from('product_interest_log')
    .select('search_term, device_id_hash, canonical_products(name)')
    .order('searched_at', { ascending: false })
    .limit(5000);
  if (error) throw error;

  const byProduct = new Map();
  for (const row of (rows || [])) {
    const label = (row.canonical_products && row.canonical_products.name) || row.search_term;
    if (!byProduct.has(label)) byProduct.set(label, { total: 0, devices: new Set() });
    const entry = byProduct.get(label);
    entry.total += 1;
    entry.devices.add(row.device_id_hash);
  }

  return [...byProduct.entries()]
    .map(([product, entry]) => ({ product, total_searches: entry.total, distinct_visitors: entry.devices.size }))
    .sort((a, b) => b.total_searches - a.total_searches);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const providedPassword = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  const { data: authRow } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const storedHash = authRow ? authRow.password_hash : null;
  const isValid = storedHash && providedPassword && await bcrypt.compare(providedPassword, storedHash);
  if (!isValid) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const results = await getProductInterestSummary();
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ results }) };
  } catch (err) {
    console.error('admin-interest error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

// Exported alongside the handler specifically so this can be reused directly
// by a future MCP server tool, without going through HTTP or duplicating
// the aggregation logic.
exports.getProductInterestSummary = getProductInterestSummary;
