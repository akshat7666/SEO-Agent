/**
 * SEO Scoring System (out of 100)
 * 
 * Score breakdown:
 * - Title:       10 points
 * - Meta:        10 points
 * - H1:          10 points
 * - Content:     20 points
 * - Links:       10 points
 * - Schema:      10 points
 * - Performance: 10 points
 * - URL:         10 points
 * - Freshness:   10 points
 */
function calculateScore(pageData, issues) {
  const breakdown = {
    title: 0,
    meta: 0,
    h1: 0,
    content: 0,
    links: 0,
    schema: 0,
    performance: 0,
    url: 0,
    freshness: 0
  };

  const issueTypes = new Set(issues.map(i => i.type));

  // --- Title (10 pts) ---
  if (!issueTypes.has('missing_title')) {
    breakdown.title = 10;
  }

  // --- Meta Description (10 pts) ---
  if (!issueTypes.has('missing_meta')) {
    breakdown.meta = 10;
  }

  // --- H1 (10 pts) ---
  if (!issueTypes.has('missing_h1')) {
    breakdown.h1 = 10;
    if (issueTypes.has('multiple_h1')) {
      breakdown.h1 = 8;
    }
  }

  // --- Content (20 pts) ---
  if (!issueTypes.has('thin_content') && !issueTypes.has('weak_content')) {
    breakdown.content = 20;
  } else if (issueTypes.has('weak_content')) {
    breakdown.content = 10;
  } else {
    breakdown.content = 0;
  }

  // --- Links (10 pts) ---
  const internalLinks = pageData.internalLinksCount || 0;
  if (internalLinks >= 10) breakdown.links = 10;
  else if (internalLinks >= 5) breakdown.links = 8;
  else if (internalLinks >= 1) breakdown.links = 5;
  else breakdown.links = 0;

  // --- Schema (10 pts) ---
  const hasSchema = pageData.schemaJson && 
    ((Array.isArray(pageData.schemaJson) && pageData.schemaJson.length > 0) ||
     (typeof pageData.schemaJson === 'string' && pageData.schemaJson !== '[]' && pageData.schemaJson !== 'null'));
  if (hasSchema) {
    breakdown.schema = 10;
  }

  // --- Performance (10 pts) ---
  const loadTime = pageData.loadTimeMs || 0;
  if (loadTime > 0 && loadTime <= 2000) breakdown.performance = 10;
  else if (loadTime <= 3000) breakdown.performance = 8;
  else if (loadTime <= 5000) breakdown.performance = 5;
  else if (loadTime <= 10000) breakdown.performance = 3;
  else breakdown.performance = 0;

  // --- URL Quality (10 pts) ---
  try {
    const url = new URL(pageData.finalUrl || pageData.originalUrl || '');
    let urlScore = 10;
    
    // Penalize long URLs
    if (url.pathname.length > 100) urlScore -= 3;
    else if (url.pathname.length > 60) urlScore -= 1;
    
    // Penalize query params
    if (url.search.length > 0) urlScore -= 2;
    
    // Penalize deep nesting (more than 3 levels)
    const depth = url.pathname.split('/').filter(Boolean).length;
    if (depth > 5) urlScore -= 3;
    else if (depth > 3) urlScore -= 1;
    
    // Penalize non-HTTPS
    if (url.protocol !== 'https:') urlScore -= 3;
    
    // Penalize uppercase in path
    if (url.pathname !== url.pathname.toLowerCase()) urlScore -= 1;
    
    breakdown.url = Math.max(0, urlScore);
  } catch (e) {
    breakdown.url = 0;
  }

  // --- Freshness (10 pts) ---
  // Without access to Last-Modified or article dates, base on content quality indicators
  const hasCanonical = !issueTypes.has('missing_canonical');
  const hasOg = pageData.ogTags && Object.keys(
    typeof pageData.ogTags === 'string' ? JSON.parse(pageData.ogTags || '{}') : (pageData.ogTags || {})
  ).length > 0;
  
  breakdown.freshness = 0;
  if (hasCanonical) breakdown.freshness += 4;
  if (hasOg) breakdown.freshness += 3;
  if (hasSchema) breakdown.freshness += 3;

  // Calculate total
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  return {
    total: Math.min(100, total),
    breakdown,
    band: total >= 80 ? 'Strong' : total >= 60 ? 'Average' : 'Weak'
  };
}

module.exports = { calculateScore };
