/**
 * Dependency-free Observer UI assets.
 *
 * Keeping these assets in the TypeScript build makes the npm package and the
 * hardened Docker image self-contained: no runtime filesystem lookup, bundler,
 * CDN, external font, or third-party script is required.
 */

export const OBSERVER_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#07110f">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="Read-only scientific evidence observer for Agent Native Universe.">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='7' fill='%2387f5bd'/%3E%3Cellipse cx='32' cy='32' rx='9' ry='27' fill='none' stroke='%2387f5bd' stroke-width='3'/%3E%3Cellipse cx='32' cy='32' rx='9' ry='27' fill='none' stroke='%2387f5bd' stroke-width='3' transform='rotate(60 32 32)'/%3E%3Cellipse cx='32' cy='32' rx='9' ry='27' fill='none' stroke='%2387f5bd' stroke-width='3' transform='rotate(120 32 32)'/%3E%3C/svg%3E">
  <title>ANU Observer</title>
  <link rel="stylesheet" href="/assets/observer.css">
  <script src="/assets/observer.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#workspace">Skip to evidence workspace</a>

  <header class="topbar">
    <a class="brand" href="/" aria-label="Agent Native Universe Observer home">
      <span class="brand-mark" aria-hidden="true">
        <span></span><span></span><span></span>
      </span>
      <span class="brand-copy">
        <strong>ANU</strong>
        <small>Observer</small>
      </span>
    </a>

    <div class="topbar-context" aria-label="Observer mode">
      <span class="eyebrow">UNIVERSE LAB / GENESIS-1</span>
      <span class="read-only"><span aria-hidden="true"></span>Read-only evidence</span>
    </div>

    <div class="topbar-actions">
      <div class="connection" id="connection-status" role="status" aria-live="polite">
        <span class="connection-dot" aria-hidden="true"></span>
        <span>Connecting</span>
      </div>
      <button class="button button-quiet token-clear" id="clear-token" type="button" hidden>
        Lock session
      </button>
      <button class="icon-button" id="refresh-all" type="button" aria-label="Refresh observer data" title="Refresh">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M18.7 9A7 7 0 0 0 6.1 6.1L4 8m16 8-2.1 1.9A7 7 0 0 1 5.3 15"/></svg>
      </button>
    </div>
  </header>

  <div class="shell">
    <aside class="run-panel" aria-labelledby="runs-heading">
      <div class="panel-heading">
        <div>
          <span class="section-index">01</span>
          <h1 id="runs-heading">Evidence runs</h1>
        </div>
        <span class="count-badge" id="run-count">0</span>
      </div>

      <label class="search-field">
        <span class="sr-only">Search runs</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
        <input id="run-search" type="search" autocomplete="off" placeholder="Universe or run ID">
        <kbd>/</kbd>
      </label>

      <div class="segmented" role="group" aria-label="Filter evidence runs">
        <button type="button" data-run-filter="all" aria-pressed="true">All</button>
        <button type="button" data-run-filter="complete" aria-pressed="false">Complete</button>
        <button type="button" data-run-filter="active" aria-pressed="false">Active</button>
      </div>

      <div class="run-list" id="run-list" aria-live="polite">
        <div class="list-skeleton" aria-label="Loading evidence runs">
          <span></span><span></span><span></span>
        </div>
      </div>

      <div class="panel-footnote">
        <span class="footnote-mark" aria-hidden="true">i</span>
        <p>Evidence is immutable. This surface cannot start, pause, or alter a universe.</p>
      </div>
    </aside>

    <main class="workspace" id="workspace" tabindex="-1">
      <section class="welcome" id="welcome-view" aria-labelledby="welcome-title">
        <div class="welcome-orbit" aria-hidden="true">
          <span class="orbit orbit-a"></span>
          <span class="orbit orbit-b"></span>
          <span class="orbit orbit-c"></span>
          <span class="orbit-core"></span>
        </div>
        <span class="section-index">OBSERVER / V1.0</span>
        <h2 id="welcome-title">Watch organization emerge<br>without inventing the story.</h2>
        <p>Select an evidence run to inspect evaluator-backed outcomes, structural signals, event causality, and the deterministic final commitment.</p>
        <div class="welcome-principles" aria-label="Observer guarantees">
          <span>External evaluation</span>
          <span>Finite resources</span>
          <span>Hash-chained evidence</span>
        </div>
      </section>

      <section class="run-view" id="run-view" hidden aria-labelledby="run-title">
        <div class="run-hero">
          <div class="run-identity">
            <div class="breadcrumbs" role="navigation" aria-label="Evidence location">
              <span id="experiment-label">GENESIS-1</span>
              <span aria-hidden="true">/</span>
              <span id="universe-label">U0001</span>
            </div>
            <div class="title-line">
              <h2 id="run-title">Run</h2>
              <span class="status-pill" id="run-status">Complete</span>
            </div>
            <button class="copy-id" id="copy-run-id" type="button" title="Copy run ID">
              <code id="run-id"></code>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
            </button>
          </div>
          <dl class="run-facts">
            <div><dt>Engine</dt><dd id="engine-value">—</dd></div>
            <div><dt>Policy</dt><dd id="policy-value">—</dd></div>
            <div><dt>Seed</dt><dd id="seed-value">—</dd></div>
          </dl>
        </div>

        <section class="metric-section" aria-labelledby="metrics-heading">
          <div class="section-heading">
            <div><span class="section-index">02</span><h3 id="metrics-heading">Outcome at a glance</h3></div>
            <span class="section-note" id="metric-tick">Latest verified tick</span>
          </div>
          <div class="metric-grid">
            <article class="metric metric-primary">
              <div class="metric-top"><span>Task success</span><span class="metric-glyph" aria-hidden="true">↗</span></div>
              <strong id="metric-success">—</strong>
              <small>Evaluator-accepted tasks</small>
            </article>
            <article class="metric">
              <div class="metric-top"><span>Mean quality</span><span class="metric-dot violet" aria-hidden="true"></span></div>
              <strong id="metric-quality">—</strong>
              <small>Across all submissions</small>
            </article>
            <article class="metric">
              <div class="metric-top"><span>Active agents</span><span class="metric-dot cyan" aria-hidden="true"></span></div>
              <strong id="metric-agents">—</strong>
              <small id="metric-agents-note">Role-neutral population</small>
            </article>
            <article class="metric">
              <div class="metric-top"><span>Active links</span><span class="metric-dot amber" aria-hidden="true"></span></div>
              <strong id="metric-links">—</strong>
              <small id="metric-components">Across — components</small>
            </article>
            <article class="metric">
              <div class="metric-top"><span>Evidence events</span><span class="metric-glyph neutral" aria-hidden="true">#</span></div>
              <strong id="metric-events">—</strong>
              <small>Canonical JSONL records</small>
            </article>
          </div>
        </section>

        <div class="analysis-grid">
          <section class="card trend-card" aria-labelledby="trend-heading">
            <div class="card-heading">
              <div>
                <span class="section-index">03</span>
                <h3 id="trend-heading">Emergence signals</h3>
              </div>
              <div class="legend" role="group" aria-label="Chart legend">
                <span><i class="line-success"></i>Success</span>
                <span><i class="line-quality"></i>Quality</span>
                <span><i class="line-density"></i>Density</span>
              </div>
            </div>
            <div class="chart-wrap">
              <svg id="metric-chart" class="metric-chart" viewBox="0 0 760 280" role="img" aria-labelledby="chart-title chart-description">
                <title id="chart-title">Metrics over experiment ticks</title>
                <desc id="chart-description">Task success, mean quality, and network density measured in parts per million.</desc>
              </svg>
              <div class="chart-empty" id="chart-empty" hidden>No metric history is available for this run.</div>
            </div>
            <details class="data-alternative">
              <summary>Accessible data table</summary>
              <div class="table-scroll">
                <table>
                  <thead><tr><th>Tick</th><th>Success</th><th>Quality</th><th>Density</th><th>Agents</th><th>Links</th></tr></thead>
                  <tbody id="metric-table"></tbody>
                </table>
              </div>
            </details>
          </section>

          <section class="card structure-card" aria-labelledby="structure-heading">
            <div class="card-heading">
              <div>
                <span class="section-index">04</span>
                <h3 id="structure-heading">Structural lens</h3>
              </div>
              <span class="status-mini" id="violation-status">No violations</span>
            </div>
            <p class="card-intro">Observed graph properties. No human role labels or inferred job titles are introduced.</p>
            <dl class="signal-list">
              <div>
                <dt><span>Network density</span><output id="signal-density-value">—</output></dt>
                <dd><span id="signal-density"></span></dd>
              </div>
              <div>
                <dt><span>Degree centralization</span><output id="signal-central-value">—</output></dt>
                <dd><span id="signal-central"></span></dd>
              </div>
              <div>
                <dt><span>Behavioral specialization</span><output id="signal-special-value">—</output></dt>
                <dd><span id="signal-special"></span></dd>
              </div>
              <div>
                <dt><span>Resource inequality</span><output id="signal-gini-value">—</output></dt>
                <dd><span id="signal-gini"></span></dd>
              </div>
            </dl>
            <div class="structure-summary">
              <div><span>Components</span><strong id="structure-components">—</strong></div>
              <div><span>Link turnover</span><strong id="structure-turnover">—</strong></div>
              <div><span>P95 latency</span><strong id="structure-latency">—</strong></div>
            </div>
          </section>
        </div>

        <div class="evidence-grid">
          <section class="card integrity-card" aria-labelledby="integrity-heading">
            <div class="card-heading">
              <div><span class="section-index">05</span><h3 id="integrity-heading">Evidence integrity</h3></div>
              <span class="integrity-state" id="attestation-state"><i aria-hidden="true"></i>Checking</span>
            </div>
            <p id="integrity-explanation">Comparing the stored deterministic commitment with the run subject.</p>
            <dl class="hash-list">
              <div><dt>Commitment</dt><dd><code id="commitment-value">—</code><button type="button" data-copy-target="commitment-value">Copy</button></dd></div>
              <div><dt>Final event</dt><dd><code id="event-hash-value">—</code><button type="button" data-copy-target="event-hash-value">Copy</button></dd></div>
              <div><dt>Final state</dt><dd><code id="state-hash-value">—</code><button type="button" data-copy-target="state-hash-value">Copy</button></dd></div>
            </dl>
            <div class="integrity-note">
              <strong>Trust boundary</strong>
              <p>Self-consistency is local evidence. Publish the commitment in an independent append-only system to detect full-host rewrites.</p>
            </div>
          </section>

          <section class="card event-card" aria-labelledby="events-heading">
            <div class="card-heading event-heading">
              <div><span class="section-index">06</span><h3 id="events-heading">Event window</h3></div>
              <div class="event-tools">
                <label><span class="sr-only">Filter events by type</span><select id="event-filter"><option value="">All event types</option></select></label>
                <button class="button button-quiet" id="refresh-events" type="button">Refresh window</button>
              </div>
            </div>
            <div class="event-list" id="event-list" aria-live="polite"></div>
            <div class="event-footer">
              <span id="event-range">No events loaded</span>
              <button class="button button-quiet" id="load-events" type="button" hidden>Load next page</button>
            </div>
          </section>
        </div>
      </section>
    </main>
  </div>

  <dialog class="auth-dialog" id="auth-dialog" aria-labelledby="auth-title">
    <form method="dialog" id="auth-form">
      <button class="dialog-close" value="cancel" aria-label="Close authentication dialog">×</button>
      <span class="auth-mark" aria-hidden="true">ANU</span>
      <span class="section-index">PROTECTED EVIDENCE</span>
      <h2 id="auth-title">Unlock this Observer session</h2>
      <p>The edge requires an application Bearer token in addition to upstream SSO. The token stays in memory and is never persisted by this UI.</p>
      <label>
        <span>Bearer token</span>
        <input id="auth-token" type="password" autocomplete="off" spellcheck="false" required minlength="32" maxlength="4096" placeholder="Paste token">
      </label>
      <p class="auth-error" id="auth-error" role="alert" hidden>That token was not accepted.</p>
      <div class="dialog-actions">
        <button class="button button-primary" id="auth-submit" value="default">Open evidence</button>
        <button class="button button-quiet" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>

  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>

  <noscript>
    <div class="noscript">JavaScript is required for the visual Observer. The machine-readable service contract remains available at <a href="/api">/api</a>.</div>
  </noscript>
