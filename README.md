# Margo Roadmap Transparency Dashboard

A publicly accessible, automatically updated dashboard that provides real-time visibility into the Margo project's progress towards its General Availability (GA1) release.

🔗 **Live dashboard:** https://margo.github.io/project-dashboard/

---

## Overview

The Margo Roadmap Dashboard replaces the manual PowerPoint-based reporting process with a live, data-driven view of the community's journey from Preview Release 1 (PR1) through to GA1.

It pulls data automatically from two GitHub Projects every night and renders a colour-coded HTML dashboard accessible to anyone — no GitHub account required.

---

## What the dashboard shows

The dashboard has two main views:

### TWG Features
Shows all `Feature (TWG)` issues from the [TWG Feature Project](https://github.com/orgs/margo/projects/22), grouped by theme (Trust / Flexibility / Robustness). Themes are assigned via GitHub issue labels.

### PM Epics
Shows all `Epic (Child)` issues from the [Product Management Project](https://github.com/orgs/margo/projects/13), displayed as a flat grid scoped to each Preview Release.

### Release sub-tabs
Both views can be filtered by release milestone:

| Sub-tab | Shows |
|---|---|
| **PR1 Completed** | Items with milestone = PR1 |
| **PR2 In Progress** | Items with milestone = PR2 |
| **GA1** | All PR1 + PR2 items combined |

---

## Status colour coding

Items are colour-coded by their current status across a five-state scale:

| Colour | Status | Meaning |
|---|---|---|
| ⬜ Grey | No Owner | Item not yet assigned |
| 🟨 Yellow | Owner Identified | Owner assigned, work not started |
| 🟧 Orange | SUP Initiated | Specification Update Proposal in progress |
| 🟩 Green | SUP Accepted | SUP approved, implementation underway |
| 🟫 Dark Green | Finished | Spec and sandbox complete |

Items with a **thick black border** are assignable directly to the dev team without a SUP required.

---

## Release badges

Every tile displays a coloured badge indicating which Preview Release it belongs to:

| Badge | Release | Colour |
|---|---|---|
| **PR1** | Preview Release 1 — Released 15 Dec 2025 | Dark green |
| **PR2** | Preview Release 2 — In Progress | Margo blue |
| **PR3** | Preview Release 3 — Planned Q4 2026 | Grey |

---

## Data sources

The dashboard reads from two GitHub Projects which remain the sole source of truth:

| Project | URL | Items shown |
|---|---|---|
| PM Product Management | https://github.com/orgs/margo/projects/13 | Epic (Child) issues |
| TWG Feature Project | https://github.com/orgs/margo/projects/22 | Feature (TWG) issues |

No data is duplicated or maintained separately — everything flows from GitHub.

---

## How it works

```
GitHub Projects (#13 + #22)
         ↓
   GitHub Actions
   (nightly 02:00 UTC)
         ↓
  scripts/generate.js
  (GraphQL API query)
         ↓
   docs/data.json
   docs/index.html
         ↓
    GitHub Pages
  (public dashboard)
```

1. A GitHub Action runs nightly at 02:00 UTC
2. `scripts/generate.js` queries both GitHub Projects via the GraphQL API
3. Data is written to `docs/data.json`
4. The HTML dashboard is rendered from the data and written to `docs/index.html`
5. GitHub Pages serves the updated file publicly

The Action can also be triggered manually from the [Actions tab](https://github.com/margo/project-dashboard/actions) using **Run workflow**.

---

## Repository structure

```
project-dashboard/
├── .github/
│   └── workflows/
│       └── generate-dashboard.yml   # Scheduled GitHub Action
├── scripts/
│   └── generate.js                  # GraphQL query + HTML renderer
├── templates/
│   └── dashboard.html               # HTML/CSS/JS template
├── docs/
│   ├── data.json                    # Generated data (committed by Action)
│   └── index.html                   # Generated dashboard (committed by Action)
├── config.json                      # Field mappings and release config
└── README.md                        # This file
```

---

## Configuration

All configurable values live in `config.json`:

```json
{
  "org": "margo",
  "projects": {
    "pm": { "number": 13, "label": "PM Epics" },
    "twg": { "number": 22, "label": "TWG Features" }
  },
  "releases": ["PR1", "PR2", "PR3", "GA1"],
  "currentRelease": "PR2",
  "nextReleaseDate": "2026-06-30",
  "themes": ["Trust", "Flexibility", "Robustness"]
}
```

### Updating the next release date
Edit `nextReleaseDate` in `config.json` and commit. The dashboard will reflect the new date on the next Action run.

### Adding a new release
Add the new release label to the `releases` array in `config.json`.

---

## Tagging guide

The dashboard is driven entirely by tags applied in GitHub. The accuracy of the dashboard depends on items being correctly tagged.

### TWG Features (Arman / TWG group)

Apply GitHub **labels** to each `Feature (TWG)` issue:

| Label | Purpose |
|---|---|
| `Trust` | Assigns item to the Trust theme row |
| `Flexibility` | Assigns item to the Flexibility theme row |
| `Robustness` | Assigns item to the Robustness theme row |

New theme labels can be created freely — the dashboard detects them dynamically and creates new theme rows automatically.

### PM Epics (Josh / PM group)

Ensure each `Epic (Child)` issue has:

| Field | Values |
|---|---|
| **Milestone** | PR1 / PR2 / PR3 / GA1 |
| **Status** | Current status value |
| **Type** | Epic (Child) |

---

## Running locally

To regenerate the dashboard locally:

```bash
# Install dependencies
npm install

# Set your GitHub token (needs read:org, repo, read:project scopes)
export GH_TOKEN=your_personal_access_token

# Run the generator
node scripts/generate.js

# Open the dashboard
open docs/index.html
```

---

## GitHub Action setup

The Action requires a repository secret named `GH_PROJECT_TOKEN` containing a GitHub Personal Access Token with the following scopes:

| Scope | Purpose |
|---|---|
| `read:org` | Query organisation Projects via GraphQL |
| `repo` | Read linked issue data |
| `read:project` | Access Projects V2 data |

To add or update the secret go to:
**Settings → Secrets and variables → Actions → New repository secret**

---

## Contributing

To request changes or enhancements, please raise a GitHub issue in this repository. Tag it with one of:

- `enhancement` — new feature request
- `bug` — something isn't displaying correctly
- `data` — tagging or field mapping issue

---

## Contacts

| Name | Role |
|---|---|
| Sean McIlroy | Programme Manager, Linux Foundation — dashboard owner |
| Bart Nieuwborg | Margo Chair — sign-off authority |
| Arman | TWG Chair — TWG feature tagging |
| Josh Abbott | PM group — PM epic tagging |

---

## Phase 2 enhancements (backlog)

The following items are noted for future consideration:

- GA Release Train vs. Contribution Lane split view
- Filter bar (by theme, release, status, or source)
- Webhook trigger for real-time updates (currently nightly)
- Snapshot date label matching the PPT format
- Tooltip explanations on tab headers for non-GitHub users

---

*Generated by the Margo roadmap dashboard generator · Data sourced from GitHub Projects · Linux Foundation / Margo Programme*
