#!/bin/bash
# GSF Page SEO Diagnostic
# Usage: bash seo_check.sh
# Or paste directly into Claude Code

URL="https://greensoftware.foundation/policy/research/sci-csrd-compliance"
SITEMAP="https://greensoftware.foundation/sitemap.xml"

echo "================================================"
echo "  GSF SEO Diagnostic"
echo "  Target: $URL"
echo "================================================"
echo ""

# 1. HTTP status & redirect chain
echo "--- 1. HTTP Status & Redirect Chain ---"
curl -sI -L --max-redirs 5 "$URL" 2>&1 | grep -E "HTTP/|location:|Location:"
echo ""

# 2. Canonical tag
echo "--- 2. Canonical Tag ---"
CANONICAL=$(curl -sL "$URL" | grep -i 'rel="canonical"' | sed 's/.*href="\([^"]*\)".*/\1/')
if [ -z "$CANONICAL" ]; then
  echo "⚠️  No canonical tag found"
else
  echo "✅ Canonical: $CANONICAL"
  if [ "$CANONICAL" = "$URL" ] || [ "$CANONICAL" = "${URL%/}" ]; then
    echo "✅ Canonical matches target URL"
  else
    echo "⚠️  Canonical does NOT match target URL — this may suppress indexing"
  fi
fi
echo ""

# 3. Robots meta tag
echo "--- 3. Robots Meta Tag ---"
ROBOTS_META=$(curl -sL "$URL" | grep -i 'name="robots"')
if [ -z "$ROBOTS_META" ]; then
  echo "✅ No robots meta tag found (page is indexable by default)"
else
  echo "Found: $ROBOTS_META"
  if echo "$ROBOTS_META" | grep -qi "noindex"; then
    echo "🚫 NOINDEX detected — Google will not index this page"
  else
    echo "✅ No noindex directive"
  fi
fi
echo ""

# 4. X-Robots-Tag HTTP header
echo "--- 4. X-Robots-Tag Header ---"
XROBOTS=$(curl -sI "$URL" | grep -i "x-robots-tag")
if [ -z "$XROBOTS" ]; then
  echo "✅ No X-Robots-Tag header (good)"
else
  echo "Found: $XROBOTS"
  if echo "$XROBOTS" | grep -qi "noindex"; then
    echo "🚫 NOINDEX in header — Google will not index this page"
  fi
fi
echo ""

# 5. robots.txt check
echo "--- 5. robots.txt ---"
ROBOTS_TXT=$(curl -sL "https://greensoftware.foundation/robots.txt")
echo "$ROBOTS_TXT" | head -30
echo ""
if echo "$ROBOTS_TXT" | grep -q "Disallow: /policy"; then
  echo "🚫 /policy path is disallowed in robots.txt"
elif echo "$ROBOTS_TXT" | grep -q "Disallow: /"; then
  echo "⚠️  Broad Disallow found — check manually"
else
  echo "✅ No obvious blocking of /policy/research path"
fi
echo ""

# 6. Sitemap check
echo "--- 6. Sitemap Check ---"
SITEMAP_CONTENT=$(curl -sL "$SITEMAP")
if echo "$SITEMAP_CONTENT" | grep -q "sci-csrd-compliance"; then
  echo "✅ Page found in sitemap.xml"
else
  echo "⚠️  Page NOT found in sitemap.xml — submit it via Google Search Console"
  # Check for sitemap index (multiple sitemaps)
  if echo "$SITEMAP_CONTENT" | grep -q "sitemapindex"; then
    echo "ℹ️  Sitemap index detected — checking sub-sitemaps..."
    SUBSITEMAPS=$(echo "$SITEMAP_CONTENT" | grep -oP '(?<=<loc>)[^<]+')
    for SUB in $SUBSITEMAPS; do
      if curl -sL "$SUB" | grep -q "sci-csrd-compliance"; then
        echo "✅ Found in sub-sitemap: $SUB"
        break
      fi
    done
  fi
fi
echo ""

# 7. Internal linking — does homepage link to the page?
echo "--- 7. Internal Link Check (Homepage) ---"
HOMEPAGE_LINKS=$(curl -sL "https://greensoftware.foundation/" | grep -oP 'href="[^"]*sci-csrd[^"]*"')
if [ -z "$HOMEPAGE_LINKS" ]; then
  echo "⚠️  No direct link to the page found on the homepage"
else
  echo "✅ Homepage links to page:"
  echo "$HOMEPAGE_LINKS"
fi
echo ""

# 8. Page title & meta description
echo "--- 8. Title & Meta Description ---"
TITLE=$(curl -sL "$URL" | grep -oP '(?<=<title>)[^<]+')
META_DESC=$(curl -sL "$URL" | grep -i 'name="description"' | grep -oP 'content="[^"]*"')
echo "Title: $TITLE"
echo "Meta desc: $META_DESC"
echo ""

echo "================================================"
echo "  Diagnostic Complete"
echo "  Next step: Paste the target URL into"
echo "  Google Search Console > URL Inspection"
echo "  and hit 'Request Indexing'"
echo "================================================"
