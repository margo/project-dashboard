// scripts/generate.js
// Reads config.json, queries the GitHub Projects v2 GraphQL API for each
// configured project (with full pagination), maps every item to a normalised
// shape, and writes docs/data.json.
//
// Fields sourced from GitHub Project custom fields (via fieldValues):
//   status  → "Status" single-select
//   pr1     → "PR1"    single-select (PM project only, via per-project override)
//
// Fields sourced directly from the Issue content node (not project fields):
//   type    → issue.issueType.name  (org-level issue type, e.g. "Epic (Child)")
//   release → issue.milestone.title (standard GitHub milestone, e.g. "PR2")

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname }                        from 'node:path';
import { fileURLToPath }                           from 'node:url';
import { execFile }                                from 'node:child_process';
import { promisify }                               from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8'));
const { org, projects, fieldMappings } = config;

// Normalise projects object → array of { key, number, label, views, effectiveMappings }
// Each project inherits the global fieldMappings and can override individual keys.
const projectList = Object.entries(projects).map(([key, proj]) => ({
  key,
  number: proj.number,
  label:  proj.label,
  // Merge global fieldMappings with any per-project overrides declared in config.
  effectiveMappings: { ...fieldMappings, ...(proj.fieldMappings ?? {}) },
}));

const GITHUB_TOKEN = process.env.GH_TOKEN;
if (!GITHUB_TOKEN) {
  console.error('Error: GH_TOKEN environment variable is not set.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GraphQL client
//
// Node's built-in fetch (undici) does not honour HTTPS_PROXY, so we shell
// out to curl, which picks up the proxy automatically from the environment.
// ---------------------------------------------------------------------------

const GH_GRAPHQL    = 'https://api.github.com/graphql';
const execFileAsync = promisify(execFile);

async function graphql(query, variables = {}) {
  const { stdout } = await execFileAsync('curl', [
    '--silent',
    '--show-error',
    '-X', 'POST',
    '-H', `Authorization: Bearer ${GITHUB_TOKEN}`,
    '-H', 'Content-Type: application/json',
    '-H', 'User-Agent: margo-roadmap-dashboard/1.0',
    '--data', JSON.stringify({ query, variables }),
    GH_GRAPHQL,
  ], { maxBuffer: 50 * 1024 * 1024 });

  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`GitHub API returned non-JSON: ${stdout.slice(0, 300)}`);
  }

  if (json.errors?.length) {
    throw new Error(`GraphQL errors:\n${json.errors.map(e => e.message).join('\n')}`);
  }

  return json.data;
}

// ---------------------------------------------------------------------------
// Shared item fragment (same fields used in both query types)
// ---------------------------------------------------------------------------

const ITEM_FIELDS = `
  content {
    ... on Issue {
      url
      title
      issueType { name }
      milestone { title }
      labels(first: 10) {
        nodes { name }
      }
      subIssues(first: 20) {
        totalCount
        nodes {
          title
          url
          state
          number
          issueType { name }
        }
      }
    }
    ... on PullRequest { url title }
    ... on DraftIssue  { title }
  }
  fieldValues(first: 30) {
    nodes {
      ... on ProjectV2ItemFieldTextValue {
        text
        field { ... on ProjectV2FieldCommon { name } }
      }
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field { ... on ProjectV2FieldCommon { name } }
      }
      ... on ProjectV2ItemFieldDateValue {
        date
        field { ... on ProjectV2FieldCommon { name } }
      }
      ... on ProjectV2ItemFieldNumberValue {
        number
        field { ... on ProjectV2FieldCommon { name } }
      }
      ... on ProjectV2ItemFieldIterationValue {
        title
        field { ... on ProjectV2FieldCommon { name } }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const PROJECT_ITEMS_QUERY = `
  query FetchProjectItems($org: String!, $projectNumber: Int!, $cursor: String) {
    organization(login: $org) {
      projectV2(number: $projectNumber) {
        title
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ${ITEM_FIELDS} }
        }
      }
    }
  }
