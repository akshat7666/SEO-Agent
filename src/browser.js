const { chromium } = require('playwright');
const pLimitModule = require('p-limit');

const PAGE_CONCURRENCY = 3;
const NAVIGATION_TIMEOUT_MS = 30000;
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
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

      await page.waitForLoadState('networkidle', {
        timeout: 5000
      }).catch(() => {});

      const html = await page.content();

      return {
        html,
        finalUrl: page.url(),
        statusCode: response ? response.status() : null,
        loadTimeMs: Date.now() - startedAt
      };
    });
  } catch (error) {
    return null;
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  fetchRenderedPage,
  closeBrowser
};
