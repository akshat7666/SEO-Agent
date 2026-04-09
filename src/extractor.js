const axios = require('axios');
const cheerio = require('cheerio');
const { mapWithConcurrency } = require('./concurrency');
const { fetchRenderedPage, closeBrowser } = require('./browser');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate'
};

async function fetchWithRedirects(url, maxRedirects = 5) {
  const redirectChain = [];
  let currentUrl = url;
  let lastResponse = null;

  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    const response = await axios.get(currentUrl, {
      timeout: 30000,
      maxRedirects: 0,
      headers: DEFAULT_HEADERS,
      validateStatus: () => true,
      responseType: 'text'
    });

    lastResponse = response;
    const status = response.status || 0;
    const location = response.headers.location;

    if (status >= 300 && status < 400 && location) {
      const nextUrl = new URL(location, currentUrl).toString();
      redirectChain.push({
        from: currentUrl,
        statusCode: status,
        to: nextUrl
      });
      currentUrl = nextUrl;
      continue;
    }

    return {
      response,
      finalUrl: currentUrl,
      redirectChain
    };
  }

  return {
    response: lastResponse,
    finalUrl: currentUrl,
    redirectChain
  };
}

function normalizeLink(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch (error) {
    return null;
  }
}

async function checkLinkStatus(url, referer) {
  try {
    const headResponse = await axios.head(url, {
      timeout: 12000,
      maxRedirects: 5,
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      validateStatus: () => true
    });

    if (headResponse.status >= 400 || headResponse.status === 405) {
      const getResponse = await axios.get(url, {
        timeout: 12000,
        maxRedirects: 5,
        headers: { ...DEFAULT_HEADERS, Referer: referer },
        validateStatus: () => true
      });
      return getResponse.status;
    }

    return headResponse.status;
  } catch (error) {
    return 0;
  }
}

async function countBrokenLinks(internalLinks, externalLinks, referer) {
  const internalStatuses = await mapWithConcurrency(internalLinks, 5, async (link) => checkLinkStatus(link, referer));
  const externalStatuses = await mapWithConcurrency(externalLinks.slice(0, 25), 4, async (link) => checkLinkStatus(link, referer));

  return {
    brokenInternalLinksCount: internalStatuses.filter((status) => status >= 400 || status === 0).length,
    brokenExternalLinksCount: externalStatuses.filter((status) => status >= 400 || status === 0).length
  };
}

function detectPageType($, internalLinksCount, wordCount) {
  const articleMarkers = $('article').length + $('[itemtype*="Article"]').length;
  const listingMarkers = $('.product, .collection, .listing, .archive, .card, .grid').length;

  if (articleMarkers > 0 || wordCount >= 600) return 'article';
  if (listingMarkers > 10 || internalLinksCount >= 25) return 'listing';
  return 'page';
}

function parseSchemaBlocks(schemaBlocks = []) {
  const schemas = [];

  for (const raw of schemaBlocks) {
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        schemas.push(...parsed);
      } else {
        schemas.push(parsed);
      }
    } catch (error) {
      // Ignore invalid schema blocks.
    }
  }

  return schemas;
}

function extractSchema($) {
  const schemas = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).html();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        schemas.push(...parsed);
      } else {
        schemas.push(parsed);
      }
    } catch (error) {
      // Ignore invalid schema blocks.
    }
  });

  return schemas;
}

