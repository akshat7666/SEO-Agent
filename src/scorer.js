function calculateScore(pageData, issues) {
  const issueTypes = new Set(issues.map((issue) => issue.type));

  const breakdown = {
    title: 12,
    meta: 10,
    headings: 12,
    content: 16,
    media: 10,
    links: 12,
    schema: 8,
    performance: 10,
    url: 5,
    technical: 5
  };

  if (issueTypes.has('missing_title')) breakdown.title = 0;
  else if (issueTypes.has('short_title') || issueTypes.has('long_title')) breakdown.title = 7;

  if (issueTypes.has('missing_meta')) breakdown.meta = 0;
  else if (issueTypes.has('short_meta') || issueTypes.has('long_meta')) breakdown.meta = 6;

  if (issueTypes.has('missing_h1')) breakdown.headings = 0;
  else if (issueTypes.has('multiple_h1')) breakdown.headings -= 3;
  if (issueTypes.has('missing_subheadings')) breakdown.headings -= 3;
  if (issueTypes.has('weak_heading_structure')) breakdown.headings -= 3;
  breakdown.headings = Math.max(0, breakdown.headings);

  if (issueTypes.has('thin_content')) breakdown.content = 0;
  else if (issueTypes.has('weak_content')) breakdown.content = 8;
  if ((pageData.wordCount || 0) > 1200) breakdown.content = Math.min(16, breakdown.content + 2);

  if ((pageData.imageCount || 0) === 0) {
    breakdown.media = 6;
  } else {
    const altCoverage = (pageData.imagesWithAltCount || 0) / Math.max(1, pageData.imageCount || 1);
    if (altCoverage < 0.5) breakdown.media = 2;
    else if (altCoverage < 0.85) breakdown.media = 6;
  }
  if (issueTypes.has('missing_image_alt')) breakdown.media = Math.min(breakdown.media, 6);

  breakdown.links = 0;
  const internalLinks = pageData.internalLinksCount || 0;
  if (internalLinks >= 15) breakdown.links += 8;
  else if (internalLinks >= 5) breakdown.links += 6;
  else if (internalLinks >= 1) breakdown.links += 3;
  if (!issueTypes.has('broken_internal_links')) breakdown.links += 2;
  if (!issueTypes.has('broken_external_links')) breakdown.links += 1;
  if (!issueTypes.has('no_internal_links')) breakdown.links += 1;
  breakdown.links = Math.min(12, Math.max(0, breakdown.links));

  if (!issueTypes.has('missing_schema')) breakdown.schema = 8;
  else breakdown.schema = 2;

  const loadTime = pageData.loadTimeMs || 0;
  if (!loadTime) breakdown.performance = 0;
  else if (loadTime <= 1500) breakdown.performance = 10;
  else if (loadTime <= 3000) breakdown.performance = 8;
  else if (loadTime <= 5000) breakdown.performance = 5;
  else if (loadTime <= 8000) breakdown.performance = 2;
  else breakdown.performance = 0;

  try {
    const url = new URL(pageData.finalUrl || pageData.originalUrl || '');
    let urlScore = 5;
    if (url.protocol !== 'https:') urlScore -= 2;
    if (url.search) urlScore -= 1;
    if (url.pathname.length > 90) urlScore -= 1;
    if (url.pathname !== url.pathname.toLowerCase()) urlScore -= 1;
    breakdown.url = Math.max(0, urlScore);
  } catch (error) {
    breakdown.url = 0;
  }

  breakdown.technical = 5;
  if (issueTypes.has('redirect')) breakdown.technical -= 1;
  if (issueTypes.has('missing_canonical')) breakdown.technical -= 2;
  if (issueTypes.has('missing_og')) breakdown.technical -= 1;
  if (issueTypes.has('client_error') || issueTypes.has('server_error')) breakdown.technical = 0;
  breakdown.technical = Math.max(0, breakdown.technical);

  const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0);

  return {
    total: Math.max(0, Math.min(100, Math.round(total))),
    breakdown,
    band: total >= 85 ? 'Excellent' : total >= 70 ? 'Good' : total >= 55 ? 'Fair' : 'Poor'
  };
}

module.exports = { calculateScore };
