// Background function (name ends in -background): returns 202 at once, may run up to 15 minutes.
// Drafts changes for a human to approve; only re-stamps rows that a source confirms exactly.
const { createClient } = require('@supabase/supabase-js');
const ferry = require('./ferry-core');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
exports.handler = async (event) => {
  const key = (event.headers || {})['x-agent-key'];
  if (!process.env.ADMIN_SECRET || key !== process.env.ADMIN_SECRET) return { statusCode: 401, body: 'Unauthorized' };
  try {
    const summary = await ferry.run({
      store: ferry.makeStore(supabase),
      claude: ferry.makeClaude(process.env.ANTHROPIC_API_KEY),
      travelPal: ferry.makeTravelPalCheck(),
    });
    console.log('ferry recheck done:', JSON.stringify(summary));
  } catch (err) {
    console.error('ferry recheck failed:', err.message);
  }
  return { statusCode: 202 };
};
