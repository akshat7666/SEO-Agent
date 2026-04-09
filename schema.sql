-- Run this script in your Supabase SQL Editor to create the necessary tables.

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    target_url TEXT NOT NULL,
    status TEXT DEFAULT 'running',
    total_discovered INTEGER DEFAULT 0,
    total_crawled INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    avg_score INTEGER DEFAULT 0,
    site_score INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now()),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS pages (
    id SERIAL PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    original_url TEXT NOT NULL,
    domain TEXT,
    subdomain TEXT,
    final_url TEXT,
    status_code INTEGER,
    is_redirect INTEGER DEFAULT 0,
    redirect_chain TEXT,
    title TEXT,
    title_length INTEGER,
    meta_description TEXT,
    meta_description_length INTEGER,
    h1_text TEXT,
    h1_count INTEGER,
    h2_count INTEGER DEFAULT 0,
    h3_count INTEGER DEFAULT 0,
    h4_count INTEGER DEFAULT 0,
    h5_count INTEGER DEFAULT 0,
    h6_count INTEGER DEFAULT 0,
    heading_structure_score INTEGER DEFAULT 0,
    canonical_url TEXT,
    word_count INTEGER,
    schema_json TEXT,
    og_tags TEXT,
    internal_links_count INTEGER,
    external_links_count INTEGER,
    broken_internal_links_count INTEGER DEFAULT 0,
    broken_external_links_count INTEGER DEFAULT 0,
    image_count INTEGER DEFAULT 0,
    images_missing_alt_count INTEGER DEFAULT 0,
    images_with_alt_count INTEGER DEFAULT 0,
    page_type TEXT,
    load_time_ms INTEGER,
    score INTEGER,
    score_breakdown TEXT,
    issues TEXT,
    crawl_status TEXT DEFAULT 'pending',
    crawl_attempts INTEGER DEFAULT 0,
    error_message TEXT,
    last_crawled TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now()),
    UNIQUE(session_id, original_url),
    UNIQUE(original_url)
);

CREATE INDEX IF NOT EXISTS idx_pages_session_status ON pages(session_id, crawl_status);
CREATE INDEX IF NOT EXISTS idx_pages_session_score ON pages(session_id, score);
CREATE INDEX IF NOT EXISTS idx_pages_session_status_code ON pages(session_id, status_code);
CREATE INDEX IF NOT EXISTS idx_pages_session_domain ON pages(session_id, domain);
CREATE INDEX IF NOT EXISTS idx_pages_session_updated_at ON pages(session_id, updated_at DESC);