</body>
</html>`;

export const OBSERVER_UI_CSS = String.raw`
:root {
  color-scheme: dark;
  --ink: #eef7f2;
  --muted: #8da39a;
  --subtle: #7d948b;
  --canvas: #07110f;
  --panel: #0a1512;
  --raised: #0e1c18;
  --raised-2: #13231e;
  --line: rgba(177, 222, 202, .12);
  --line-strong: rgba(177, 222, 202, .22);
  --green: #87f5bd;
  --green-strong: #41dc91;
  --cyan: #68d9e9;
  --violet: #b79bff;
  --amber: #f0c674;
  --danger: #ff8f8f;
  --radius: 16px;
  --shadow: 0 24px 80px rgba(0, 0, 0, .28);
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { min-width: 320px; background: var(--canvas); scroll-behavior: smooth; }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--ink);
  background:
    radial-gradient(circle at 72% -12%, rgba(62, 195, 129, .09), transparent 34rem),
    linear-gradient(135deg, rgba(255, 255, 255, .014) 1px, transparent 1px);
  background-size: auto, 28px 28px;
  font-size: 14px;
  line-height: 1.5;
}
button, input, select { font: inherit; }
button, select { color: inherit; }
button { cursor: pointer; }
a { color: inherit; }
svg { display: block; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.skip-link {
  position: fixed;
  z-index: 100;
  top: 10px;
  left: 10px;
  padding: 10px 14px;
  color: #04100b;
  background: var(--green);
  border-radius: 8px;
  font-weight: 750;
  transform: translateY(-150%);
  transition: transform .15s ease;
}
.skip-link:focus { transform: translateY(0); }

:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 3px;
}

.topbar {
  position: sticky;
  z-index: 20;
  top: 0;
  height: 72px;
  display: grid;
  grid-template-columns: 286px 1fr auto;
  align-items: center;
  border-bottom: 1px solid var(--line);
  background: rgba(7, 17, 15, .88);
  backdrop-filter: blur(18px);
}

