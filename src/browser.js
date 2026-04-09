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
      }).catch(async () => {
        console.warn(`[Browser] networkidle timeout for ${url}, trying domcontentloaded`);
        return page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATION_TIMEOUT_MS
        }).catch(() => null);
      });

      await page.waitForSelector('head', { timeout: 10000 }).catch(() => {});
      await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(5000).catch(() => {});

      const extractedData = await page.evaluate(() => {
        const getAttribute = (selector, attribute) =>
          document.querySelector(selector)?.getAttribute(attribute) || null;
        const getContent = (selector) => getAttribute(selector, 'content');
        const cleanText = (value) => {
          if (typeof value !== 'string') return '';
          return value.replace(/\s+/g, ' ').trim();
        };
        const headings = (tagName) =>
          Array.from(document.querySelectorAll(tagName))
            .map((element) => cleanText(element.innerText || element.textContent || ''))
            .filter(Boolean);

        const schema = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .map((element) => cleanText(element.innerText || element.textContent || ''))
          .filter(Boolean);

        const ogEntries = Array.from(document.querySelectorAll('meta[property^="og:"]'))
          .map((element) => [element.getAttribute('property'), element.getAttribute('content')])
          .filter(([property, content]) => property && content);

        const bodyText = cleanText(document.body?.innerText || document.body?.textContent || '');
        const origin = window.location.origin;
        const blockedExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'css', 'js', 'pdf', 'zip', 'mp4', 'mp3', 'woff', 'woff2']);
        const allLinks = new Set();
        const internalLinks = new Set();
        const externalLinks = new Set();

        Array.from(document.querySelectorAll('a[href]')).forEach((element) => {
          const href = element.getAttribute('href');
          if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
            return;
          }

          try {
            const absolute = new URL(href, window.location.href).toString();
            const parsed = new URL(absolute);
            const pathSegment = parsed.pathname.split('.').pop().toLowerCase();

            if (blockedExtensions.has(pathSegment) || allLinks.has(absolute)) {
              return;
            }

            allLinks.add(absolute);
            if (parsed.origin === origin) {
              internalLinks.add(absolute);
            } else {
              externalLinks.add(absolute);
            }
          } catch (error) {
            // Ignore invalid URLs.
          }
        });

        const imageStats = Array.from(document.querySelectorAll('img')).reduce((acc, image) => {
          const alt = cleanText(image.getAttribute('alt') || '');
          acc.imageCount += 1;
          if (alt) {
            acc.imagesWithAltCount += 1;
          } else {
            acc.imagesMissingAltCount += 1;
          }
          return acc;
        }, { imageCount: 0, imagesMissingAltCount: 0, imagesWithAltCount: 0 });

        return {
          title: cleanText(document.title || ''),
          metaDescription: getContent('meta[name="description"]'),
          canonical: document.querySelector('link[rel="canonical"]')?.href || null,
          h1: headings('h1'),
          h2: headings('h2'),
          h3: headings('h3'),
          h4: headings('h4'),
          h5: headings('h5'),
          h6: headings('h6'),
          ogTitle: getContent('meta[property="og:title"]'),
          ogDescription: getContent('meta[property="og:description"]'),
          ogTags: Object.fromEntries(ogEntries.map(([property, content]) => [property.replace('og:', ''), content])),
          schema,
          wordCount: bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0,
          internalLinks: Array.from(internalLinks),
          externalLinks: Array.from(externalLinks),
          internalLinksCount: internalLinks.size,
          externalLinksCount: externalLinks.size,
          imageCount: imageStats.imageCount,
          imagesMissingAltCount: imageStats.imagesMissingAltCount,
          imagesWithAltCount: imageStats.imagesWithAltCount
        };
      });

      console.log('Extracted Data:', extractedData);

      const html = await page.content();

      return {
        html,
        extractedData,
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
