const { chromium } = require('playwright');
const pLimitModule = require('p-limit');

const PAGE_CONCURRENCY = 5;
const NAVIGATION_TIMEOUT_MS = 45000;
const pLimit = pLimitModule.default || pLimitModule;
const pageLimiter = pLimit(PAGE_CONCURRENCY);

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function withPage(task) {
  return pageLimiter(async () => {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true
    });

    const page = await context.newPage();

    // Block heavy resources
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        route.abort().catch(() => {});
      } else {
        route.continue().catch(() => {});
      }
    });

    try {
      return await task(page);
    } finally {
      await context.close().catch(() => {});
    }
  });
}

async function fetchRenderedPage(url) {
  try {
    return await withPage(async (page) => {
      const startedAt = Date.now();

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS
      });

      // 🔥 IMPORTANT FIX (for HubSpot / JS sites)
      await page.waitForLoadState('networkidle');
      await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(8000);

      const extractedData = await page.evaluate(() => {
        const clean = (t) =>
          typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';

        const getMeta = (selectors) => {
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.content) return el.content.trim();
          }
          return null;
        };

        const headings = (tag) =>
          Array.from(document.querySelectorAll(tag))
            .map((el) => clean(el.innerText))
            .filter(Boolean);

        const schema = Array.from(
          document.querySelectorAll('script[type="application/ld+json"]')
        )
          .map((el) => el.innerText)
          .filter(Boolean);

        const bodyText = clean(document.body?.innerText || '');

        const links = Array.from(document.querySelectorAll('a[href]'))
          .map((a) => a.href)
          .filter(Boolean);

        const origin = location.origin;

        const internalLinks = links.filter((l) => l.startsWith(origin));
        const externalLinks = links.filter((l) => !l.startsWith(origin));

        const ogTags = {};
        document.querySelectorAll('meta[property^="og:"]').forEach((el) => {
          const prop = el.getAttribute('property');
          const val = el.getAttribute('content');
          if (prop && val) {
            ogTags[prop.replace('og:', '')] = val;
          }
        });

        return {
          title: clean(document.title),

          metaDescription: getMeta([
            'meta[name="description"]',
            'meta[property="og:description"]',
            'meta[name="twitter:description"]'
          ]),

          canonical:
            document.querySelector('link[rel="canonical"]')?.href ||
            location.href,

          h1: headings('h1'),
          h2: headings('h2'),
          h3: headings('h3'),

          ogTags,

          schema,

          wordCount: bodyText
            ? bodyText.split(/\s+/).filter(Boolean).length
            : 0,

          internalLinks,
          externalLinks,
          internalLinksCount: internalLinks.length,
          externalLinksCount: externalLinks.length,

          imageCount: document.querySelectorAll('img').length
        };
      });

      console.log("BROWSER DATA:", extractedData);

      return {
        html: await page.content(),
        extractedData,
        finalUrl: page.url(),
        statusCode: response?.status() || 200,
        loadTimeMs: Date.now() - startedAt
      };
    });
  } catch (err) {
    console.error(`[Browser] Error:`, err.message);
    return null;
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) await browser.close().catch(() => {});
}

module.exports = {
  fetchRenderedPage,
  closeBrowser
};