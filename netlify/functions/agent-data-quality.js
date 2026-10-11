// Scheduled (weekly). Deterministic checks only, so it finishes in seconds.
const core = require('./agent-core');
exports.handler = async () => {
  try {
    const summary = await core.runDataQuality();
    console.log('data quality done:', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('data quality failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
