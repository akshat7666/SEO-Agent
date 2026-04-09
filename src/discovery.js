const axios = require('axios');
const cheerio = require('cheerio');
const { parseStringPromise } = require('xml2js');
const { URL } = require('url');

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
  'mc_cid', 'mc_eid', '_ga', '_gl', 'ref', 'source'
];

/**
 * Normalize a URL: remove tracking params, trailing slashes, fragments
 */
function normalizeUrl(urlStr, baseUrl) {
  try {
    const url = new URL(urlStr, baseUrl);
    
    // Remove fragment
    url.hash = '';
    
    // Remove tracking params
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }
    
    // Sort remaining params for consistency
    url.searchParams.sort();
    
    // Remove trailing slash (except root)
    let normalized = url.toString();
    if (normalized.endsWith('/') && url.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    
    return normalized;
  } catch (e) {
    return null;
  }
}

/**
 * Extract root domain from URL. Handle PaaS/Preview domains gracefully.
 */
function getRootDomain(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname;
    
    // Prevent crawling up the chain on cloud preview platforms
    const previewDomains = ['squadbase.dev', 'vercel.app', 'netlify.app', 'web.app', 'github.io', 'herokuapp.com'];
    for (const pd of previewDomains) {
      if (hostname.endsWith('.' + pd) || hostname === pd) {
        return hostname; // The platform subdomain acts as the root sandbox
      }
    }

    const parts = hostname.split('.');
    // Handle co.uk, com.au etc.
    if (parts.length >= 3 && parts[parts.length - 2].length <= 3) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  } catch (e) {
    return null;
  }
}

/**
 * Get subdomain from URL
 */
function getSubdomain(urlStr) {
  try {
    const url = new URL(urlStr);
    const root = getRootDomain(urlStr);
    const hostname = url.hostname;
    if (hostname === root || hostname === 'www.' + root) return null;
    const sub = hostname.replace('.' + root, '');
    return sub.endsWith('.') ? sub.slice(0, -1) : sub;
  } catch (e) {
    return null;
  }
}

/**
 * Check if URL belongs to the same root domain
 */
function isSameDomain(urlStr, rootDomain) {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    const normalizedRoot = String(rootDomain || '').toLowerCase();
    return hostname === normalizedRoot || hostname === `www.${normalizedRoot}` || hostname.endsWith(`.${normalizedRoot}`);
  } catch (e) {
    return false;
  }
}

function isSkippableHref(href) {
  if (!href) return true;
  const trimmed = href.trim();
  return trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('#');
}

function isLikelyHtmlPage(urlStr) {
  try {
    const url = new URL(urlStr);
    const pathname = url.pathname.toLowerCase();
    const skipExts = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip', '.rar',
      '.mp3', '.mp4', '.avi', '.mov', '.css', '.js', '.woff',
      '.woff2', '.ttf', '.eot', '.xml'];
    return !skipExts.some((ext) => pathname.endsWith(ext));
  } catch (e) {
    return false;
  }
}

function isDisallowedByRobots(urlStr, baseUrl, robotsRules) {
  try {
    if (!robotsRules || !Array.isArray(robotsRules.disallowed) || robotsRules.disallowed.length === 0) {
      return false;
    }

    const url = new URL(urlStr, baseUrl);
    const pathname = url.pathname || '/';
    return robotsRules.disallowed
      .filter(Boolean)
      .some((rule) => rule !== '/' && pathname.startsWith(rule));
  } catch (e) {
    return false;
  }
}

/**
 * Extract all links from an HTML page
 */
function extractLinks(html, baseUrl, rootDomain) {
  const $ = cheerio.load(html);
  const links = new Set();

  $('a').each((_, el) => {
    const href = $(el).attr('href');
    if (isSkippableHref(href)) return;

    const normalized = normalizeUrl(href, baseUrl);
    if (!normalized) return;
    if (!isSameDomain(normalized, rootDomain)) return;
    if (!isLikelyHtmlPage(normalized)) return;

    links.add(normalized);
  });

  return [...links];
}

/**
 * Fetch and parse sitemap.xml
 */
