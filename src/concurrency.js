async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  const concurrency = Math.max(1, Number(limit) || 1);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = { mapWithConcurrency };
