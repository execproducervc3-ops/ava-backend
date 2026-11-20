// Scheduled trigger (weekly). Research can outlast a scheduled function, so this
// only starts the background function. Needs this in netlify.toml:
//   [functions."agent-ferry"]
//     schedule = "0 10 * * 1"      # Mondays, 06:00 St Vincent time
const core = require('./agent-core');
exports.handler = async () => {
  try {
    const status = await core.triggerBackground('agent-ferry-background');
    console.log('ferry recheck triggered:', status);
    return { statusCode: 200, body: 'triggered' };
  } catch (err) {
    console.error('ferry recheck trigger failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
