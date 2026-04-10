// scripts/generate.js
// Reads config.json, queries the GitHub Projects v2 GraphQL API for each
// configured project (with full pagination), maps every item to a normalised
// shape using fieldMappings, merges the results, and writes docs/data.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname }                        from 'node:path';
import { fileURLToPath }                           from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8'));
const { org, projects: projectNumbers, fieldMappings } = config;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error('Error: GITHUB_TOKEN environment variable is not set.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GraphQL client
// ---------------------------------------------------------------------------

const GH_GRAPHQL = 'https://api.github.com/graphql';

async function graphql(query, variables = {}) {
  const res = await fetch(GH_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'User-Agent':    'margo-roadmap-dashboard/1.0',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API HTTP error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
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
 * fieldMappings.  url is always sourced from content since it is not a
 * project field.
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
    url: rawItem.content?.url ?? null,
  };

  // Apply every logical-key → GitHub-field-name mapping from config.
  for (const [logicalKey, githubFieldName] of Object.entries(fieldMappings)) {
    item[logicalKey] = byFieldName[githubFieldName] ?? null;
  }

  // Fallback: if title wasn't captured via fieldMappings, use content.title.
  if (item.title == null) {
    item.title = rawItem.content?.title ?? null;
  }

  return item;
}

// ---------------------------------------------------------------------------
// Paginated fetch for one project
// ---------------------------------------------------------------------------

async function fetchAllItems(projectNumber) {
  const items  = [];
  let cursor   = null;
  let page     = 0;

  console.log(`  Fetching project #${projectNumber} from org "${org}"...`);

  while (true) {
    page++;
    console.log(`    Page ${page}${cursor ? ` (cursor: ${cursor.slice(0, 12)}…)` : ''}`);

    const data    = await graphql(PROJECT_ITEMS_QUERY, { org, projectNumber, cursor });
    const project = data.organization.projectV2;

    if (page === 1) {
      console.log(`    Project title: "${project.title}"`);
    }

    const { nodes, pageInfo } = project.items;

    for (const rawItem of nodes) {
      items.push(mapItem(rawItem));
    }

    console.log(`    +${nodes.length} items  (running total: ${items.length})`);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return items;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Margo roadmap dashboard — data generation ===');
  console.log(`Org:             ${org}`);
  console.log(`Projects:        ${projectNumbers.join(', ')}`);
  console.log(`Field mappings:  ${Object.entries(fieldMappings).map(([k, v]) => `${k}→"${v}"`).join(', ')}`);
  console.log('');

  const allItems = [];

  for (const projectNumber of projectNumbers) {
    const items = await fetchAllItems(projectNumber);
    allItems.push(...items);
    console.log(`  Done — ${items.length} items from project #${projectNumber}\n`);
  }

  console.log(`Total items across all projects: ${allItems.length}`);

  // Write output — create docs/ if it doesn't exist yet.
  const docsDir = resolve(ROOT, 'docs');
  mkdirSync(docsDir, { recursive: true });

  const outPath = resolve(docsDir, 'data.json');
  writeFileSync(outPath, JSON.stringify(allItems, null, 2), 'utf8');

  console.log(`\nWrote ${allItems.length} items → ${outPath}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
