// Background function (name ends in -background): returns 202 immediately
// and may run for up to 15 minutes. Writes drafts only, never publishes.
const core = require('./agent-core');
exports.handler = async (event) => {
  const key = (event.headers || {})['x-agent-key'];
  if (!process.env.ADMIN_SECRET || key !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  try {
    const summary = await core.runGapResearch({ limit: 3 });
    console.log('gap research done:', JSON.stringify(summary));
  } catch (err) {
    console.error('gap research failed:', err.message);
  }
  return { statusCode: 202 };
};
