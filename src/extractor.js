const { chromium } = require('playwright');

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  }
  return browser;
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Extract SEO data from a URL using Playwright
 * Handles JS-rendered pages and follows redirects
 */
async function extractPageData(url) {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();
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
    // Track redirects
    const redirects = [];
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 300 && status < 400) {
        redirects.push({
          url: response.url(),
          status: status,
          location: response.headers()['location']
        });
      }
    });

    const startTime = Date.now();

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await page.waitForSelector("body", { timeout: 10000 });
    await page.waitForFunction(() => {
      return document.readyState === "complete";
    });
    
    // Hydration check for dynamic JS
    try {
      await page.waitForFunction(() => document.body.innerText.length > 200, { timeout: 5000 });
    } catch(e) {
      // It might legitimately be a small page or an error page, so we catch and proceed
    }

    result.loadTimeMs = Date.now() - startTime;
    result.statusCode = response ? response.status() : null;
    result.finalUrl = page.url();

    if (redirects.length > 0) {
      result.isRedirect = true;
      result.redirectChain = redirects;
    }

    if (result.finalUrl !== url) {
      result.isRedirect = true;
    }

    // Only extract SEO data for successful pages
    if (result.statusCode && result.statusCode < 400) {
      const data = await page.evaluate(() => {
        // Fake 404
        function detectFake404(doc) {
          const t = doc.title.toLowerCase();
          const b = doc.body.innerText.toLowerCase();
          if (t.includes('404') || b.includes('page not found') || b.includes('not found')) return true;
          return false;
        }
        const isFake404 = detectFake404(document);
        // Title
        const titleText = document.title?.trim();
        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
        const title = titleText || ogTitle || null;

        // Meta description - Priority fallback
        const getMeta = (selector) => {
          const el = document.querySelector(selector);
          return el ? el.getAttribute("content")?.trim() || null : null;
        };

        const metaDescription = 
          getMeta('meta[name="description" i]') || 
          getMeta('meta[property="og:description" i]') || 
          getMeta('meta[name="twitter:description" i]') || 
          null;

        // H1 Extraction 
        const h1Elements = document.querySelectorAll('h1');
        const h1Count = h1Elements.length;
        const h1s = Array.from(h1Elements)
          .map(el => (el.innerText ? el.innerText.trim() : el.textContent?.trim()))
          .filter(Boolean);
        const h1Text = h1s.length > 0 ? h1s[0] : null;

        // Canonical
        const canonicalTag = document.querySelector('link[rel="canonical"]');
        const canonicalUrl = canonicalTag?.href?.trim() || window.location.href;
        const isCanonicalMissing = !canonicalTag;

        // Word count (MAIN CONTENT ONLY)
        function getCleanText(document) {
          const main = document.querySelector("main") || document.querySelector("article") || document.body;
          const clone = main.cloneNode(true);
          clone.querySelectorAll("script, style, noscript, nav, footer, header").forEach(el => el.remove());
          
          return clone.innerText
            .replace(/\s+/g, ' ')
            .trim();
        }
        const wordCountStr = getCleanText(document);
        const wordCount = wordCountStr ? wordCountStr.split(' ').length : 0;

        // Page Type Detection
        function detectPageType(url, document) {
          const path = url.toLowerCase();
          if (path.includes('/blog') || path.includes('/news') || path.includes('/category') || path.includes('/resources')) return 'listing';
          const articleSchema = document.querySelector('script[type="application/ld+json"]')?.innerText || '';
          if (articleSchema.includes('"@type":"Article"')) return 'article';
          return 'general';
        }
        const pageType = detectPageType(window.location.href, document);
        
        // Load Time
        let loadTime = 0;
        if (performance.timing.loadEventEnd > 0) {
          loadTime = (performance.timing.loadEventEnd - performance.timing.navigationStart) / 1000;
        } else {
          loadTime = performance.now() / 1000;
        }

        // Schema/JSON-LD
        const schemas = [];
        document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
          try {
            schemas.push(JSON.parse(el.textContent));
          } catch (e) { /* skip */ }
        });

        // Open Graph tags
        const ogTags = {};
        document.querySelectorAll('meta[property^="og:"]').forEach(el => {
          const prop = el.getAttribute('property');
          const content = el.getAttribute('content');
          if (prop && content) ogTags[prop] = content;
        });

        // Links
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const internal = [];
        const external = [];
        const baseUrl = window.location.href;
        
        anchors.forEach(a => {
          try {
            const url = new URL(a.href, baseUrl);
            if (url.hostname === new URL(baseUrl).hostname) {
              internal.push(url.href);
            } else {
              external.push(url.href);
            }
          } catch (e) {}
        });

        return {
          isFake404,
          title,
          metaDescription,
          h1Text,
          h1Count,
          canonicalUrl,
          isCanonicalMissing,
          wordCount,
          pageType,
          loadTime,
          schemas: schemas.length > 0 ? schemas : null,
          ogTags: Object.keys(ogTags).length > 0 ? ogTags : null,
          internalLinksCount: internal.length,
          externalLinksCount: external.length
        };
      });

      if (data.isFake404) {
        result.statusCode = 404;
        result.error = "Broken Page or Fake 404 hit";
      }

      // Override real performance load string
      result.loadTimeMs = data.loadTime > 0 ? data.loadTime * 1000 : result.loadTimeMs;

      // Final validation layer
      const isValid = (val) => val && val.trim().length > 0;

      result.title = isValid(data.title) ? data.title : null;
      result.titleLength = result.title ? result.title.length : 0;
      
      result.metaDescription = isValid(data.metaDescription) ? data.metaDescription : null;
      result.metaDescriptionLength = result.metaDescription ? result.metaDescription.length : 0;
      
      result.h1Text = isValid(data.h1Text) ? data.h1Text : null;
      result.h1Count = data.h1Count;
      
      result.canonicalUrl = data.canonicalUrl;
      result.isCanonicalMissing = data.isCanonicalMissing;
      result.wordCount = data.wordCount;
      result.pageType = data.pageType;
      result.schemaJson = data.schemas;
      result.ogTags = data.ogTags;
      result.internalLinksCount = data.internalLinksCount;
      result.externalLinksCount = data.externalLinksCount;

      console.log("[DEBUG SNAPSHOT]", {
        url,
        finalUrl: result.finalUrl,
        status: result.statusCode,
        titleLength: result.titleLength,
        metaLength: result.metaDescriptionLength,
        h1Exists: !!result.h1Text,
        wordCount: result.wordCount
      });
    }

  } catch (e) {
    result.error = e.message;
    console.error(`[Extractor] Error: ` + e.message);
  } finally {
    await page.close();
    await context.close();
  }

  return result;
}

module.exports = { extractPageData, closeBrowser, getBrowser };
