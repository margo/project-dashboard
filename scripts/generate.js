// scripts/generate.js
// Reads config.json, queries the GitHub Projects v2 GraphQL API for each
// configured project (with full pagination), maps every item to a normalised
// shape using fieldMappings, merges the results, and writes docs/data.json.

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

// Normalise projects object → array of { key, number, label }
const projectList = Object.entries(projects).map(([key, { number, label }]) => ({
  key,
  number,
  label,
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

const GH_GRAPHQL  = 'https://api.github.com/graphql';
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
// Query
// ---------------------------------------------------------------------------

const PROJECT_ITEMS_QUERY = `
  query FetchProjectItems($org: String!, $projectNumber: Int!, $cursor: String) {
    organization(login: $org) {
      projectV2(number: $projectNumber) {
        title
        items(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            content {
              ... on Issue {
                url
                title
              }
              ... on PullRequest {
                url
                title
              }
              ... on DraftIssue {
                title
              }
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
 * fieldMappings.  url and title are always sourced from content since
 * title is no longer in fieldMappings and url is never a project field.
 * source is stamped in by the caller.
 */
function mapItem(rawItem) {
  // Index all fieldValues by their GitHub project field name.
  const byFieldName = {};
  for (const fv of rawItem.fieldValues.nodes) {
    const fieldName = fv.field?.name;
    if (!fieldName) continue; // unrecognised fragment type — skip
    byFieldName[fieldName] = extractValue(fv);
  }

  const item = {
    title: rawItem.content?.title ?? null,
    url:   rawItem.content?.url   ?? null,
  };

  // Apply every logical-key → GitHub-field-name mapping from config.
  for (const [logicalKey, githubFieldName] of Object.entries(fieldMappings)) {
    item[logicalKey] = byFieldName[githubFieldName] ?? null;
  }

  return item;
}

// ---------------------------------------------------------------------------
// Paginated fetch for one project
// ---------------------------------------------------------------------------

async function fetchAllItems({ key, number, label }) {
  const items  = [];
  let cursor   = null;
  let page     = 0;

  console.log(`  Fetching project #${number} "${label}" (${key}) from org "${org}"...`);

  while (true) {
    page++;
    console.log(`    Page ${page}${cursor ? ` (cursor: ${cursor.slice(0, 12)}…)` : ''}`);

    const data    = await graphql(PROJECT_ITEMS_QUERY, { org, projectNumber: number, cursor });
    const project = data.organization.projectV2;

    if (page === 1) {
      console.log(`    Project title: "${project.title}"`);
    }

    const { nodes, pageInfo } = project.items;

    for (const rawItem of nodes) {
      items.push({ ...mapItem(rawItem), source: key });
    }

    console.log(`    +${nodes.length} items  (running total: ${items.length})`);

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
    currentRelease:  config.currentRelease  ?? null,
    nextReleaseDate: config.nextReleaseDate ?? null,
    themes:          config.themes          ?? [],
    releases:        config.releases        ?? [],
    groupBy:         config.groupBy         ?? 'theme',
    projects:        config.projects        ?? {},
    generatedAt:     new Date().toUTCString(),
  };

  const payload   = JSON.stringify({ items, meta }).replace(/</g, '\\u003c');
  const injection = `<script>window.__DASHBOARD__ = ${payload};<\/script>`;

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
