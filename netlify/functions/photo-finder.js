// Scheduled daily: finds free-licence photos (Wikimedia Commons) for places and guides that
// have none, and queues them as candidates. NOTHING is published. Approve in the admin page.
const { runFinder, getSupabase } = require('./photo-core');

exports.handler = async () => {
  try {
    const summary = await runFinder(getSupabase(), fetch, { limit: 8, budgetMs: 20000 });
    console.log('photo-finder', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('photo-finder failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