`;


// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

/**
 * Pull the scalar value out of a fieldValues union node.
 * Nodes that don't match any queried fragment come back as {} — those
 * will have no field.name and are skipped by the caller.
 */
function extractValue(node) {
  if (node.text   !== undefined) return node.text;    // TextValue
  if (node.date   !== undefined) return node.date;    // DateValue
  if (node.number !== undefined) return node.number;  // NumberValue
  if (node.name   !== undefined) return node.name;    // SingleSelectValue (option name)
  if (node.title  !== undefined) return node.title;   // IterationValue
  return null;
}

/**
 * Convert a raw project item node into the normalised shape.
 *
 * - url, title          — from content (all item types)
 * - type                — from content.issueType.name (org-level issue type)
 * - release             — from content.milestone.title (standard GitHub milestone)
 * - everything else     — from fieldValues, mapped via effectiveMappings
 *
 * source is stamped in by the caller.
 */
function mapItem(rawItem, effectiveMappings) {
  // Project custom fields (fieldValues)
  const byFieldName = {};
  for (const fv of rawItem.fieldValues.nodes) {
    const fieldName = fv.field?.name;
    if (!fieldName) continue;
    byFieldName[fieldName] = extractValue(fv);
  }

  const item = {
    title:   rawItem.content?.title                   ?? null,
    url:     rawItem.content?.url                     ?? null,
    // Issue-level fields — not project custom fields
    type:    rawItem.content?.issueType?.name         ?? null,
    release: rawItem.content?.milestone?.title        ?? null,
    // Sub-issues (nested issues) — fetched in same request, up to 20
    subIssues: (rawItem.content?.subIssues?.nodes ?? []).map(n => ({
      title:     n.title,
      url:       n.url,
      state:     n.state,
      number:    n.number,
      issueType: n.issueType?.name ?? null,
    })),
    subIssueCount: rawItem.content?.subIssues?.totalCount ?? 0,
  };

  for (const [logicalKey, githubFieldName] of Object.entries(effectiveMappings)) {
    item[logicalKey] = byFieldName[githubFieldName] ?? null;
  }

  // Derive theme from GitHub issue labels (case-insensitive match against config themes).
  // This overrides any project custom field value for "theme".
  const knownThemes = config.themes ?? [];
  const labelNames  = (rawItem.content?.labels?.nodes ?? []).map(n => n.name);
  const themeLabel  = labelNames.find(n =>
    knownThemes.some(t => t.toLowerCase() === n.toLowerCase())
  );
  if (themeLabel) {
    // Normalise to config casing (e.g. "trust" → "Trust")
    item.theme = knownThemes.find(t => t.toLowerCase() === themeLabel.toLowerCase()) ?? themeLabel;
  }

  return item;
}

// ---------------------------------------------------------------------------
// Paginated fetch — full project
// ---------------------------------------------------------------------------

async function fetchAllItems({ key, number, label, effectiveMappings }) {
  const items = [];
  let cursor  = null;
  let page    = 0;

  console.log(`  Fetching project #${number} "${label}" (${key}) from org "${org}"...`);

  while (true) {
    page++;
    console.log(`    Page ${page}${cursor ? ` (cursor: ${cursor.slice(0, 12)}…)` : ''}`);

    const data    = await graphql(PROJECT_ITEMS_QUERY, { org, projectNumber: number, cursor });
    const project = data.organization.projectV2;

    if (page === 1) console.log(`    Project title: "${project.title}"`);

    const { nodes, pageInfo } = project.items;

    // On the first page, log every unique field name seen in fieldValues so
    // mismatches between config fieldMappings and actual GitHub field names
    // are immediately visible in Action logs.
    if (page === 1) {
      const seen = new Set();
      for (const rawItem of nodes) {
        for (const fv of rawItem.fieldValues.nodes) {
          if (fv.field?.name) seen.add(fv.field.name);
        }
      }
      console.log(`    Field names in GitHub project: ${[...seen].sort().map(n => `"${n}"`).join(', ')}`);
      const mapped   = Object.values(effectiveMappings);
      const unmapped = [...seen].filter(n => !mapped.includes(n));
      const missing  = mapped.filter(n => !seen.has(n));
      if (missing.length)  console.log(`    ⚠ Mapped fields NOT found in data: ${missing.map(n => `"${n}"`).join(', ')}`);
      if (unmapped.length) console.log(`    ℹ Unmapped fields available: ${unmapped.map(n => `"${n}"`).join(', ')}`);
    }

    for (const rawItem of nodes) items.push({ ...mapItem(rawItem, effectiveMappings), source: key });
    console.log(`    +${nodes.length} items  (running total: ${items.length})`);

    // After the last page, log distinct type and release values to confirm
    // issueType and milestone are populating correctly.
    if (!pageInfo.hasNextPage) {
      const types    = [...new Set(items.map(i => i.type).filter(Boolean))].sort();
      const releases = [...new Set(items.map(i => i.release).filter(Boolean))].sort();
      console.log(`    Issue types seen:   ${types.length    ? types.map(t => `"${t}"`).join(', ')    : '(none — issueType may not be set)'}`);
      console.log(`    Milestones seen:    ${releases.length ? releases.map(r => `"${r}"`).join(', ') : '(none — milestone may not be set)'}`);
    }

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return items;
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

/**
 * Reads templates/dashboard.html, injects the items array and config metadata
 * as window.__DASHBOARD__ via a <script> tag, and returns the final HTML string.
 *
 * '<' is escaped to '\u003c' inside the JSON payload so it can never break
 * out of the surrounding <script> block, regardless of item titles or URLs.
 */
function renderHtml(items) {
  const templatePath = resolve(ROOT, 'templates', 'dashboard.html');
  const template     = readFileSync(templatePath, 'utf8');

  const meta = {
    currentRelease:    config.currentRelease    ?? null,
    nextReleaseDate:   config.nextReleaseDate   ?? null,
    themes:            config.themes            ?? [],
    releases:          config.releases          ?? [],
    groupBy:           config.groupBy           ?? 'theme',
    projects:          config.projects          ?? {},
    statusMap:         config.statusMap         ?? {},
    releaseDates:      config.releaseDates      ?? {},
    milestoneLinks:      config.milestoneLinks      ?? {},
    milestoneTooltips:   config.milestoneTooltips   ?? {},
    milestoneScopeText:  config.milestoneScopeText  ?? {},
    releaseJourneyInfo:  config.releaseJourneyInfo  ?? null,
    themeDescriptions:   config.themeDescriptions   ?? {},
    generatedAt:         new Date().toUTCString(),
  };

  const payload   = JSON.stringify({ items, meta }).replace(/</g, '\\u003c');
  // Concatenate the closing tag so it never appears literally in this source
  // file and can't be confused with a string that the HTML parser would swallow.
  const injection = '<script>window.__DASHBOARD__ = ' + payload + ';<' + '/script>';

  const html = template.replace('<!-- __INJECT_DATA__ -->', injection);
  if (html === template) {
    throw new Error('Template is missing the <!-- __INJECT_DATA__ --> placeholder.');
  }
  return html;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Margo roadmap dashboard — data generation ===');
  console.log(`Org:             ${org}`);
  console.log(`Projects:        ${projectList.map(p => `#${p.number} ${p.label}`).join(', ')}`);
  console.log(`Field mappings:  ${Object.entries(fieldMappings).map(([k, v]) => `${k}→"${v}"`).join(', ')}`);
  console.log('');

  const allItems = [];

  for (const project of projectList) {
    const items = await fetchAllItems(project);
    allItems.push(...items);
    console.log(`  Done — ${items.length} items from project #${project.number} "${project.label}"\n`);
  }

  console.log(`Total items across all projects: ${allItems.length}`);

  // Write output — create docs/ if it doesn't exist yet.
  const docsDir = resolve(ROOT, 'docs');
  mkdirSync(docsDir, { recursive: true });

  const outPath = resolve(docsDir, 'data.json');
  writeFileSync(outPath, JSON.stringify(allItems, null, 2), 'utf8');
  console.log(`Wrote data          → ${outPath}`);

  // Render HTML dashboard from template.
  console.log('\nRendering HTML dashboard...');
  const html     = renderHtml(allItems);
  const htmlPath = resolve(docsDir, 'index.html');
  writeFileSync(htmlPath, html, 'utf8');
  console.log(`Wrote dashboard     → ${htmlPath}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
