// scripts/generate.js
// Reads config.json, queries the GitHub Projects v2 GraphQL API for each
// configured project (with full pagination), maps every item to a normalised
// shape using fieldMappings, merges the results, and writes docs/data.json.
//
// Projects that define a "views" array (e.g. PM Epics) are fetched view-by-
// view so only items surfaced by those curated views are included.  Projects
// without a "views" array are fetched from the top-level project items list.
// Duplicate items (same URL) across multiple views are de-duplicated.

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

// Normalise projects object → array of { key, number, label, views }
const projectList = Object.entries(projects).map(([key, { number, label, views }]) => ({
  key,
  number,
  label,
  views: views ?? [],   // empty array = fetch full project; non-empty = fetch specific views
}));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error('Error: GITHUB_TOKEN environment variable is not set.');
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
    ... on Issue       { url title }
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

// Full-project query (used for TWG and any project without a views list)
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

// View-scoped query (used for PM and any project that specifies views)
const PROJECT_VIEW_ITEMS_QUERY = `
  query FetchViewItems($org: String!, $projectNumber: Int!, $viewNumber: Int!, $cursor: String) {
    organization(login: $org) {
      projectV2(number: $projectNumber) {
        view(number: $viewNumber) {
          name
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { ${ITEM_FIELDS} }
          }
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
 * Convert a raw project item node into the normalised shape defined by
 * fieldMappings.  url and title are always sourced from content.
 * source is stamped in by the caller.
 */
function mapItem(rawItem) {
  const byFieldName = {};
  for (const fv of rawItem.fieldValues.nodes) {
    const fieldName = fv.field?.name;
    if (!fieldName) continue;
    byFieldName[fieldName] = extractValue(fv);
  }

  const item = {
    title: rawItem.content?.title ?? null,
    url:   rawItem.content?.url   ?? null,
  };

  for (const [logicalKey, githubFieldName] of Object.entries(fieldMappings)) {
    item[logicalKey] = byFieldName[githubFieldName] ?? null;
  }

  return item;
}

// ---------------------------------------------------------------------------
// Paginated fetch — full project
// ---------------------------------------------------------------------------

async function fetchAllItems({ key, number, label }) {
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
    for (const rawItem of nodes) items.push({ ...mapItem(rawItem), source: key });
    console.log(`    +${nodes.length} items  (running total: ${items.length})`);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return items;
}

// ---------------------------------------------------------------------------
// Paginated fetch — single project view
// ---------------------------------------------------------------------------

async function fetchAllViewItems({ key, projectNumber, viewNumber }) {
  const items = [];
  let cursor  = null;
  let page    = 0;

  console.log(`    Fetching view #${viewNumber} of project #${projectNumber}...`);

  while (true) {
    page++;
    console.log(`      Page ${page}${cursor ? ` (cursor: ${cursor.slice(0, 12)}…)` : ''}`);

    const data = await graphql(PROJECT_VIEW_ITEMS_QUERY, {
      org,
      projectNumber,
      viewNumber,
      cursor,
    });
    const view = data.organization.projectV2.view;

    if (page === 1) console.log(`      View name: "${view.name}"`);

    const { nodes, pageInfo } = view.items;
    for (const rawItem of nodes) items.push({ ...mapItem(rawItem), source: key });
    console.log(`      +${nodes.length} items  (running total: ${items.length})`);

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
    milestoneLinks:    config.milestoneLinks    ?? {},
    milestoneTooltips: config.milestoneTooltips ?? {},
    generatedAt:       new Date().toUTCString(),
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
  console.log(`Projects:        ${projectList.map(p =>
    `#${p.number} ${p.label}` + (p.views.length ? ` (views: ${p.views.join(', ')})` : '')
  ).join(', ')}`);
  console.log(`Field mappings:  ${Object.entries(fieldMappings).map(([k, v]) => `${k}→"${v}"`).join(', ')}`);
  console.log('');

  const allItems = [];

  for (const project of projectList) {
    if (project.views.length > 0) {
      // Fetch from specific views and merge, de-duplicating by URL.
      console.log(`  Fetching project #${project.number} "${project.label}" via views [${project.views.join(', ')}]...`);
      const seenUrls = new Set();
      let projectTotal = 0;

      for (const viewNumber of project.views) {
        const viewItems = await fetchAllViewItems({
          key: project.key,
          projectNumber: project.number,
          viewNumber,
        });

        let added = 0;
        for (const item of viewItems) {
          const dedupeKey = item.url || `${item.title}__${item.source}`;
          if (!seenUrls.has(dedupeKey)) {
            seenUrls.add(dedupeKey);
            allItems.push(item);
            added++;
          }
        }
        projectTotal += added;
        console.log(`      ${added} unique items added from view #${viewNumber}`);
      }

      console.log(`  Done — ${projectTotal} unique items from project #${project.number} "${project.label}"\n`);
    } else {
      // Fetch full project items
      const items = await fetchAllItems(project);
      allItems.push(...items);
      console.log(`  Done — ${items.length} items from project #${project.number} "${project.label}"\n`);
    }
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