async function parseSitemap(baseUrl) {
  const urls = new Set();
  const sitemapUrls = [
    new URL('/sitemap.xml', baseUrl).toString(),
    new URL('/sitemap_index.xml', baseUrl).toString(),
    new URL('/sitemap-index.xml', baseUrl).toString(),
    new URL('/wp-sitemap.xml', baseUrl).toString(),
  ];

  for (const sitemapUrl of sitemapUrls) {
    try {
      const resp = await axios.get(sitemapUrl, {
        timeout: 15000,
        headers: { 'User-Agent': 'SEO-Audit-Bot/1.0' },
        maxRedirects: 5,
        validateStatus: s => s < 400
      });

      const xml = await parseStringPromise(resp.data, { explicitArray: false });

      // Sitemap index
      if (xml.sitemapindex && xml.sitemapindex.sitemap) {
        const sitemaps = Array.isArray(xml.sitemapindex.sitemap) 
          ? xml.sitemapindex.sitemap 
          : [xml.sitemapindex.sitemap];
        
        for (const sm of sitemaps) {
          if (sm.loc) {
            try {
              const subResp = await axios.get(sm.loc, {
                timeout: 15000,
                headers: { 'User-Agent': 'SEO-Audit-Bot/1.0' },
                maxRedirects: 5,
                validateStatus: s => s < 400
              });
              const subXml = await parseStringPromise(subResp.data, { explicitArray: false });
              if (subXml.urlset && subXml.urlset.url) {
                const entries = Array.isArray(subXml.urlset.url) 
                  ? subXml.urlset.url 
                  : [subXml.urlset.url];
                for (const entry of entries) {
                  if (entry.loc) urls.add(normalizeUrl(entry.loc, baseUrl));
                }
              }
            } catch (e) { /* skip failed sub-sitemap */ }
          }
        }
      }

      // Regular sitemap
      if (xml.urlset && xml.urlset.url) {
        const entries = Array.isArray(xml.urlset.url) 
          ? xml.urlset.url 
          : [xml.urlset.url];
        for (const entry of entries) {
          if (entry.loc) urls.add(normalizeUrl(entry.loc, baseUrl));
        }
      }

      console.log(`[Sitemap] Found ${urls.size} URLs from ${sitemapUrl}`);
    } catch (e) {
      console.log(`[Sitemap] No sitemap at ${sitemapUrl}`);
    }
  }

  return [...urls].filter(Boolean);
}

/**
 * Parse robots.txt
 */
async function parseRobotsTxt(baseUrl) {
  const result = { allowed: [], disallowed: [], sitemaps: [] };
  
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    const resp = await axios.get(robotsUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'SEO-Audit-Bot/1.0' },
      validateStatus: s => s < 400
    });

    const lines = resp.data.split('\n');
    let isRelevantAgent = false;

    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.toLowerCase().startsWith('user-agent:')) {
        const agent = trimmed.split(':')[1].trim();
        isRelevantAgent = agent === '*' || agent.toLowerCase().includes('bot');
      }
      
      if (trimmed.toLowerCase().startsWith('sitemap:')) {
        result.sitemaps.push(trimmed.split(':', 2)[1].trim().replace(/^\/\//, 'https://'));
      }
      
      if (isRelevantAgent) {
        if (trimmed.toLowerCase().startsWith('allow:')) {
          result.allowed.push(trimmed.split(':')[1].trim());
        }
        if (trimmed.toLowerCase().startsWith('disallow:')) {
          result.disallowed.push(trimmed.split(':')[1].trim());
        }
      }
    }

    console.log(`[Robots] Found ${result.disallowed.length} disallowed, ${result.sitemaps.length} sitemaps`);
  } catch (e) {
    console.log('[Robots] No robots.txt found');
  }

  return result;
}

/**
 * Discover links from a page via HTTP (fast, no JS rendering)
 */
async function discoverFromPage(url, rootDomain, robotsRules = null) {
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      maxRedirects: 5,
      validateStatus: () => true
    });

    const finalUrl = resp.request?.res?.responseUrl || url;
    if (typeof resp.data === 'string') {
      const extracted = extractLinks(resp.data, finalUrl, rootDomain)
        .filter((link) => !isDisallowedByRobots(link, finalUrl, robotsRules));
      return extracted;
    }
    return [];
  } catch (e) {
    return [];
  }
}

module.exports = {
  normalizeUrl,
  getRootDomain,
  getSubdomain,
  isSameDomain,
  isDisallowedByRobots,
  extractLinks,
  parseSitemap,
  parseRobotsTxt,
  discoverFromPage
};
