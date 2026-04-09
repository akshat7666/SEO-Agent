const axios = require('axios');
const cheerio = require('cheerio');
const { mapWithConcurrency } = require('./concurrency');
const { fetchRenderedPage, closeBrowser } = require('./browser');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'text/html',
  'Accept-Language': 'en-US,en;q=0.9'
};

async function fetchWithRedirects(url, maxRedirects = 5) {
  let currentUrl = url;
  let lastResponse = null;

  for (let i = 0; i <= maxRedirects; i++) {
    const response = await axios.get(currentUrl, {
      timeout: 30000,
      maxRedirects: 0,
      headers: DEFAULT_HEADERS,
      validateStatus: () => true
    });

    lastResponse = response;

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      currentUrl = new URL(response.headers.location, currentUrl).toString();
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  return { response: lastResponse, finalUrl: currentUrl };
}

function normalizeLink(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

async function extractPageData(url) {
  const result = {
    finalUrl: url,
    title: null,
    metaDescription: null,
    canonicalUrl: null,
    h1Count: 0,
    wordCount: 0,
    schemaJson: [],
    ogTags: {},
    internalLinksCount: 0,
    externalLinksCount: 0,
    loadTimeMs: 0,
    error: null
  };

  try {
    const start = Date.now();

    const { response, finalUrl } = await fetchWithRedirects(url);
    result.finalUrl = finalUrl;

    let html = response?.data || '';
    let renderedData = null;

    // 🔥 PLAYWRIGHT RENDER (PRIMARY SOURCE)
    const rendered = await fetchRenderedPage(finalUrl);

    if (rendered && rendered.html) {
      html = rendered.html;
      result.loadTimeMs = rendered.loadTimeMs;
      renderedData = rendered.extractedData || null;
    }

    const $ = cheerio.load(html);

    // ✅ TITLE (Playwright first, fallback cheerio)
    result.title =
      renderedData?.title ||
      $('title').text().trim();

    // ✅ META DESCRIPTION (STRONG FIX)
    result.metaDescription =
      renderedData?.metaDescription ||
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="twitter:description"]').attr('content') ||
      null;

    // ✅ CANONICAL (SAFE FIX)
    result.canonicalUrl =
      renderedData?.canonical ||
      $('link[rel="canonical"]').attr('href') ||
      result.finalUrl ||
      null;

    // ✅ HEADINGS
    result.h1Count =
      renderedData?.h1?.length ??
      $('h1').length;

    // ✅ WORD COUNT (IMPORTANT FIX)
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    result.wordCount =
      renderedData?.wordCount ||
      (text ? text.split(' ').length : 0);

    // ✅ OG TAGS
    if (renderedData?.ogTags && Object.keys(renderedData.ogTags).length > 0) {
      result.ogTags = renderedData.ogTags;
    } else {
      $('meta[property^="og:"]').each((_, el) => {
        const prop = $(el).attr('property');
        const content = $(el).attr('content');
        if (prop && content) {
          result.ogTags[prop.replace('og:', '')] = content;
        }
      });
    }

    // ✅ SCHEMA
    if (renderedData?.schema && renderedData.schema.length > 0) {
      result.schemaJson = renderedData.schema;
    } else {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).html());
          result.schemaJson.push(json);
        } catch {}
      });
    }

    // ✅ LINKS
    const origin = new URL(result.finalUrl).origin;
    const internal = new Set();
    const external = new Set();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const full = normalizeLink(href, result.finalUrl);
      if (!full) return;

      if (full.startsWith(origin)) {
        internal.add(full);
      } else {
        external.add(full);
      }
    });

    result.internalLinksCount = internal.size;
    result.externalLinksCount = external.size;

    // 🔥 DEBUG (VERY IMPORTANT)
    console.log("FINAL DATA:", {
      url: result.finalUrl,
      meta: result.metaDescription,
      canonical: result.canonicalUrl,
      words: result.wordCount
    });

  } catch (err) {
    result.error = err.message;
    console.error("Extractor error:", err.message);
  }

  return result;
}

module.exports = {
  extractPageData,
  closeBrowser
};