.brand {
  align-self: stretch;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 24px;
  border-right: 1px solid var(--line);
  text-decoration: none;
}
.brand-mark {
  position: relative;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
}
.brand-mark::before,
.brand-mark::after,
.brand-mark span {
  content: "";
  position: absolute;
  border: 1px solid rgba(135, 245, 189, .74);
  border-radius: 50%;
}
.brand-mark::before { inset: 1px 10px; transform: rotate(24deg); }
.brand-mark::after { inset: 1px 10px; transform: rotate(-24deg); }
.brand-mark span:nth-child(1) { inset: 1px 10px; transform: rotate(90deg); }
.brand-mark span:nth-child(2) { width: 5px; height: 5px; background: var(--green); border: 0; box-shadow: 0 0 12px var(--green); }
.brand-mark span:nth-child(3) { inset: 5px; opacity: .3; }
.brand-copy { display: flex; align-items: baseline; gap: 7px; letter-spacing: -.02em; }
.brand-copy strong { font-size: 18px; letter-spacing: .08em; }
.brand-copy small { color: var(--muted); font-size: 13px; }

.topbar-context { display: flex; align-items: center; gap: 18px; padding: 0 24px; }
.eyebrow, .section-index {
  color: var(--green);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .15em;
}
.read-only { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.read-only > span { width: 6px; height: 6px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 10px rgba(104, 217, 233, .7); }
.topbar-actions { display: flex; align-items: center; gap: 10px; padding: 0 18px; }
.connection { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.connection-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--amber); }
.connection.online .connection-dot { background: var(--green); box-shadow: 0 0 10px rgba(135, 245, 189, .6); }
.connection.offline .connection-dot { background: var(--danger); }

.icon-button, .dialog-close {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--muted);
  background: transparent;
  transition: color .15s ease, background .15s ease, border-color .15s ease;
}
.icon-button:hover, .dialog-close:hover { color: var(--ink); background: var(--raised); border-color: var(--line-strong); }
.icon-button svg { width: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.icon-button.loading svg { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.shell { min-height: calc(100vh - 72px); display: grid; grid-template-columns: 286px minmax(0, 1fr); }
.run-panel {
  position: sticky;
  top: 72px;
  height: calc(100vh - 72px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--line);
  background: rgba(8, 18, 15, .72);
}
.panel-heading { display: flex; align-items: end; justify-content: space-between; padding: 24px 20px 18px; }
.panel-heading h1, .section-heading h3, .card-heading h3 { margin: 4px 0 0; font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.count-badge { min-width: 26px; padding: 2px 7px; text-align: center; color: var(--muted); background: var(--raised); border: 1px solid var(--line); border-radius: 999px; font: 11px/1.5 "SFMono-Regular", Consolas, monospace; }

.search-field {
  height: 42px;
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 8px;
  margin: 0 16px 12px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--subtle);
  background: rgba(255, 255, 255, .018);
}
.search-field:focus-within { border-color: rgba(135, 245, 189, .5); box-shadow: 0 0 0 3px rgba(135, 245, 189, .08); }
.search-field svg { width: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }
.search-field input { width: 100%; border: 0; outline: 0; color: var(--ink); background: transparent; font-size: 12px; }
.search-field input::placeholder { color: var(--subtle); }
.search-field kbd { padding: 1px 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--subtle); background: var(--panel); font-size: 10px; }

.segmented { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; margin: 0 16px 14px; padding: 3px; border: 1px solid var(--line); border-radius: 9px; background: rgba(0, 0, 0, .12); }
.segmented button { padding: 6px; border: 0; border-radius: 6px; color: var(--subtle); background: transparent; font-size: 11px; }
.segmented button[aria-pressed="true"] { color: var(--ink); background: var(--raised-2); box-shadow: 0 1px 3px rgba(0,0,0,.25); }

.run-list { min-height: 120px; flex: 1; overflow-y: auto; padding: 0 10px 20px; scrollbar-color: var(--line-strong) transparent; }
.run-item {
  width: 100%;
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  padding: 13px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  text-align: left;
  color: inherit;
  background: transparent;
}
.run-item:hover { background: rgba(255,255,255,.025); }
.run-item.selected { border-color: rgba(135,245,189,.18); background: linear-gradient(90deg, rgba(65,220,145,.09), rgba(65,220,145,.02)); }
.run-state { width: 7px; height: 7px; margin-top: 5px; border: 1px solid var(--subtle); border-radius: 50%; }
.run-state.complete { border-color: var(--green); background: var(--green); box-shadow: 0 0 8px rgba(135,245,189,.42); }
.run-copy { min-width: 0; }
.run-copy strong { display: block; overflow: hidden; text-overflow: ellipsis; color: var(--ink); font: 600 12px/1.45 "SFMono-Regular", Consolas, monospace; white-space: nowrap; }
.run-copy small { display: block; margin-top: 3px; color: var(--subtle); font-size: 10px; }
.run-tick { padding-top: 1px; color: var(--muted); font: 10px/1.4 "SFMono-Regular", Consolas, monospace; }
.empty-list { margin: 32px 10px; color: var(--subtle); text-align: center; font-size: 12px; }
.list-error { margin: 20px 6px; padding: 14px; border: 1px solid rgba(255,143,143,.18); border-radius: 10px; color: #ffc2c2; background: rgba(255,143,143,.05); font-size: 12px; }
.list-skeleton { display: grid; gap: 8px; padding: 4px 6px; }
.list-skeleton span { height: 55px; border-radius: 9px; background: linear-gradient(100deg, var(--raised) 20%, var(--raised-2) 45%, var(--raised) 70%); background-size: 220% 100%; animation: shimmer 1.6s infinite; }
@keyframes shimmer { to { background-position: -220% 0; } }

.panel-footnote { display: flex; gap: 9px; margin: 12px 16px 16px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--subtle); }
.panel-footnote p { margin: 0; font-size: 10px; line-height: 1.5; }
.footnote-mark { flex: 0 0 auto; width: 16px; height: 16px; display: grid; place-items: center; border: 1px solid var(--line-strong); border-radius: 50%; font: 10px serif; }

.workspace { min-width: 0; min-height: calc(100vh - 72px); padding: clamp(24px, 3.8vw, 56px); }
.welcome { min-height: calc(100vh - 184px); max-width: 840px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; }
.welcome-orbit { position: relative; width: 112px; height: 112px; margin-bottom: 36px; }
.orbit { position: absolute; inset: 14px 47px; border: 1px solid rgba(135,245,189,.48); border-radius: 50%; }
.orbit-a { transform: rotate(0); }
.orbit-b { transform: rotate(60deg); }
.orbit-c { transform: rotate(120deg); }
.orbit-core { position: absolute; inset: 50px; border-radius: 50%; background: var(--green); box-shadow: 0 0 26px rgba(135,245,189,.55); }
.welcome h2 { max-width: 780px; margin: 17px 0 20px; font-size: clamp(36px, 5vw, 68px); font-weight: 540; letter-spacing: -.055em; line-height: .98; }
.welcome > p { max-width: 660px; margin: 0; color: var(--muted); font-size: 16px; line-height: 1.7; }
.welcome-principles { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 32px; }
.welcome-principles span { padding: 7px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: rgba(255,255,255,.018); font-size: 11px; }

.run-view { max-width: 1600px; margin: 0 auto; }
.run-hero { display: flex; align-items: end; justify-content: space-between; gap: 32px; margin-bottom: 40px; }
.breadcrumbs { display: flex; gap: 9px; margin-bottom: 7px; color: var(--muted); font: 10px/1.4 "SFMono-Regular", Consolas, monospace; letter-spacing: .12em; }
.breadcrumbs span:first-child { color: var(--green); }
.title-line { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.title-line h2 { margin: 0; font-size: clamp(32px, 4vw, 52px); font-weight: 560; letter-spacing: -.045em; line-height: 1.1; }
.status-pill { padding: 4px 9px; border: 1px solid rgba(135,245,189,.24); border-radius: 999px; color: var(--green); background: rgba(135,245,189,.06); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
.status-pill.active { border-color: rgba(240,198,116,.25); color: var(--amber); background: rgba(240,198,116,.06); }
.copy-id { max-width: min(620px, 64vw); display: flex; align-items: center; gap: 7px; margin: 9px 0 0; padding: 0; border: 0; color: var(--subtle); background: transparent; }
.copy-id:hover { color: var(--muted); }
.copy-id code { overflow: hidden; text-overflow: ellipsis; font: 10px/1.4 "SFMono-Regular", Consolas, monospace; white-space: nowrap; }
.copy-id svg { flex: 0 0 auto; width: 13px; fill: none; stroke: currentColor; stroke-width: 1.6; }
.run-facts { display: flex; gap: clamp(18px, 3vw, 42px); margin: 0; }
.run-facts div { min-width: 82px; }
.run-facts dt { color: var(--subtle); font-size: 9px; text-transform: uppercase; letter-spacing: .12em; }
.run-facts dd { max-width: 180px; overflow: hidden; margin: 6px 0 0; text-overflow: ellipsis; color: var(--muted); font: 10px/1.5 "SFMono-Regular", Consolas, monospace; white-space: nowrap; }

.section-heading, .card-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
.section-note { color: var(--subtle); font: 10px/1.4 "SFMono-Regular", Consolas, monospace; }
.metric-grid { display: grid; grid-template-columns: 1.15fr repeat(4, 1fr); gap: 10px; margin-top: 14px; }
.metric {
  min-width: 0;
  padding: 17px 18px 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: linear-gradient(145deg, rgba(255,255,255,.026), rgba(255,255,255,.009));
}
.metric-primary { border-color: rgba(135,245,189,.2); background: linear-gradient(145deg, rgba(65,220,145,.09), rgba(65,220,145,.015)); }
.metric-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
.metric-glyph { color: var(--green); font-family: monospace; }
.metric-glyph.neutral { color: var(--subtle); }
.metric-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--green); }
.metric-dot.violet { background: var(--violet); }
.metric-dot.cyan { background: var(--cyan); }
.metric-dot.amber { background: var(--amber); }
.metric strong { display: block; margin-top: 13px; font-size: clamp(24px, 2.2vw, 35px); font-weight: 520; letter-spacing: -.04em; line-height: 1; font-variant-numeric: tabular-nums; }
.metric small { display: block; overflow: hidden; margin-top: 9px; color: var(--subtle); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }

.analysis-grid, .evidence-grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, .75fr); gap: 12px; margin-top: 12px; }
.evidence-grid { grid-template-columns: minmax(300px, .78fr) minmax(0, 1.42fr); }
.card { min-width: 0; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius); background: rgba(10, 21, 18, .72); box-shadow: 0 1px rgba(255,255,255,.015) inset; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; color: var(--subtle); font-size: 9px; }
.legend span { display: flex; align-items: center; gap: 5px; }
.legend i { width: 13px; height: 2px; border-radius: 2px; }
.line-success { background: var(--green); }
.line-quality { background: var(--violet); }
.line-density { background: var(--cyan); }
.chart-wrap { position: relative; min-height: 250px; margin-top: 16px; }
.metric-chart { width: 100%; height: auto; overflow: visible; }
.chart-grid { stroke: var(--line); stroke-width: 1; }
.chart-axis-label { fill: var(--subtle); font: 9px "SFMono-Regular", Consolas, monospace; }
.chart-path { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.chart-path.success { stroke: var(--green); }
.chart-path.quality { stroke: var(--violet); }
.chart-path.density { stroke: var(--cyan); opacity: .9; }
.chart-point { stroke: var(--panel); stroke-width: 2; }
.chart-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--subtle); font-size: 12px; }
.data-alternative { margin-top: 8px; border-top: 1px solid var(--line); }
.data-alternative summary { padding-top: 12px; color: var(--subtle); cursor: pointer; font-size: 10px; }
.table-scroll { max-height: 220px; overflow: auto; margin-top: 10px; }
table { width: 100%; border-collapse: collapse; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--line); text-align: right; }
th:first-child, td:first-child { text-align: left; }
th { position: sticky; top: 0; color: var(--subtle); background: var(--panel); font-weight: 600; }

