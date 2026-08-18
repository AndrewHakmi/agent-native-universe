# ANU Observer design system

## Product and job

ANU Observer is a read-only scientific instrument for inspecting artificial universes. It lets a researcher compare runs, scrub through time, inspect the evolving graph, locate pressure events, and audit evidence without becoming a hidden orchestrator. The interface must communicate measured facts, hypotheses, and construction artifacts distinctly.

Primary screens:

- Population atlas: independent universes, Pareto-relevant metrics, run status, and reproducibility identifiers.
- Universe observatory: time slider, topology graph, event stream, resource flow, metrics, and pressure markers.
- Evidence detail: manifest, hashes, replay status, config, and downloadable machine-readable artifacts.

## Visual direction: scientific cartography

Use a technical mosaic-grid structure inspired by architectural drawings and instrument paper, adapted for a dense research dashboard rather than a landing page. The memorable motif is a pale atlas sheet on which the agent graph appears as a living piece of cartography. Use hairline rules, coordinate labels, registration marks, and small monospaced annotations. Avoid generic dark SaaS cards, neon purple gradients, glassmorphism, soft pill-heavy UI, and decorative 3D.

## Tokens

- Canvas: `#F3F1E8` (warm instrument paper).
- Surface: `#FAF9F3`.
- Ink: `#172019`.
- Muted ink: `#5E685F`.
- Hairline: `rgba(23, 32, 25, 0.18)`.
- Primary: `#183D2B` (deep research green).
- Signal: `#FF6B4A` (event/correlation coral).
- Pressure: `#E5A50A` (amber).
- Positive: `#16835B`.
- Fault: `#B53A32`.
- Selection: `#B8E0C4`.

Typography:

- Display and headings: `Instrument Sans`, fallback `Avenir Next`, sans-serif. Tight but readable; avoid oversized marketing typography.
- Data and labels: `DM Mono`, fallback `IBM Plex Mono`, monospace.
- Body: `Instrument Sans`, 15–17px, line-height 1.5.
- Metadata: 10–12px uppercase mono with `0.08em` tracking.

Geometry:

- 1px hairline borders; no shadows and no gradients.
- Radius: 0 for structural panels, 2px only for inputs/compact controls.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48px.
- Desktop layout: 12-column atlas grid; left run rail 240px, central graph, right evidence inspector 320px.
- Mobile: single column; graph remains primary, inspectors become stacked disclosure panels.

## Components

- Status mark: square 7px indicator + uppercase mono label, never a rounded pill.
- Metric cell: label, exact value, compact delta; border-separated within a continuous grid.
- Universe tile: run ID, seed fingerprint, final status, three key metrics, miniature graph glyph.
- Timeline: full-width ruled track with tick labels and triangular pressure markers; keyboard accessible.
- Graph: SVG/canvas nodes sized by resource throughput, edge width by link strength, explicit legend, selected node inspector. Motion is subtle and disabled under `prefers-reduced-motion`.
- Evidence row: sequence, tick, typed event, actor/target, hash status. JSON details expand inline.
- Fact labels: `MEASURED`, `BY CONSTRUCTION`, `HYPOTHESIS`, `NOT OBSERVED`; visually distinct and used consistently.

## Interaction and motion

- The UI is read-only. Controls only filter, select, scrub, compare, expand, or export evidence.
- Initial load reveals the atlas grid in a restrained 240ms stagger.
- Graph transitions use 180ms ease-out; pressure markers use no looping glow.
- Focus states use a 2px coral outline with 2px offset.
- Every interactive element works with keyboard navigation and has an accessible name.
- Respect `prefers-reduced-motion` and maintain WCAG AA contrast.

## Content rules

- Never label an agent by a profession or inferred role without evidence. Prefer behavioral statements such as “87% verification actions”.
- Never call automatic folding proof of emergence; label it `BY CONSTRUCTION`.
- Show seed, config digest, event-chain status, and replay digest prominently.
- Keep raw measurements separate from interpretations and hypotheses.
