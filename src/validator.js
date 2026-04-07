function isEmpty(value) {
  return !value || value.trim() === "";
}

/**
 * SEO Validation Rules
 * Returns array of issues for a page's extracted data
 */
function validatePage(pageData) {
  const issues = [];

  // --- Title Validation ---
  if (isEmpty(pageData.title)) {
    issues.push({
      type: 'missing_title',
      severity: 'error',
      field: 'title',
      message: 'Page title is missing',
      suggestion: 'Add a descriptive <title> tag between 30-60 characters'
    });
  } else {
    const len = pageData.title.length;
    if (len < 30) {
      issues.push({
        type: 'short_title',
        severity: 'warning',
        field: 'title',
        message: `Title is too short (${len} chars). Recommended: 30-60 characters`,
        suggestion: 'Expand the title to include relevant keywords and be more descriptive'
      });
    }
    if (len > 60) {
      issues.push({
        type: 'long_title',
        severity: 'warning',
        field: 'title',
        message: `Title is too long (${len} chars). Recommended: 30-60 characters`,
        suggestion: 'Shorten the title to prevent truncation in search results'
      });
    }
  }

  // --- Meta Description Validation ---
  if (isEmpty(pageData.metaDescription)) {
    issues.push({
      type: 'missing_meta',
      severity: 'error',
      field: 'meta_description',
      message: 'Meta description is missing',
      suggestion: 'Add a compelling meta description between 70-160 characters'
    });
  } else {
    const len = pageData.metaDescription.length;
    if (len < 70) {
      issues.push({
        type: 'short_meta',
        severity: 'warning',
        field: 'meta_description',
        message: `Meta description is too short (${len} chars). Recommended: 70-160 characters`,
        suggestion: 'Expand the meta description to better summarize page content'
      });
    }
    if (len > 160) {
      issues.push({
        type: 'long_meta',
        severity: 'warning',
        field: 'meta_description',
        message: `Meta description is too long (${len} chars). Recommended: 70-160 characters`,
        suggestion: 'Shorten the meta description to prevent truncation'
      });
    }
  }

  // --- H1 Validation ---
  if (isEmpty(pageData.h1Text) || pageData.h1Count === 0) {
    issues.push({
      type: 'missing_h1',
      severity: 'error',
      field: 'h1',
      message: 'H1 heading is missing',
      suggestion: 'Add a single, descriptive H1 heading to the page'
    });
  } else if (pageData.h1Count > 1) {
    issues.push({
      type: 'multiple_h1',
      severity: 'warning',
      field: 'h1',
      message: `Multiple H1 headings found (${pageData.h1Count}). Recommended: 1`,
      suggestion: 'Use only one H1 heading per page for better SEO'
    });
  }

  // --- Canonical Validation ---
  if (pageData.isCanonicalMissing || isEmpty(pageData.canonicalUrl)) {
    issues.push({
      type: 'missing_canonical',
      severity: 'warning',
      field: 'canonical',
      message: 'Missing (Using page URL as fallback)',
      suggestion: 'Add a <link rel="canonical" href="..."> tag to prevent duplicate content issues'
    });
  }

  // --- HTTP Status Validation ---
  if (pageData.statusCode) {
    if (pageData.statusCode >= 300 && pageData.statusCode < 400) {
      issues.push({
        type: 'redirect',
        severity: 'warning',
        field: 'status',
        message: `Page redirects (${pageData.statusCode})`,
        suggestion: 'Update internal links to point directly to the final URL'
      });
    }
    if (pageData.statusCode >= 400 && pageData.statusCode < 500) {
      issues.push({
        type: 'client_error',
        severity: 'error',
        field: 'status',
        message: `Client error (${pageData.statusCode})`,
        suggestion: 'Fix or remove broken pages. Update any links pointing to this URL'
      });
    }
    if (pageData.statusCode >= 500) {
      issues.push({
        type: 'server_error',
        severity: 'error',
        field: 'status',
        message: `Server error (${pageData.statusCode})`,
        suggestion: 'Investigate server-side issues causing this error'
      });
    }
  }

  // --- Content/Word Count Validation ---
  const isListing = pageData.pageType === 'listing';
  
  if (pageData.wordCount < 100) {
    issues.push({
      type: 'thin_content',
      severity: isListing ? 'warning' : 'error',
      field: 'content',
      message: `Very thin content (${pageData.wordCount} words). Minimum recommended: 300`,
      suggestion: isListing ? 'Consider expanding category descriptions if applicable' : 'Add substantial, unique content to this page (at least 300 words)'
    });
  } else if (pageData.wordCount < 300) {
    issues.push({
      type: 'weak_content',
      severity: 'warning',
      field: 'content',
      message: `Low word count (${pageData.wordCount} words). Recommended: 300+`,
      suggestion: 'Consider expanding the content for better SEO performance'
    });
  }

  // --- Schema Validation ---
  if (!pageData.schemaJson || (Array.isArray(pageData.schemaJson) && pageData.schemaJson.length === 0)) {
    issues.push({
      type: 'missing_schema',
      severity: 'warning',
      field: 'schema',
      message: 'No structured data (JSON-LD schema) found',
      suggestion: 'Add relevant schema markup (Organization, WebPage, BreadcrumbList, etc.)'
    });
  }

  // --- Open Graph Validation ---
  if (!pageData.ogTags || Object.keys(pageData.ogTags).length === 0) {
    issues.push({
      type: 'missing_og',
      severity: 'warning',
      field: 'og_tags',
      message: 'Open Graph tags are missing',
      suggestion: 'Add og:title, og:description, og:image tags for better social sharing'
    });
  }

  // --- Performance Validation ---
  if (pageData.loadTimeMs > 5000) {
    issues.push({
      type: 'slow_page',
      severity: 'warning',
      field: 'performance',
      message: `Page load time is high (${(pageData.loadTimeMs / 1000).toFixed(1)}s)`,
      suggestion: 'Optimize page speed: compress images, minimize JS/CSS, enable caching'
    });
  }
  if (pageData.loadTimeMs > 10000) {
    issues.push({
      type: 'very_slow_page',
      severity: 'error',
      field: 'performance',
      message: `Page load time is critically high (${(pageData.loadTimeMs / 1000).toFixed(1)}s)`,
      suggestion: 'Urgent: Page takes too long to load. Major performance optimization needed'
    });
  }

  // --- Internal Links ---
  if (pageData.internalLinksCount === 0) {
    issues.push({
      type: 'no_internal_links',
      severity: 'warning',
      field: 'links',
      message: 'No internal links found on this page',
      suggestion: 'Add internal links to improve site structure and crawlability'
    });
  }

  return issues;
}

/**
 * Get severity summary from issues
 */
function getIssueSeverityCounts(issues) {
  return {
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warning').length,
    total: issues.length
  };
}

module.exports = { validatePage, getIssueSeverityCounts };
