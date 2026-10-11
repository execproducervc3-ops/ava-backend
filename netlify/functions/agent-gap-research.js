// Scheduled trigger (daily). Research takes longer than a scheduled
// function may run, so this only starts the background function.
const core = require('./agent-core');
exports.handler = async () => {
  try {
    const status = await core.triggerBackground('agent-gap-research-background');
    console.log('gap research triggered:', status);
    return { statusCode: 200, body: 'triggered' };
  } catch (err) {
    console.error('gap research trigger failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
