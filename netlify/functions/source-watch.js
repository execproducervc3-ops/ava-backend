// Scheduled: checks the watched pages that are due. Needs this in netlify.toml:
//   [functions."source-watch"]
//     schedule = "0 */3 * * *"
// Read-only toward AVA's content: it only records what changed for you to review.
const { createClient } = require('@supabase/supabase-js');
const core = require('./source-core');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async () => {
  try{
    const out = await core.runWatcher(supabase, fetch, { limit: 20, budgetMs: 20000, claudeMax: 6, apiKey: process.env.ANTHROPIC_API_KEY });
    delete out.results;
    console.log('source-watch', JSON.stringify(out));
    return { statusCode: 200, body: JSON.stringify(out) };
  } catch(e){
    console.error('source-watch failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