.status-mini { padding: 4px 8px; border: 1px solid rgba(135,245,189,.18); border-radius: 999px; color: var(--green); font-size: 9px; }
.status-mini.danger { border-color: rgba(255,143,143,.2); color: var(--danger); }
.card-intro { margin: 16px 0 20px; color: var(--subtle); font-size: 11px; }
.signal-list { display: grid; gap: 15px; margin: 0; }
.signal-list dt { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 10px; }
.signal-list output { color: var(--ink); font-family: "SFMono-Regular", Consolas, monospace; }
.signal-list dd { height: 4px; margin: 7px 0 0; overflow: hidden; border-radius: 10px; background: var(--raised-2); }
.signal-list dd span { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, rgba(65,220,145,.46), var(--green)); transition: width .5s cubic-bezier(.2,.7,.2,1); }
.structure-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 22px; padding-top: 17px; border-top: 1px solid var(--line); }
.structure-summary div { min-width: 0; }
.structure-summary span { display: block; color: var(--subtle); font-size: 8px; text-transform: uppercase; letter-spacing: .08em; }
.structure-summary strong { display: block; margin-top: 5px; overflow: hidden; color: var(--muted); font: 600 13px/1.4 "SFMono-Regular", Consolas, monospace; text-overflow: ellipsis; }

