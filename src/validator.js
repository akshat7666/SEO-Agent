function isEmpty(value) {
  return !value || String(value).trim() === '';
}

function pushIssue(issues, type, severity, field, message, suggestion) {
  issues.push({ type, severity, field, message, suggestion });
}

function validatePage(pageData) {
  const issues = [];

  if (isEmpty(pageData.title)) {
    pushIssue(issues, 'missing_title', 'error', 'title', 'Page title is missing', 'Add a descriptive <title> tag between 30 and 60 characters.');
  } else {
    const len = pageData.title.length;
    if (len < 30) {
      pushIssue(issues, 'short_title', 'warning', 'title', `Title is short at ${len} characters`, 'Expand the title with clearer intent and primary keywords.');
    }
    if (len > 60) {
      pushIssue(issues, 'long_title', 'warning', 'title', `Title is long at ${len} characters`, 'Trim the title so search engines do not truncate it.');
    }
  }

  if (isEmpty(pageData.metaDescription)) {
    pushIssue(issues, 'missing_meta', 'error', 'meta_description', 'Meta description is missing', 'Add a compelling meta description between 70 and 160 characters.');
  } else {
    const len = pageData.metaDescription.length;
    if (len < 70) {
      pushIssue(issues, 'short_meta', 'warning', 'meta_description', `Meta description is short at ${len} characters`, 'Expand the description to better summarize the page.');
    }
    if (len > 160) {
      pushIssue(issues, 'long_meta', 'warning', 'meta_description', `Meta description is long at ${len} characters`, 'Shorten the meta description to avoid truncation.');
    }
  }

  if (isEmpty(pageData.h1Text) || pageData.h1Count === 0) {
    pushIssue(issues, 'missing_h1', 'error', 'h1', 'H1 heading is missing', 'Add one clear H1 heading that describes the page topic.');
  } else if (pageData.h1Count > 1) {
    pushIssue(issues, 'multiple_h1', 'warning', 'h1', `Multiple H1 headings found (${pageData.h1Count})`, 'Keep a single H1 to improve document structure.');
  }

  if ((pageData.h2Count || 0) === 0 && (pageData.wordCount || 0) > 300) {
    pushIssue(issues, 'missing_subheadings', 'warning', 'headings', 'No H2 subheadings found on a content-heavy page', 'Add H2 sections to improve readability and structure.');
  }

  if ((pageData.headingStructureScore || 0) < 4) {
    pushIssue(issues, 'weak_heading_structure', 'warning', 'headings', 'Heading hierarchy is weak', 'Use a more complete H1-H3 structure to organize the content.');
  }

  if (isEmpty(pageData.canonicalUrl)) {
    pushIssue(issues, 'missing_canonical', 'warning', 'canonical', 'Canonical tag is missing', 'Add a canonical URL to reduce duplicate-content ambiguity.');
  }

  if (pageData.statusCode >= 300 && pageData.statusCode < 400) {
    pushIssue(issues, 'redirect', 'warning', 'status', `Page redirects with status ${pageData.statusCode}`, 'Update internal links to point directly to the final destination.');
  }
  if (pageData.statusCode >= 400 && pageData.statusCode < 500) {
    pushIssue(issues, 'client_error', 'error', 'status', `Client error returned (${pageData.statusCode})`, 'Fix or redirect the broken page and update affected links.');
  }
  if (pageData.statusCode >= 500) {
    pushIssue(issues, 'server_error', 'error', 'status', `Server error returned (${pageData.statusCode})`, 'Investigate server-side failures affecting this URL.');
  }

  if ((pageData.wordCount || 0) < 100) {
    pushIssue(
      issues,
      'thin_content',
      pageData.pageType === 'listing' ? 'warning' : 'error',
      'content',
      `Content is thin at ${pageData.wordCount || 0} words`,
      'Add more unique, useful content to strengthen topical depth.'
    );
  } else if ((pageData.wordCount || 0) < 300) {
    pushIssue(issues, 'weak_content', 'warning', 'content', `Content is light at ${pageData.wordCount || 0} words`, 'Expand the page with richer information and supporting detail.');
  }

  if (!pageData.schemaJson || pageData.schemaJson.length === 0) {
    pushIssue(issues, 'missing_schema', 'warning', 'schema', 'No structured data found', 'Add relevant JSON-LD schema such as Organization, Product, Article, or FAQ.');
  }

  if (!pageData.ogTags || Object.keys(pageData.ogTags).length === 0) {
    pushIssue(issues, 'missing_og', 'warning', 'og_tags', 'Open Graph tags are missing', 'Add Open Graph metadata for stronger social previews.');
  }

  if ((pageData.imageCount || 0) > 0 && (pageData.imagesMissingAltCount || 0) > 0) {
    const missingAltRatio = pageData.imagesMissingAltCount / pageData.imageCount;
    pushIssue(
      issues,
      'missing_image_alt',
      missingAltRatio > 0.5 ? 'error' : 'warning',
      'images',
      `${pageData.imagesMissingAltCount} images are missing alt text`,
      'Add descriptive alt attributes to meaningful images.'
    );
  }

  if ((pageData.brokenInternalLinksCount || 0) > 0) {
    pushIssue(issues, 'broken_internal_links', 'error', 'links', `${pageData.brokenInternalLinksCount} broken internal links found`, 'Repair or remove broken internal links.');
  }

  if ((pageData.brokenExternalLinksCount || 0) > 0) {
    pushIssue(issues, 'broken_external_links', 'warning', 'links', `${pageData.brokenExternalLinksCount} broken external links found`, 'Update or remove dead outbound links.');
  }

  if ((pageData.internalLinksCount || 0) === 0) {
    pushIssue(issues, 'no_internal_links', 'warning', 'links', 'No internal links found on this page', 'Add internal links to improve crawl paths and authority flow.');
  }

  if ((pageData.loadTimeMs || 0) > 5000) {
    pushIssue(issues, 'slow_page', 'warning', 'performance', `Page load time is ${(pageData.loadTimeMs / 1000).toFixed(1)}s`, 'Improve page speed by reducing heavy assets and optimizing server response times.');
  }
  if ((pageData.loadTimeMs || 0) > 10000) {
    pushIssue(issues, 'very_slow_page', 'error', 'performance', `Page load time is critically slow at ${(pageData.loadTimeMs / 1000).toFixed(1)}s`, 'Treat this as a priority performance issue.');
  }

  return issues;
}

function getIssueSeverityCounts(issues) {
  return {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    total: issues.length
  };
}

module.exports = { validatePage, getIssueSeverityCounts };