async function extractPageData(url) {
  const result = {
    finalUrl: url,
    statusCode: null,
    isRedirect: false,
    redirectChain: [],
    title: null,
    titleLength: 0,
    metaDescription: null,
    metaDescriptionLength: 0,
    h1Text: null,
    h1Count: 0,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingStructureScore: 0,
    canonicalUrl: null,
    wordCount: 0,
    schemaJson: [],
    ogTags: {},
    internalLinksCount: 0,
    externalLinksCount: 0,
    brokenInternalLinksCount: 0,
    brokenExternalLinksCount: 0,
    imageCount: 0,
    imagesMissingAltCount: 0,
    imagesWithAltCount: 0,
    pageType: 'page',
    loadTimeMs: 0,
    error: null
  };

  try {
    const startTime = Date.now();
    const { response, finalUrl, redirectChain } = await fetchWithRedirects(url);

    result.loadTimeMs = Date.now() - startTime;
    result.statusCode = response ? response.status : null;
    result.finalUrl = finalUrl || url;
    result.redirectChain = redirectChain;
    result.isRedirect = redirectChain.length > 0;

    let html = typeof response.data === 'string' ? response.data : '';
    let renderedData = null;
    
    // Always try to render the page with Playwright for JavaScript content
    const rendered = await fetchRenderedPage(result.finalUrl || url);
    if (rendered && typeof rendered.html === 'string' && rendered.html.trim()) {
      console.log(`[Extractor] Successfully rendered ${url} (${rendered.html.length} bytes)`);
      html = rendered.html;
      renderedData = rendered.extractedData || null;
      result.finalUrl = rendered.finalUrl || result.finalUrl;
      result.statusCode = rendered.statusCode || result.statusCode;
      result.loadTimeMs = Math.max(result.loadTimeMs, rendered.loadTimeMs || 0);
    } else {
      console.warn(`[Extractor] Failed to render ${url}, using fallback HTML (${html.length} bytes)`);
    }

    if (!html) {
      console.warn(`[Extractor] No HTML content for ${url}`);
      return result;
    }

    const $ = cheerio.load(html);

    result.title = renderedData?.title || $('title').first().text().trim();
    result.titleLength = result.title.length;

    result.metaDescription = renderedData?.metaDescription || $('meta[name="description"]').attr('content') || '';
    result.metaDescriptionLength = result.metaDescription.length;

    result.h1Count = renderedData?.h1?.length ?? $('h1').length;
    result.h2Count = renderedData?.h2?.length ?? $('h2').length;
    result.h3Count = renderedData?.h3?.length ?? $('h3').length;
    result.h4Count = renderedData?.h4?.length ?? $('h4').length;
    result.h5Count = renderedData?.h5?.length ?? $('h5').length;
    result.h6Count = renderedData?.h6?.length ?? $('h6').length;
    result.h1Text = renderedData?.h1?.[0] || $('h1').first().text().trim();

    const headingDepths = [result.h1Count, result.h2Count, result.h3Count, result.h4Count, result.h5Count, result.h6Count];
    const usedHeadingLevels = headingDepths.filter((count) => count > 0).length;
    result.headingStructureScore = Math.min(10, usedHeadingLevels * 2 + (result.h1Count === 1 ? 2 : 0));

    result.canonicalUrl = renderedData?.canonical || $('link[rel="canonical"]').attr('href') || null;

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    result.wordCount = renderedData?.wordCount ?? (bodyText ? bodyText.split(' ').filter(Boolean).length : 0);

    if (renderedData?.ogTags && Object.keys(renderedData.ogTags).length > 0) {
      result.ogTags = renderedData.ogTags;
    } else {
      $('meta[property^="og:"]').each((_, element) => {
        const property = $(element).attr('property');
        const content = $(element).attr('content');
        if (property && content) {
          result.ogTags[property.replace('og:', '')] = content;
        }
      });
    }

    result.schemaJson = renderedData?.schema ? parseSchemaBlocks(renderedData.schema) : extractSchema($);

    let internalLinks = renderedData?.internalLinks || null;
    let externalLinks = renderedData?.externalLinks || null;

    if (!internalLinks || !externalLinks) {
      const pageOrigin = new URL(result.finalUrl).origin;
      const allLinks = new Set();
      internalLinks = [];
      externalLinks = [];

      $('a[href]').each((_, element) => {
        const href = $(element).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
          return;
        }

        const absolute = normalizeLink(href, result.finalUrl);
        if (!absolute) return;

        const parsedUrl = new URL(absolute);
        const extension = parsedUrl.pathname.split('.').pop().toLowerCase();
        const blockedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'css', 'js', 'pdf', 'zip', 'mp4', 'mp3', 'woff', 'woff2'];

        if (blockedExtensions.includes(extension)) return;
        if (allLinks.has(absolute)) return;

        allLinks.add(absolute);
        if (parsedUrl.origin === pageOrigin) {
          internalLinks.push(absolute);
        } else {
          externalLinks.push(absolute);
        }
      });
    }

    result.internalLinksCount = renderedData?.internalLinksCount ?? internalLinks.length;
    result.externalLinksCount = renderedData?.externalLinksCount ?? externalLinks.length;

    if (renderedData) {
      result.imageCount = renderedData.imageCount ?? 0;
      result.imagesMissingAltCount = renderedData.imagesMissingAltCount ?? 0;
      result.imagesWithAltCount = renderedData.imagesWithAltCount ?? 0;
    } else {
      const images = $('img');
      result.imageCount = images.length;
      images.each((_, image) => {
        const alt = ($(image).attr('alt') || '').trim();
        if (alt) {
          result.imagesWithAltCount += 1;
        } else {
          result.imagesMissingAltCount += 1;
        }
      });
    }

    result.pageType = detectPageType($, result.internalLinksCount, result.wordCount);

    const brokenCounts = await countBrokenLinks(internalLinks, externalLinks, result.finalUrl);
    result.brokenInternalLinksCount = brokenCounts.brokenInternalLinksCount;
    result.brokenExternalLinksCount = brokenCounts.brokenExternalLinksCount;
  } catch (error) {
    console.error(`[Extractor] Error extracting data from ${url}:`, error.message);
    result.error = error.message;
    result.statusCode = error.response ? error.response.status : null;
  }

  return result;
}

module.exports = { extractPageData, closeBrowser };