.integrity-state { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 10px; }
.integrity-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--amber); }
.integrity-state.valid { color: var(--green); }
.integrity-state.valid i { background: var(--green); box-shadow: 0 0 10px rgba(135,245,189,.5); }
.integrity-state.invalid { color: var(--danger); }
.integrity-state.invalid i { background: var(--danger); }
.integrity-card > p { margin: 16px 0; color: var(--muted); font-size: 11px; }
.hash-list { display: grid; gap: 10px; margin: 0; }
.hash-list div { min-width: 0; }
.hash-list dt { margin-bottom: 4px; color: var(--subtle); font-size: 8px; text-transform: uppercase; letter-spacing: .1em; }
.hash-list dd { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; }
.hash-list code { min-width: 0; flex: 1; overflow: hidden; padding: 7px 8px; border: 1px solid var(--line); border-radius: 7px; color: var(--muted); background: rgba(0,0,0,.12); font: 9px/1.4 "SFMono-Regular", Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.hash-list button { border: 0; color: var(--subtle); background: transparent; font-size: 9px; }
.hash-list button:hover { color: var(--green); }
.integrity-note { margin-top: 17px; padding: 11px 12px; border-left: 2px solid rgba(240,198,116,.5); color: var(--subtle); background: rgba(240,198,116,.035); }
.integrity-note strong { color: var(--amber); font-size: 9px; text-transform: uppercase; letter-spacing: .09em; }
.integrity-note p { margin: 4px 0 0; font-size: 9px; }

.event-heading { align-items: center; }
.event-tools { display: flex; gap: 7px; }
.event-tools select { max-width: 180px; height: 32px; padding: 0 26px 0 9px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--raised); font-size: 9px; }
.button { min-height: 32px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 10px; font-weight: 600; }
.button-quiet { color: var(--muted); background: transparent; }
.button-quiet:hover { color: var(--ink); border-color: var(--line-strong); background: var(--raised); }
.button-primary { border-color: var(--green); color: #04130c; background: var(--green); }
.button-primary:hover { background: #a2ffce; }
.event-list { min-height: 190px; max-height: 420px; overflow-y: auto; margin-top: 14px; scrollbar-color: var(--line-strong) transparent; }
.event-entry { position: relative; display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 10px; padding: 9px 3px 9px 15px; border-left: 1px solid var(--line); }
.event-entry::before { content: ""; position: absolute; top: 15px; left: -3px; width: 5px; height: 5px; border: 1px solid var(--subtle); border-radius: 50%; background: var(--panel); }
.event-entry.system::before { border-color: var(--green); background: rgba(135,245,189,.3); }
.event-entry.pressure::before { border-color: var(--amber); background: rgba(240,198,116,.3); }
.event-seq { color: var(--subtle); font: 9px/1.5 "SFMono-Regular", Consolas, monospace; }
.event-body { min-width: 0; }
.event-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
.event-type { color: var(--ink); font: 600 10px/1.5 "SFMono-Regular", Consolas, monospace; }
.event-meta { color: var(--subtle); font-size: 9px; }
.event-body details { margin-top: 3px; }
.event-body summary { color: var(--subtle); cursor: pointer; font-size: 9px; }
.event-body pre { max-height: 180px; overflow: auto; margin: 6px 0 0; padding: 8px; border: 1px solid var(--line); border-radius: 7px; color: var(--muted); background: rgba(0,0,0,.18); font: 9px/1.55 "SFMono-Regular", Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
.event-empty { min-height: 180px; display: grid; place-items: center; color: var(--subtle); font-size: 11px; }
.event-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--subtle); font-size: 9px; }

.auth-dialog {
  width: min(480px, calc(100vw - 32px));
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 18px;
  color: var(--ink);
  background: #0b1713;
  box-shadow: var(--shadow);
}
.auth-dialog::backdrop { background: rgba(2, 8, 6, .78); backdrop-filter: blur(8px); }
.auth-dialog form { position: relative; padding: 28px; }
.dialog-close { position: absolute; top: 14px; right: 14px; border: 0; font-size: 22px; }
.auth-mark { width: 48px; height: 48px; display: grid; place-items: center; margin-bottom: 20px; border: 1px solid rgba(135,245,189,.25); border-radius: 50%; color: var(--green); background: rgba(135,245,189,.05); font: 700 11px/1 "SFMono-Regular", Consolas, monospace; letter-spacing: .08em; }
.auth-dialog h2 { margin: 7px 0 10px; font-size: 28px; font-weight: 560; letter-spacing: -.035em; }
.auth-dialog p { margin: 0 0 18px; color: var(--muted); font-size: 12px; }
.auth-dialog label > span { display: block; margin-bottom: 6px; color: var(--muted); font-size: 10px; }
.auth-dialog input { width: 100%; height: 44px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 9px; outline: 0; color: var(--ink); background: rgba(0,0,0,.2); font-family: "SFMono-Regular", Consolas, monospace; }
.auth-dialog input:focus { border-color: var(--green); box-shadow: 0 0 0 3px rgba(135,245,189,.08); }
.auth-dialog .auth-error { margin: 8px 0 0; color: var(--danger); font-size: 10px; }
.dialog-actions { display: flex; gap: 8px; margin-top: 20px; }
.dialog-actions .button { min-height: 38px; padding-inline: 16px; }

.toast { position: fixed; z-index: 50; right: 20px; bottom: 20px; max-width: 360px; padding: 10px 13px; border: 1px solid var(--line-strong); border-radius: 9px; color: var(--ink); background: var(--raised-2); box-shadow: var(--shadow); font-size: 11px; }
.noscript { position: fixed; inset: auto 16px 16px; z-index: 60; padding: 12px; border: 1px solid var(--amber); border-radius: 9px; color: var(--ink); background: var(--panel); }

@media (max-width: 1180px) {
  .metric-grid { grid-template-columns: repeat(3, 1fr); }
  .analysis-grid, .evidence-grid { grid-template-columns: 1fr; }
  .run-facts { display: none; }
}

@media (max-width: 780px) {
  .topbar { grid-template-columns: 1fr auto; height: 62px; }
  .brand { padding: 0 16px; border-right: 0; }
  .topbar-context, .connection, .token-clear { display: none; }
  .shell { display: block; }
  .run-panel { position: relative; top: auto; width: 100%; height: auto; max-height: 380px; border-right: 0; border-bottom: 1px solid var(--line); }
  .run-list { max-height: 190px; }
  .panel-footnote { display: none; }
  .workspace { min-height: auto; padding: 28px 16px 44px; }
  .welcome { min-height: 480px; }
  .welcome h2 { font-size: 39px; }
  .run-hero { margin-bottom: 28px; }
  .copy-id { max-width: 88vw; }
  .metric-grid { grid-template-columns: repeat(2, 1fr); }
  .metric-primary { grid-column: span 2; }
  .event-heading { align-items: flex-start; }
  .event-tools { flex-direction: column; align-items: end; }
}

@media (max-width: 440px) {
  .metric-grid { grid-template-columns: 1fr; }
  .metric-primary { grid-column: auto; }
  .card { padding: 16px; }
  .legend { display: none; }
  .structure-summary { grid-template-columns: 1fr 1fr; }
  .event-entry { grid-template-columns: 48px minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}

@media (forced-colors: active) {
  .connection-dot, .metric-dot, .integrity-state i, .event-entry::before { forced-color-adjust: none; }
}
`;

export const OBSERVER_UI_JAVASCRIPT = String.raw`
"use strict";

(function () {
  var state = {
    token: "",
    runs: [],
    selectedRunId: "",
    detail: null,
    metrics: [],
    events: [],
    hasMoreEvents: false,
    nextAfter: 0,
    runFilter: "all",
    eventFilter: ""
  };

  var el = {};
  var NS = "http://www.w3.org/2000/svg";

  function byId(id) { return document.getElementById(id); }
  function text(id, value) {
    var node = byId(id);
    if (node) node.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
  }
  function number(value) {
    return Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-US").format(Number(value)) : "—";
  }
  function percentPpm(value) {
    return Number.isFinite(Number(value)) ? (Number(value) / 10000).toFixed(1) + "%" : "—";
  }
  function shortHash(value) {
    if (typeof value !== "string" || !value) return "—";
    return value.length > 26 ? value.slice(0, 13) + "…" + value.slice(-11) : value;
  }
  function safeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  function setBusy(busy) {
    el.refreshAll.classList.toggle("loading", busy);
    el.refreshAll.disabled = busy;
  }
  function setConnection(kind, label) {
    el.connection.className = "connection " + kind;
    el.connection.querySelector("span:last-child").textContent = label;
  }
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(function () { el.toast.hidden = true; }, 2600);
  }

  async function api(path) {
    var headers = { Accept: "application/json" };
    if (state.token) headers.Authorization = "Bearer " + state.token;
    var response;
    try {
      response = await fetch(path, {
        method: "GET",
        headers: headers,
        credentials: "same-origin",
        cache: "no-store"
      });
    } catch (_error) {
      setConnection("offline", "Observer unavailable");
      throw new Error("observer_unavailable");
    }
    if (response.status === 401) {
      setConnection("offline", "Evidence locked");
      openAuth();
      throw new Error("unauthorized");
    }
    var body = {};
    try { body = await response.json(); } catch (_error) { body = {}; }
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "request_failed");
    setConnection("online", "Observer healthy");
    return body;
  }

  function openAuth() {
    if (!el.authDialog.open) {
      el.authError.hidden = true;
      el.authDialog.showModal();
      window.setTimeout(function () { el.authToken.focus(); }, 0);
    }
  }

  async function authenticate(event) {
    event.preventDefault();
    var token = el.authToken.value.trim();
    if (token.length < 32) {
      el.authError.textContent = "A Bearer token must contain at least 32 characters.";
      el.authError.hidden = false;
      return;
    }
    state.token = token;
    el.authSubmit.disabled = true;
    el.authError.hidden = true;
    try {
      await loadRuns();
      el.authToken.value = "";
      el.authDialog.close();
      el.clearToken.hidden = false;
      toast("Evidence session unlocked");
    } catch (error) {
      state.token = "";
      if (error.message === "unauthorized") {
        el.authError.textContent = "That token was not accepted.";
        el.authError.hidden = false;
      } else {
        el.authError.textContent = humanError(error);
        el.authError.hidden = false;
      }
    } finally {
      el.authSubmit.disabled = false;
    }
  }

  function lockSession() {
    state.token = "";
    state.runs = [];
    state.selectedRunId = "";
    state.detail = null;
    el.clearToken.hidden = true;
    renderRuns();
    showWelcome();
    openAuth();
  }

  function humanError(error) {
    var code = error && error.message ? error.message : "request_failed";
    var messages = {
      observer_unavailable: "The Observer could not be reached.",
      not_ready: "The evidence volume is not ready.",
      run_discovery_incomplete: "The evidence catalogue exceeded its safety bound.",
      ambiguous_run_evidence: "Duplicate run identities were found. The Observer failed closed.",
      invalid_artifact: "A run contains an invalid or unsafe evidence artifact.",
      artifact_too_large: "An evidence artifact exceeds the Observer response bound.",
      invalid_metrics: "The metrics history is invalid.",
      invalid_event_log: "The event stream did not pass validation.",
      run_not_found: "That evidence run no longer exists."
    };
    return messages[code] || "The Observer rejected this request (" + code + ").";
  }

  async function loadRuns(options) {
    options = options || {};
    setBusy(true);
    if (!options.keepList) {
      el.runList.replaceChildren(skeleton());
    }
    try {
      var data = await api("/api/runs");
      state.runs = Array.isArray(data.runs) ? data.runs : [];
      text("run-count", state.runs.length);
      renderRuns();
      if (state.selectedRunId && state.runs.some(function (run) { return run.runId === state.selectedRunId; })) {
        await selectRun(state.selectedRunId, { preserveFocus: true });
      } else if (!options.noAutoSelect && state.runs.length === 1) {
        await selectRun(String(state.runs[0].runId), { preserveFocus: true });
      } else if (!state.runs.length) {
        showWelcome();
      }
    } catch (error) {
      if (error.message !== "unauthorized") {
        el.runList.replaceChildren(errorBox(humanError(error)));
        setConnection("offline", "Evidence unavailable");
      }
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function skeleton() {
    var wrap = document.createElement("div");
    wrap.className = "list-skeleton";
    wrap.setAttribute("aria-label", "Loading evidence runs");
    for (var i = 0; i < 3; i += 1) wrap.appendChild(document.createElement("span"));
    return wrap;
  }

  function errorBox(message) {
    var box = document.createElement("div");
    box.className = "list-error";
    box.textContent = message;
    return box;
  }

  function renderRuns() {
    var query = el.runSearch.value.trim().toLowerCase();
    var visible = state.runs.filter(function (run) {
      if (state.runFilter === "complete" && !run.completed) return false;
      if (state.runFilter === "active" && run.completed) return false;
      if (!query) return true;
      return [run.runId, run.universeId, run.experimentId].some(function (value) {
        return String(value || "").toLowerCase().includes(query);
      });
    });

    el.runList.replaceChildren();
    if (!visible.length) {
      var empty = document.createElement("p");
      empty.className = "empty-list";
      empty.textContent = state.runs.length ? "No runs match this view." : "No evidence runs found.";
      el.runList.appendChild(empty);
      return;
    }

    visible.forEach(function (run) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "run-item" + (run.runId === state.selectedRunId ? " selected" : "");
      button.setAttribute("aria-pressed", run.runId === state.selectedRunId ? "true" : "false");
      button.addEventListener("click", function () { void selectRun(String(run.runId)); });

      var status = document.createElement("span");
      status.className = "run-state" + (run.completed ? " complete" : "");
      status.setAttribute("aria-label", run.completed ? "Complete" : "In progress");

      var copy = document.createElement("span");
      copy.className = "run-copy";
      var title = document.createElement("strong");
      title.textContent = String(run.universeId || "Unknown universe");
      var subtitle = document.createElement("small");
      subtitle.textContent = String(run.experimentId || "experiment") + " · " + shortHash(String(run.runId || ""));
      copy.append(title, subtitle);

      var tick = document.createElement("span");
      tick.className = "run-tick";
      tick.textContent = run.ticks !== null && run.ticks !== undefined && Number.isFinite(Number(run.ticks))
        ? "T" + number(run.ticks)
        : "LIVE";

      button.append(status, copy, tick);
      el.runList.appendChild(button);
    });
  }

  async function selectRun(runId, options) {
    options = options || {};
    state.selectedRunId = runId;
    state.events = [];
    state.metrics = [];
    renderRuns();
    el.welcome.hidden = true;
    el.runView.hidden = false;
    el.runView.setAttribute("aria-busy", "true");
    if (!options.preserveFocus && window.matchMedia("(max-width: 780px)").matches) {
      el.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    try {
      var encoded = encodeURIComponent(runId);
      var results = await Promise.allSettled([
        api("/api/runs/" + encoded),
        api("/api/runs/" + encoded + "/metrics")
      ]);
      if (results[0].status === "rejected") throw results[0].reason;
      state.detail = results[0].value;
      state.metrics = results[1].status === "fulfilled" && Array.isArray(results[1].value.metrics)
        ? results[1].value.metrics
        : [];
      renderDetail();
      await loadEventTail();
    } catch (error) {
      if (error.message !== "unauthorized") {
        toast(humanError(error));
        showWelcome();
      }
    } finally {
      el.runView.removeAttribute("aria-busy");
    }
  }

  function showWelcome() {
    state.selectedRunId = "";
    el.runView.hidden = true;
    el.welcome.hidden = false;
    renderRuns();
  }

  function renderDetail() {
    var detail = safeObject(state.detail);
    var manifest = safeObject(detail.manifest);
    var summary = safeObject(detail.summary);
    var metrics = safeObject(summary.latestMetrics);
    if (!Object.keys(metrics).length && state.metrics.length) {
      metrics = safeObject(state.metrics[state.metrics.length - 1]);
    }

    text("experiment-label", String(manifest.experimentId || "experiment").toUpperCase());
    text("universe-label", manifest.universeId);
    text("run-title", manifest.universeId || "Evidence run");
    text("run-id", detail.runId);
    text("engine-value", manifest.engineVersion);
    text("policy-value", manifest.policyId);
    text("seed-value", manifest.seed);

    var complete = Boolean(detail.summary);
    el.runStatus.textContent = complete ? "Complete" : "In progress";
    el.runStatus.className = "status-pill" + (complete ? "" : " active");

    text("metric-success", percentPpm(metrics.taskSuccessRatePpm));
    text("metric-quality", percentPpm(metrics.meanQualityPpm));
    text("metric-agents", number(metrics.activeAgents));
    text("metric-links", number(metrics.activeLinks));
    text("metric-components", "Across " + number(metrics.connectedComponents) + " components");
    text("metric-events", number(summary.events));
    text("metric-tick", metrics.tick === undefined ? "Metric history unavailable" : "Verified at tick " + number(metrics.tick));

    setSignal("density", metrics.densityPpm);
    setSignal("central", metrics.degreeCentralizationPpm);
    setSignal("special", metrics.meanSpecializationPpm);
    setSignal("gini", metrics.resourceGiniPpm);
    text("structure-components", number(metrics.connectedComponents));
    text("structure-turnover", number(metrics.linkTurnover));
    text("structure-latency", Number.isFinite(Number(metrics.p95LatencyTicks)) ? number(metrics.p95LatencyTicks) + " ticks" : "—");

    var violations = Number(metrics.violations || 0);
    el.violationStatus.textContent = violations === 0 ? "No violations" : number(violations) + " violations";
    el.violationStatus.className = "status-mini" + (violations === 0 ? "" : " danger");

    renderIntegrity(detail, summary);
    renderChart();
  }

  function setSignal(name, value) {
    var bounded = Math.max(0, Math.min(1000000, Number(value) || 0));
    text("signal-" + name + "-value", percentPpm(bounded));
    byId("signal-" + name).style.width = (bounded / 10000).toFixed(2) + "%";
  }

  function renderIntegrity(detail, summary) {
    var status = String(detail.attestationStatus || "missing");
    var attestation = safeObject(detail.attestation);
    var evidence = safeObject(attestation.evidence);
    var commitment = typeof attestation.commitment === "string"
      ? (attestation.commitment.startsWith("sha256:") ? attestation.commitment : "sha256:" + attestation.commitment)
      : "—";
    el.attestationState.className = "integrity-state";
    if (status === "self_consistent") {
      el.attestationState.classList.add("valid");
      el.attestationState.lastChild.textContent = "Self-consistent";
      text("integrity-explanation", "The stored commitment is structurally valid and bound to this manifest subject.");
    } else if (status === "invalid") {
      el.attestationState.classList.add("invalid");
      el.attestationState.lastChild.textContent = "Invalid";
      text("integrity-explanation", "The stored attestation did not validate against this evidence subject.");
    } else {
      el.attestationState.lastChild.textContent = "Not published";
      text("integrity-explanation", "This run has no local final attestation yet.");
    }
    setHash("commitment-value", commitment);
    setHash("event-hash-value", evidence.finalEventHash || summary.finalEventHash);
    setHash("state-hash-value", evidence.finalStateHash || summary.finalStateHash);
  }

  function setHash(id, value) {
    var node = byId(id);
    node.textContent = shortHash(value);
    node.dataset.fullValue = typeof value === "string" ? value : "";
    node.title = typeof value === "string" ? value : "";
  }

  function svg(name, attributes) {
    var node = document.createElementNS(NS, name);
    Object.keys(attributes || {}).forEach(function (key) { node.setAttribute(key, String(attributes[key])); });
    return node;
  }

  function renderChart() {
    var chart = el.metricChart;
    chart.querySelectorAll(".generated").forEach(function (node) { node.remove(); });
    el.metricTable.replaceChildren();
    var metrics = state.metrics.filter(function (entry) {
      return Number.isFinite(Number(entry.tick));
    });
    el.chartEmpty.hidden = metrics.length > 0;
    if (!metrics.length) return;

    var left = 44, right = 744, top = 16, bottom = 242;
    [0, 250000, 500000, 750000, 1000000].forEach(function (value) {
      var y = bottom - (value / 1000000) * (bottom - top);
      var line = svg("line", { x1: left, x2: right, y1: y, y2: y, class: "chart-grid generated" });
      var label = svg("text", { x: 0, y: y + 3, class: "chart-axis-label generated" });
      label.textContent = value === 0 ? "0" : (value / 10000) + "%";
      chart.append(line, label);
    });

    var firstTick = Number(metrics[0].tick);
    var lastTick = Number(metrics[metrics.length - 1].tick);
    var tickSpan = Math.max(1, lastTick - firstTick);
    [firstTick, Math.round(firstTick + tickSpan / 2), lastTick].forEach(function (value, index) {
      var label = svg("text", {
        x: index === 0 ? left : index === 1 ? (left + right) / 2 : right,
        y: 268,
        "text-anchor": index === 0 ? "start" : index === 1 ? "middle" : "end",
        class: "chart-axis-label generated"
      });
      label.textContent = "T" + number(value);
      chart.appendChild(label);
    });

    [
      ["taskSuccessRatePpm", "success"],
      ["meanQualityPpm", "quality"],
      ["densityPpm", "density"]
    ].forEach(function (series) {
      var points = metrics.map(function (metric) {
        var x = left + ((Number(metric.tick) - firstTick) / tickSpan) * (right - left);
        var value = Math.max(0, Math.min(1000000, Number(metric[series[0]]) || 0));
        var y = bottom - (value / 1000000) * (bottom - top);
        return [x, y];
      });
      var d = points.map(function (point, index) {
        return (index === 0 ? "M" : "L") + point[0].toFixed(2) + " " + point[1].toFixed(2);
      }).join(" ");
      chart.appendChild(svg("path", { d: d, class: "chart-path " + series[1] + " generated" }));
      var last = points[points.length - 1];
      chart.appendChild(svg("circle", {
        cx: last[0], cy: last[1], r: 3.5,
        fill: series[1] === "success" ? "#87f5bd" : series[1] === "quality" ? "#b79bff" : "#68d9e9",
        class: "chart-point generated"
      }));
    });

    metrics.forEach(function (metric) {
      var row = document.createElement("tr");
      [
        number(metric.tick),
        percentPpm(metric.taskSuccessRatePpm),
        percentPpm(metric.meanQualityPpm),
        percentPpm(metric.densityPpm),
        number(metric.activeAgents),
        number(metric.activeLinks)
      ].forEach(function (value) {
        var cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
      el.metricTable.appendChild(row);
    });
  }

  async function loadEventTail() {
    var summary = safeObject(safeObject(state.detail).summary);
    var total = Number(summary.events);
    var after = Number.isSafeInteger(total) && total > 60 ? total - 60 : 0;
    await loadEvents(after, true);
  }

  async function loadEvents(after, replace) {
    if (!state.selectedRunId) return;
    el.refreshEvents.disabled = true;
    el.loadEvents.disabled = true;
    try {
      var page = await api("/api/runs/" + encodeURIComponent(state.selectedRunId) + "/events?after=" + after + "&limit=60");
      var entries = Array.isArray(page.events) ? page.events : [];
      state.events = replace ? entries : state.events.concat(entries);
      state.nextAfter = Number(page.nextAfter) || after;
      state.hasMoreEvents = Boolean(page.hasMore);
      renderEvents();
    } catch (error) {
      if (error.message !== "unauthorized") {
        el.eventList.replaceChildren(errorBox(humanError(error)));
      }
    } finally {
      el.refreshEvents.disabled = false;
      el.loadEvents.disabled = false;
    }
  }

  function renderEvents() {
    var filtered = state.events.filter(function (event) {
      return !state.eventFilter || event.type === state.eventFilter;
    });
    el.eventList.replaceChildren();
    if (!filtered.length) {
      var empty = document.createElement("div");
      empty.className = "event-empty";
      empty.textContent = state.events.length ? "No events match this type." : "No events in this range.";
      el.eventList.appendChild(empty);
    } else {
      filtered.forEach(function (event) {
        var entry = document.createElement("article");
        var category = String(event.type || "").startsWith("pressure.") ? " pressure" :
          (String(event.type || "").startsWith("run.") || String(event.type || "").startsWith("tick.")) ? " system" : "";
        entry.className = "event-entry" + category;

        var seq = document.createElement("span");
        seq.className = "event-seq";
        seq.textContent = "#" + number(event.seq);

        var body = document.createElement("div");
        body.className = "event-body";
        var main = document.createElement("div");
        main.className = "event-main";
        var type = document.createElement("span");
        type.className = "event-type";
        type.textContent = String(event.type || "unknown");
        var meta = document.createElement("span");
        meta.className = "event-meta";
        var actors = [event.actorId, event.targetId].filter(Boolean).join(" → ");
        meta.textContent = "T" + number(event.tick) + (actors ? " · " + actors : "");
        main.append(type, meta);
        body.appendChild(main);

        var payload = safeObject(event.data);
        if (Object.keys(payload).length) {
          var details = document.createElement("details");
          var summary = document.createElement("summary");
          summary.textContent = "Inspect redacted payload";
          var pre = document.createElement("pre");
          pre.textContent = JSON.stringify(payload, null, 2);
          details.append(summary, pre);
          body.appendChild(details);
        }
        entry.append(seq, body);
        el.eventList.appendChild(entry);
      });
    }

    var types = Array.from(new Set(state.events.map(function (event) { return String(event.type || ""); }).filter(Boolean))).sort();
    var current = state.eventFilter;
    el.eventFilter.replaceChildren();
    var all = document.createElement("option");
    all.value = "";
    all.textContent = "All event types";
    el.eventFilter.appendChild(all);
    types.forEach(function (type) {
      var option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      el.eventFilter.appendChild(option);
    });
    el.eventFilter.value = types.includes(current) ? current : "";
    state.eventFilter = el.eventFilter.value;

    var first = state.events[0] ? state.events[0].seq : 0;
    var last = state.events[state.events.length - 1] ? state.events[state.events.length - 1].seq : 0;
    text("event-range", state.events.length ? "Showing #" + number(first) + "–#" + number(last) : "No events loaded");
    el.loadEvents.hidden = !state.hasMoreEvents;
  }

  async function copyValue(value) {
    if (!value || value === "—") return;
    try {
      await navigator.clipboard.writeText(value);
      toast("Copied to clipboard");
    } catch (_error) {
      toast("Clipboard permission was not available");
    }
  }

  function bind() {
    [
      "connection-status", "refresh-all", "clear-token", "run-search", "run-list",
      "welcome-view", "run-view", "workspace", "run-status", "copy-run-id",
      "metric-chart", "chart-empty", "metric-table", "violation-status",
      "attestation-state", "event-filter", "refresh-events", "event-list",
      "load-events", "auth-dialog", "auth-form", "auth-token", "auth-error",
      "auth-submit", "toast"
    ].forEach(function (id) {
      var key = id.replace(/-([a-z])/g, function (_match, letter) { return letter.toUpperCase(); });
      el[key] = byId(id);
    });
    el.connection = el.connectionStatus;
    el.welcome = el.welcomeView;

    el.refreshAll.addEventListener("click", function () { void loadRuns({ keepList: true }); });
    el.clearToken.addEventListener("click", lockSession);
    el.runSearch.addEventListener("input", renderRuns);
    el.authForm.addEventListener("submit", authenticate);
    el.copyRunId.addEventListener("click", function () { void copyValue(el.copyRunId.querySelector("code").textContent); });
    el.refreshEvents.addEventListener("click", function () { void loadEventTail(); });
    el.loadEvents.addEventListener("click", function () { void loadEvents(state.nextAfter, false); });
    el.eventFilter.addEventListener("change", function () { state.eventFilter = el.eventFilter.value; renderEvents(); });

    document.querySelectorAll("[data-run-filter]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.runFilter = button.dataset.runFilter;
        document.querySelectorAll("[data-run-filter]").forEach(function (candidate) {
          candidate.setAttribute("aria-pressed", candidate === button ? "true" : "false");
        });
        renderRuns();
      });
    });
    document.querySelectorAll("[data-copy-target]").forEach(function (button) {
      button.addEventListener("click", function () {
        var target = byId(button.dataset.copyTarget);
        void copyValue(target.dataset.fullValue || target.textContent);
      });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "/" && !/input|select|textarea/i.test(document.activeElement.tagName)) {
        event.preventDefault();
        el.runSearch.focus();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void loadRuns({ keepList: true });
      }
    });
  }

  async function start() {
    bind();
    try {
      var readiness = await fetch("/readyz", { cache: "no-store" });
      if (!readiness.ok) {
        setConnection("offline", "Evidence not ready");
      }
    } catch (_error) {
      setConnection("offline", "Observer unavailable");
    }
    try {
      await loadRuns();
    } catch (_error) {
      // The catalogue or authentication dialog already exposes the safe error.
    }
  }

  void start();
}());
`;

export interface ObserverUiAsset {
  body: string;
  contentType: string;
}

export const OBSERVER_UI_ASSETS: Readonly<Record<string, ObserverUiAsset>> = Object.freeze({
  "/assets/observer.css": Object.freeze({
    body: OBSERVER_UI_CSS,
    contentType: "text/css; charset=utf-8",
  }),
  "/assets/observer.js": Object.freeze({
    body: OBSERVER_UI_JAVASCRIPT,
    contentType: "text/javascript; charset=utf-8",
  }),
});
