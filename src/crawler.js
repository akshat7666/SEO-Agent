const db = require('./database');
const { getRootDomain, getSubdomain, normalizeUrl, parseSitemap, parseRobotsTxt, discoverFromPage } = require('./discovery');
const { extractPageData, closeBrowser } = require('./extractor');
const { validatePage } = require('./validator');
const { calculateScore } = require('./scorer');
const { mapWithConcurrency } = require('./concurrency');

const crawlState = {};
const MAX_PAGES = 1500;
const DEFAULT_DISCOVERY_CONCURRENCY = 5;
const DEFAULT_CRAWL_CONCURRENCY = 5;
const MAX_DISCOVERY_CONCURRENCY = 10;
const MAX_CRAWL_CONCURRENCY = 8;
const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 4;
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ERRORS = 250;

function getOrCreateState(sessionId) {
  if (!crawlState[sessionId]) {
    crawlState[sessionId] = {
      status: 'running',
      phase: 'queued',
      discovered: new Set(),
      crawled: new Set(),
      errors: 0,
      startTime: Date.now(),
      workerPromise: null
    };
  }
  return crawlState[sessionId];
}

function normalizeDiscoveredUrl(url, baseUrl) {
  if (!url) return null;
  return normalizeUrl(url, baseUrl || url);
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(numeric, max));
}

function shouldStopEarly(state, stats, options) {
  const elapsed = Date.now() - state.startTime;
  if (elapsed >= options.maxDurationMs) {
    state.phase = 'timed_out';
    return true;
  }

  const errors = Number(stats.errors) || 0;
  if (errors >= options.maxErrors) {
    state.phase = 'error_threshold';
    return true;
  }

  return false;
}

async function discoverUrls(targetUrl, rootDomain, maxPages, discoveryConcurrency) {
  const discovered = new Set();
  const robots = await parseRobotsTxt(targetUrl);
  const sitemapUrls = await parseSitemap(targetUrl);

  for (const url of sitemapUrls) {
    const normalized = normalizeDiscoveredUrl(url, targetUrl);
    if (normalized && discovered.size < maxPages) discovered.add(normalized);
  }

  for (const sitemapUrl of robots.sitemaps || []) {
    if (discovered.size >= maxPages) break;
    try {
      const extraUrls = await parseSitemap(sitemapUrl);
      for (const url of extraUrls) {
        const normalized = normalizeDiscoveredUrl(url, sitemapUrl);
        if (normalized && discovered.size < maxPages) discovered.add(normalized);
      }
    } catch (error) {
      // Ignore extra sitemap failures.
    }
  }

  const seedUrl = normalizeUrl(targetUrl, targetUrl);
  if (seedUrl) discovered.add(seedUrl);

  const queue = seedUrl ? [seedUrl] : [];
  const visited = new Set();

  while (queue.length > 0 && discovered.size < maxPages) {
    const batch = queue.splice(0, discoveryConcurrency);

    const batchResults = await mapWithConcurrency(batch, discoveryConcurrency, async (pageUrl) => {
      if (visited.has(pageUrl)) return [];
      visited.add(pageUrl);
      return discoverFromPage(pageUrl, rootDomain);
    });

    for (const links of batchResults) {
      for (const link of links) {
        const normalized = normalizeDiscoveredUrl(link, targetUrl);
        if (!normalized || discovered.has(normalized) || discovered.size >= maxPages) continue;
        discovered.add(normalized);
        queue.push(normalized);
      }
    }
  }

  return [...discovered];
}

async function processClaimedPage(sessionId, page, options) {
  const state = getOrCreateState(sessionId);
  let lastError = null;

  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      const data = await extractPageData(page.original_url);
      const issues = validatePage({
        title: data.title,
        metaDescription: data.metaDescription,
        h1Text: data.h1Text,
        h1Count: data.h1Count,
        h2Count: data.h2Count,
        canonicalUrl: data.canonicalUrl,
        wordCount: data.wordCount,
        schemaJson: data.schemaJson,
        ogTags: data.ogTags,
        internalLinksCount: data.internalLinksCount,
        externalLinksCount: data.externalLinksCount,
        loadTimeMs: data.loadTimeMs,
        statusCode: data.statusCode,
        finalUrl: data.finalUrl,
        originalUrl: page.original_url,
        imageCount: data.imageCount,
        imagesMissingAltCount: data.imagesMissingAltCount,
        imagesWithAltCount: data.imagesWithAltCount,
        brokenInternalLinksCount: data.brokenInternalLinksCount,
        brokenExternalLinksCount: data.brokenExternalLinksCount,
        headingStructureScore: data.headingStructureScore,
        pageType: data.pageType
      });

      const scoreResult = calculateScore({ ...data, originalUrl: page.original_url }, issues);

      await db.updatePage(sessionId, page.original_url, {
        final_url: data.finalUrl,
        status_code: data.statusCode,
        is_redirect: data.isRedirect ? 1 : 0,
        redirect_chain: data.redirectChain.length > 0 ? JSON.stringify(data.redirectChain) : null,
        title: data.title,
        title_length: data.titleLength,
        meta_description: data.metaDescription,
        meta_description_length: data.metaDescriptionLength,
        h1_text: data.h1Text,
        h1_count: data.h1Count,
        h2_count: data.h2Count,
        h3_count: data.h3Count,
        h4_count: data.h4Count,
        h5_count: data.h5Count,
        h6_count: data.h6Count,
        heading_structure_score: data.headingStructureScore,
        canonical_url: data.canonicalUrl,
        word_count: data.wordCount,
        schema_json: JSON.stringify(data.schemaJson || []),
        og_tags: JSON.stringify(data.ogTags || {}),
        internal_links_count: data.internalLinksCount,
        external_links_count: data.externalLinksCount,
        broken_internal_links_count: data.brokenInternalLinksCount,
        broken_external_links_count: data.brokenExternalLinksCount,
        image_count: data.imageCount,
        images_missing_alt_count: data.imagesMissingAltCount,
        images_with_alt_count: data.imagesWithAltCount,
        page_type: data.pageType,
        load_time_ms: data.loadTimeMs,
        score: scoreResult.total,
        score_breakdown: JSON.stringify(scoreResult.breakdown),
        issues: JSON.stringify(issues),
        crawl_status: 'done',
        error_message: null,
        last_crawled: new Date().toISOString()
      });

      state.crawled.add(page.original_url);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < options.retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  state.errors += 1;
  await db.updatePage(sessionId, page.original_url, {
    crawl_status: 'error',
    error_message: lastError ? lastError.message : 'Unknown extraction error',
    last_crawled: new Date().toISOString()
  });
}

