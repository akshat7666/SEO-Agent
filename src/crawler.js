const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const { getRootDomain, getSubdomain, normalizeUrl, parseSitemap, parseRobotsTxt, discoverFromPage } = require('./discovery');
const { extractPageData, closeBrowser } = require('./extractor');
const { validatePage } = require('./validator');
const { calculateScore } = require('./scorer');

// Crawl state
const crawlState = {};

/**
 * Start a full crawl of a target URL
 */
async function startCrawl(targetUrl, options = {}) {
  const sessionId = uuidv4();
  const rootDomain = getRootDomain(targetUrl);
  const batchSize = options.batchSize || 10;
  const maxPages = options.maxPages || 500;
  const delayMs = options.delayMs || 1000;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crawler] Starting crawl session: ${sessionId}`);
  console.log(`[Crawler] Target: ${targetUrl}`);
  console.log(`[Crawler] Root domain: ${rootDomain}`);
  console.log(`${'='.repeat(60)}\n`);

  // Create session
  db.createSession(sessionId, targetUrl);

  crawlState[sessionId] = {
    status: 'running',
    phase: 'discovery',
    discovered: new Set(),
    crawled: new Set(),
    errors: 0,
    startTime: Date.now()
  };

  try {
    // Phase 1: Discovery
    console.log('[Crawler] Phase 1: URL Discovery');
    crawlState[sessionId].phase = 'discovery';

    // 1a. Parse robots.txt
    const robots = await parseRobotsTxt(targetUrl);

    // 1b. Parse sitemaps
    const sitemapUrls = await parseSitemap(targetUrl);
    for (const url of sitemapUrls) {
      if (crawlState[sessionId].discovered.size < maxPages) {
        crawlState[sessionId].discovered.add(url);
      }
    }

    // 1c. Also try sitemaps from robots.txt
    if (robots.sitemaps.length > 0) {
      for (const smUrl of robots.sitemaps) {
        try {
          const extraUrls = await parseSitemap(smUrl);
          for (const url of extraUrls) {
            if (crawlState[sessionId].discovered.size < maxPages) {
              crawlState[sessionId].discovered.add(url);
            }
          }
        } catch (e) { /* skip */ }
      }
    }

    // 1d. Seed with target URL
    const normalizedTarget = normalizeUrl(targetUrl, targetUrl);
    if (normalizedTarget) crawlState[sessionId].discovered.add(normalizedTarget);

    // 1e. Crawl-based discovery (BFS from target)
    console.log('[Crawler] Discovering links from pages...');
    const discoveryQueue = [normalizedTarget];
    const discoveredFromPages = new Set();
    let discoveryDepth = 0;
    const maxDiscoveryPages = 50; // Limit discovery crawl
    let discoveredCount = 0;

    while (discoveryQueue.length > 0 && discoveredCount < maxDiscoveryPages) {
      const pageUrl = discoveryQueue.shift();
      if (discoveredFromPages.has(pageUrl)) continue;
      discoveredFromPages.add(pageUrl);
      discoveredCount++;

      const links = await discoverFromPage(pageUrl, rootDomain);
      for (const link of links) {
        if (!crawlState[sessionId].discovered.has(link) && crawlState[sessionId].discovered.size < maxPages) {
          crawlState[sessionId].discovered.add(link);
          if (!discoveredFromPages.has(link)) {
            discoveryQueue.push(link);
          }
        }
      }

      console.log(`[Discovery] Scanned ${discoveredCount} pages, total URLs: ${crawlState[sessionId].discovered.size}`);
    }

    console.log(`\n[Crawler] Total discovered: ${crawlState[sessionId].discovered.size} URLs\n`);

    // Insert all discovered URLs into database
    for (const url of crawlState[sessionId].discovered) {
      const subdomain = getSubdomain(url);
      const domain = getRootDomain(url);
      db.insertPage(sessionId, url, domain, subdomain);
    }

    db.updateSession(sessionId, {
      total_discovered: crawlState[sessionId].discovered.size
    });

    // Phase 2: Extraction
    console.log('[Crawler] Phase 2: Data Extraction');
    crawlState[sessionId].phase = 'extraction';

    let totalCrawled = 0;
    let totalErrors = 0;

    while (true) {
      const pending = db.getPendingPages(sessionId, batchSize);
      if (pending.length === 0) break;

      // Process batch
      const batchPromises = pending.map(async (page) => {
        try {
          console.log(`[Extract] (${totalCrawled + 1}/${crawlState[sessionId].discovered.size}) ${page.original_url}`);

          const data = await extractPageData(page.original_url);

          // Validate
          const issues = validatePage({
            title: data.title,
            titleLength: data.titleLength,
            metaDescription: data.metaDescription,
            metaDescriptionLength: data.metaDescriptionLength,
            h1Text: data.h1Text,
            h1Count: data.h1Count,
            canonicalUrl: data.canonicalUrl,
            wordCount: data.wordCount,
            schemaJson: data.schemaJson,
            ogTags: data.ogTags,
            internalLinksCount: data.internalLinksCount,
            externalLinksCount: data.externalLinksCount,
            loadTimeMs: data.loadTimeMs,
            statusCode: data.statusCode,
            finalUrl: data.finalUrl,
            originalUrl: page.original_url
          });

          // Score
          const scoreResult = calculateScore({
            ...data,
            originalUrl: page.original_url
          }, issues);

          // Update database
          db.updatePage(sessionId, page.original_url, {
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
            canonical_url: data.canonicalUrl,
            word_count: data.wordCount,
            schema_json: data.schemaJson ? JSON.stringify(data.schemaJson) : null,
            og_tags: data.ogTags ? JSON.stringify(data.ogTags) : null,
            internal_links_count: data.internalLinksCount,
            external_links_count: data.externalLinksCount,
            load_time_ms: data.loadTimeMs,
            score: scoreResult.total,
            score_breakdown: JSON.stringify(scoreResult.breakdown),
            issues: JSON.stringify(issues),
            crawl_status: 'done',
            last_crawled: new Date().toISOString()
          });

          totalCrawled++;
          crawlState[sessionId].crawled.add(page.original_url);

        } catch (e) {
          console.error(`[Extract] Error on ${page.original_url}: ${e.message}`);
          db.updatePage(sessionId, page.original_url, {
            crawl_status: 'error',
            error_message: e.message
          });
          totalErrors++;
          crawlState[sessionId].errors++;
        }
      });

      // Process in serial within each batch to avoid overwhelming the browser
      for (const promise of batchPromises) {
        await promise;
        // Small delay between pages
        await new Promise(r => setTimeout(r, delayMs));
      }

      // Update session stats
      const stats = db.getSessionStats(sessionId);
      db.updateSession(sessionId, {
        total_crawled: totalCrawled,
        total_errors: totalErrors,
        avg_score: Math.round(stats.avg_score || 0)
      });
    }

    // Phase 3: Complete
    crawlState[sessionId].status = 'completed';
    crawlState[sessionId].phase = 'done';

    const finalStats = db.getSessionStats(sessionId);
    db.updateSession(sessionId, {
      status: 'completed',
      total_crawled: totalCrawled,
      total_errors: totalErrors,
      avg_score: Math.round(finalStats.avg_score || 0),
      completed_at: new Date().toISOString()
    });

    const elapsed = ((Date.now() - crawlState[sessionId].startTime) / 1000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Crawler] Crawl complete!`);
    console.log(`[Crawler] Discovered: ${crawlState[sessionId].discovered.size}`);
    console.log(`[Crawler] Crawled: ${totalCrawled}`);
    console.log(`[Crawler] Errors: ${totalErrors}`);
    console.log(`[Crawler] Average Score: ${Math.round(finalStats.avg_score || 0)}`);
    console.log(`[Crawler] Time: ${elapsed}s`);
    console.log(`${'='.repeat(60)}\n`);

  } catch (e) {
    console.error(`[Crawler] Fatal error: ${e.message}`);
    crawlState[sessionId].status = 'error';
    db.updateSession(sessionId, { status: 'error' });
  } finally {
    await closeBrowser();
  }

  return sessionId;
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
    elapsed: ((Date.now() - state.startTime) / 1000).toFixed(1)
  };
}

module.exports = { startCrawl, getCrawlState };
