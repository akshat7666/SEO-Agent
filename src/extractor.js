const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Extract SEO data from a URL using HTTP requests (Vercel-compatible)
 * Note: This is a simplified version without JS rendering for serverless deployment
 */
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
    canonicalUrl: null,
    wordCount: 0,
    schemaJson: null,
    ogTags: {},
    internalLinksCount: 0,
    externalLinksCount: 0,
    loadTimeMs: 0,
    error: null
  };

  try {
    const startTime = Date.now();

    const response = await axios.get(url, {
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      validateStatus: function (status) {
        return status < 500; // Accept all status codes below 500
      }
    });

    result.loadTimeMs = Date.now() - startTime;
    result.statusCode = response.status;
    result.finalUrl = response.request.res.responseUrl || url;

    if (result.finalUrl !== url) {
      result.isRedirect = true;
      // Note: We can't track full redirect chain with axios easily
    }

    const $ = cheerio.load(response.data);

    // Extract title
    result.title = $('title').text().trim();
    result.titleLength = result.title.length;

    // Extract meta description
    result.metaDescription = $('meta[name="description"]').attr('content') || '';
    result.metaDescriptionLength = result.metaDescription.length;

    // Extract H1
    const h1Elements = $('h1');
    result.h1Count = h1Elements.length;
    result.h1Text = h1Elements.first().text().trim();

    // Extract canonical URL
    result.canonicalUrl = $('link[rel="canonical"]').attr('href') || null;

    // Extract word count from body text
    const bodyText = $('body').text();
    result.wordCount = bodyText.split(/\s+/).filter(word => word.length > 0).length;

    // Extract Open Graph tags
    $('meta[property^="og:"]').each((i, elem) => {
      const property = $(elem).attr('property').replace('og:', '');
      const content = $(elem).attr('content');
      if (content) {
        result.ogTags[property] = content;
      }
    });

    // Extract schema.org JSON-LD
    const schemaScripts = $('script[type="application/ld+json"]');
    if (schemaScripts.length > 0) {
      try {
        result.schemaJson = JSON.parse(schemaScripts.first().html());
      } catch (e) {
        result.schemaJson = null;
      }
    }

    // Count internal and external links
    const links = $('a[href]');
    let internalCount = 0;
    let externalCount = 0;

    const urlObj = new URL(url);
    const baseDomain = urlObj.hostname;

    links.each((i, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        try {
          const linkUrl = new URL(href, url);
          if (linkUrl.hostname === baseDomain) {
            internalCount++;
          } else {
            externalCount++;
          }
        } catch (e) {
          // Invalid URL, skip
        }
      }
    });

    result.internalLinksCount = internalCount;
    result.externalLinksCount = externalCount;

  } catch (error) {
    result.error = error.message;
    result.statusCode = error.response ? error.response.status : null;
  }

  return result;
}

async function closeBrowser() {
  // No browser to close in HTTP-only version
}

module.exports = { extractPageData, closeBrowser };