async function finalizeSession(sessionId) {
  const finalStats = await db.getSessionStats(sessionId);
  await db.updateSession(sessionId, {
    status: 'completed',
    total_crawled: finalStats.crawled || 0,
    total_errors: finalStats.errors || 0,
    avg_score: Math.round(finalStats.avg_score || 0),
    site_score: Math.round(finalStats.avg_score || 0),
    completed_at: new Date().toISOString()
  });
}

async function runSessionWorker(sessionId, options = {}) {
  const state = getOrCreateState(sessionId);
  if (state.workerPromise && !options.singleBatch) {
    return state.workerPromise;
  }

  const worker = (async () => {
    state.phase = 'crawling';

    do {
      const claimedPages = await db.claimPendingPages(sessionId, options.crawlConcurrency);
      if (claimedPages.length === 0) break;

      await mapWithConcurrency(claimedPages, options.crawlConcurrency, (page) =>
        processClaimedPage(sessionId, page, options)
      );

      const stats = await db.getSessionStats(sessionId);
      await db.updateSession(sessionId, {
        total_crawled: stats.crawled || 0,
        total_errors: stats.errors || 0,
        avg_score: Math.round(stats.avg_score || 0),
        site_score: Math.round(stats.avg_score || 0)
      });

      if (shouldStopEarly(state, stats, options)) {
        break;
      }

      if (options.singleBatch) break;
    } while (true);

    if (!options.singleBatch) {
      state.phase = 'finalizing';
      await finalizeSession(sessionId);
      state.status = 'completed';
      state.phase = 'done';
    }
  })()
    .catch(async (error) => {
      state.status = 'error';
      state.phase = 'error';
      await db.updateSession(sessionId, { status: 'error' });
      console.error(`[Crawler] Worker error for ${sessionId}:`, error.message);
      throw error;
    })
    .finally(async () => {
      if (!options.singleBatch) {
        state.workerPromise = null;
      }
      await closeBrowser();
    });

  if (!options.singleBatch) {
    state.workerPromise = worker;
  }

  return worker;
}

async function startCrawl(targetUrl, sessionId, options = {}) {
  const maxPages = clampNumber(options.maxPages, MAX_PAGES, 1, MAX_PAGES);
  const discoveryConcurrency = clampNumber(options.discoveryConcurrency, DEFAULT_DISCOVERY_CONCURRENCY, 1, MAX_DISCOVERY_CONCURRENCY);
  const crawlConcurrency = clampNumber(options.crawlConcurrency, DEFAULT_CRAWL_CONCURRENCY, 1, MAX_CRAWL_CONCURRENCY);
  const retries = clampNumber(options.retries, DEFAULT_RETRIES, 1, MAX_RETRIES);
  const maxDurationMs = clampNumber(options.maxDurationMs, DEFAULT_MAX_DURATION_MS, 60 * 1000, DEFAULT_MAX_DURATION_MS);
  const maxErrors = clampNumber(options.maxErrors, DEFAULT_MAX_ERRORS, 10, DEFAULT_MAX_ERRORS);
  const rootDomain = getRootDomain(targetUrl);
  const state = getOrCreateState(sessionId);

  state.status = 'running';
  state.phase = 'discovery';
  state.startTime = Date.now();

  try {
    const discoveredUrls = await discoverUrls(targetUrl, rootDomain, maxPages, discoveryConcurrency);
    for (const url of discoveredUrls) {
      state.discovered.add(url);
    }

    for (const url of discoveredUrls) {
      await db.insertPage(sessionId, url, getRootDomain(url), getSubdomain(url));
    }

    await db.updateSession(sessionId, {
      status: 'running',
      total_discovered: discoveredUrls.length
    });

    runSessionWorker(sessionId, { crawlConcurrency, retries, maxDurationMs, maxErrors }).catch(() => {});
    return sessionId;
  } catch (error) {
    state.status = 'error';
    state.phase = 'error';
    await db.updateSession(sessionId, { status: 'error' });
    console.error(`[Crawler] Discovery error for ${sessionId}:`, error.message);
    throw error;
  }
}

async function processOneBatch(sessionId) {
  const session = await db.getSession(sessionId);
  if (!session || session.status !== 'running') return;
  await runSessionWorker(sessionId, {
    crawlConcurrency: 1,
    retries: DEFAULT_RETRIES,
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
    maxErrors: DEFAULT_MAX_ERRORS,
    singleBatch: true
  });
}

function getCrawlState(sessionId) {
  const state = crawlState[sessionId];
  if (!state) return null;

  return {
    status: state.status,
    phase: state.phase,
    discovered: state.discovered.size,
    crawled: state.crawled.size,
    errors: state.errors,
    elapsed: Date.now() - state.startTime
  };
}

module.exports = { startCrawl, processOneBatch, getCrawlState };
