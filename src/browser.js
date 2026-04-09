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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();

    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp}', (route) => route.abort().catch(() => {}));
    await page.route('**/*.{woff,woff2,ttf,eot}', (route) => route.abort().catch(() => {}));
    
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
        waitUntil: 'networkidle',
        timeout: NAVIGATION_TIMEOUT_MS
      }).catch(async (err) => {
        console.warn(`[Browser] networkidle timeout for ${url}, trying domcontentloaded`);
        return page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATION_TIMEOUT_MS
        }).catch(() => null);
      });

      await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});

      await page.evaluate(() => {
        return Promise.race([
          new Promise(resolve => setTimeout(resolve, 3000)),
          new Promise(resolve => {
            if (document.readyState === 'complete') resolve();
            else window.addEventListener('load', resolve);
          })
        ]);
      }).catch(() => {});

      const html = await page.content();

      return {
        html,
        finalUrl: page.url(),
        statusCode: response ? response.status() : 200,
        loadTimeMs: Date.now() - startedAt
      };
    });
  } catch (error) {
    console.error(`[Browser] Error rendering ${url}:`, error.message);
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
