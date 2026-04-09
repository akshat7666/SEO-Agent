const pLimitModule = require('p-limit');

const pLimit = pLimitModule.default || pLimitModule;

/**
 * Map an array of items through an async mapper with controlled concurrency
 * Uses p-limit for more reliable concurrent task execution
 */
async function mapWithConcurrency(items, limit, mapper) {
  const concurrency = Math.max(1, Number(limit) || 1);
  const limiter = pLimit(concurrency);
  
  const promises = items.map((item, index) => 
    limiter(() => mapper(item, index))
  );
  
  return Promise.all(promises);
}

module.exports = { mapWithConcurrency };
