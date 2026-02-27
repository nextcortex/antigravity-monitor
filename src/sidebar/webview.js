/**
 * Antigravity Monitor — Sidebar webview script.
 * Uses event delegation with data-action attributes (required by CSP).
 * Receives state via postMessage; no direct network access.
 */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  let state = null;
  let _refreshTimer = null;

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'update') {
      state = msg.payload;
      render(state);
    }
  });

  function post(type, data) {
    vscode.postMessage({ type, ...(data || {}) });
  }

  document.addEventListener('click', (e) => {
    let el = e.target;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.action) {
        e.preventDefault();
        e.stopPropagation();
        handleAction(el.dataset.action, el.dataset);
        return;
      }
      el = el.parentElement;
    }
  });

  function handleAction(action, dataset) {
    switch (action) {
      case 'toggleAutoAccept':
        post('toggleAutoAccept');
        break;
      case 'toggleTasks':
        post('toggleTasks');
        break;
      case 'toggleProjects':
        post('toggleProjects');
        break;
      case 'toggleTask':
        post('toggleTask', { taskId: dataset.id });
        break;
      case 'toggleContext':
        post('toggleContext', { contextId: dataset.id });
        break;
      case 'deleteTask':
        post('deleteTask', { taskId: dataset.id });
        break;
      case 'deleteContext':
        post('deleteContext', { contextId: dataset.id });
        break;
      case 'openFile':
        post('openFile', { path: dataset.path });
        break;
      case 'openRules':
        post('openRules');
        break;
      case 'openMcp':
        post('openMcp');
        break;
      case 'openBrowserAllowlist':
        post('openBrowserAllowlist');
        break;
      case 'restartLanguageServer':
        post('restartLanguageServer');
        break;
      case 'restartUserStatusUpdater':
        post('restartUserStatusUpdater');
        break;
      case 'reloadWindow':
        post('reloadWindow');
        break;
      case 'runDiagnostics':
        post('runDiagnostics');
        break;
      case 'showLogs':
        post('showLogs');
        break;
      case 'refreshNow':
        post('refreshNow');
        // 10s cooldown
        {
          if (_refreshTimer) clearInterval(_refreshTimer);
          const btn = document.getElementById('agm-refresh-btn');
          if (btn) {
            btn.disabled = true;
            let countdown = 10;
            btn.textContent = countdown + 's';
            _refreshTimer = setInterval(() => {
              countdown--;
              if (countdown <= 0) {
                clearInterval(_refreshTimer);
                _refreshTimer = null;
                btn.disabled = false;
                btn.textContent = '🔄 REFRESH';
              } else {
                btn.textContent = countdown + 's';
              }
            }, 1000);
          }
        }
        break;
    }
  }

  function render(s) {
    if (!s) return;
    const app = document.getElementById('agm-app');
    if (!app) return;

    let html = '';

    const statusClass = s.connectionStatus || 'detecting';
    const statusLabel = statusClass === 'connected' ? '🟢 Connected'
      : statusClass === 'detecting' ? '🟠 Detecting...'
        : '🔴 Disconnected';
    html += `<div class="agm-security"><span>🔒 100% Local — Zero external connections</span><span class="agm-status ${statusClass}">${statusLabel}</span></div>`;

    if (s.showUserInfoCard !== false && s.user) {
      const initial = esc((s.user.name || 'U')[0].toUpperCase());
      html += `<div class="agm-card">
        <div class="agm-user-card">
          <div class="agm-user-avatar">${initial}</div>
          <div class="agm-user-info">
            <div class="agm-user-name">${esc(s.user.name || 'User')}</div>
            <div class="agm-user-tier">${esc(s.user.tier || s.user.planName || '')}</div>
          </div>
        </div>
      </div>`;
    }

    if (s.quotas && s.quotas.length > 0) {
      html += `<div class="agm-card">
        <div class="agm-card-title">📊 Quota
          <button class="agm-refresh-btn" data-action="refreshNow" id="agm-refresh-btn">🔄 REFRESH</button>
        </div>
        <div class="agm-gauges">`;
      for (const q of s.quotas) {
        html += renderGauge(q);
      }
      html += `</div></div>`;
    }

    if (s.showCreditsCard !== false && s.tokenUsage) {
      html += `<div class="agm-card">
        <div class="agm-card-title">💳 Credits</div>
        <div class="agm-credits">`;
      if (s.tokenUsage.promptCredits) {
        html += renderCredit('Prompt', s.tokenUsage.promptCredits);
      }
      if (s.tokenUsage.flowCredits) {
        html += renderCredit('Flow', s.tokenUsage.flowCredits);
      }
      html += `</div></div>`;
    }

    if (s.chart && s.chart.points && s.chart.points.length > 0) {
      const sc = s.chart.sessionConsumption;
      let consumptionHtml = '';
      if (sc && sc.total > 0) {
        consumptionHtml = `<div class="agm-session-consumption">
          <span style="color:#42A5F5">⬤ Prompt: -${formatNum(sc.prompt)}</span>
          <span style="color:#AB47BC">⬤ Flow: -${formatNum(sc.flow)}</span>
        </div>`;
      }
      html += `<div class="agm-card">
        <div class="agm-card-title">📈 Usage History</div>
        ${consumptionHtml}
        ${renderSparkline(s.chart)}
      </div>`;
    }

    if (s.cache) {
      html += `<div class="agm-card">
        <div class="agm-card-title">💾 Cache — ${esc(s.cache.formattedTotal || '0 B')}</div>
        <div style="font-size:11px;opacity:0.7">
          Brain: ${esc(s.cache.formattedBrain || '0 B')} · 
          Conversations: ${esc(s.cache.formattedConversations || '0 B')}
        </div>
      </div>`;
    }

    html += `<div class="agm-toggle" data-action="toggleAutoAccept">
      <div class="agm-toggle-switch ${s.autoAcceptEnabled ? 'on' : ''}"></div>
      <span class="agm-toggle-label">🚀 Auto-Accept ${s.autoAcceptEnabled ? 'ON' : 'OFF'}</span>
      <span class="agm-shortcut-hint"><span class="agm-kbd">Ctrl+Shift+A</span></span>
    </div>`;

    if (s.tasks) {
      html += renderTreeSection('🧠 Brain', s.tasks, 'toggleTasks', 'task');
    }

    if (s.contexts) {
      html += renderTreeSection('📁 Code Tracker', s.contexts, 'toggleProjects', 'context');
    }

    html += `<div class="agm-actions">
      <button class="agm-action-btn" data-action="openRules">📝 Rules</button>
      <button class="agm-action-btn" data-action="openMcp">🔧 MCP</button>
      <button class="agm-action-btn" data-action="openBrowserAllowlist">🌐 Allowlist</button>
    </div>`;
    html += `<div class="agm-actions">
      <button class="agm-action-btn" data-action="restartLanguageServer">🔄 Restart Service</button>
      <button class="agm-action-btn" data-action="restartUserStatusUpdater">♻️ Reset Status</button>
      <button class="agm-action-btn" data-action="reloadWindow">🔃 Reload Window</button>
    </div>`;
    html += `<div class="agm-actions">
      <button class="agm-action-btn" data-action="runDiagnostics">🔍 Diagnostics</button>
      <button class="agm-action-btn" data-action="showLogs">📋 Logs</button>
    </div>`;

    app.innerHTML = html;
  }

  function renderGauge(q) {
    const pct = q.remaining || 0;
    const color = q.themeColor || '#69F0AE';
    const label = q.label || q.id || '';
    const resetTime = q.resetTime || 'N/A';
    const noData = q.hasData === false;

    const threshColor = pct <= 10 ? 'var(--agm-danger)' : pct <= 30 ? 'var(--agm-warning)' : color;
    const pctClass = pct <= 10 ? 'agm-pct-danger' : pct <= 30 ? 'agm-pct-warning' : 'agm-pct-healthy';

    if (noData) {
      return `<div class="agm-gauge">
        <div class="agm-gauge-label">${esc(label)}</div>
        <div class="agm-progress-circle" style="background: conic-gradient(rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.08) 100%)">
          <div class="agm-progress-inner">
            <span class="agm-progress-pct" style="opacity:0.3">—</span>
          </div>
        </div>
        <div class="agm-gauge-reset">N/A</div>
      </div>`;
    }

    return `<div class="agm-gauge">
      <div class="agm-gauge-label">${esc(label)}</div>
      <div class="agm-progress-circle" style="background: conic-gradient(${threshColor} 0%, ${threshColor} ${pct}%, rgba(255,255,255,0.08) ${pct}%, rgba(255,255,255,0.08) 100%)">
        <div class="agm-progress-inner">
          <span class="agm-progress-pct ${pctClass}">${Math.round(pct)}%</span>
          <span class="agm-progress-sub">${pct <= 10 ? '⚠️' : pct <= 30 ? '⏳' : '✓'}</span>
        </div>
      </div>
      <div class="agm-gauge-reset">⏱ ${esc(resetTime)}</div>
    </div>`;
  }

  function renderCredit(label, credit) {
    const avail = formatNum(credit.available);
    const monthly = formatNum(credit.monthly);
    const pct = credit.remainingPct != null ? Math.round(credit.remainingPct) : '—';
    return `<div class="agm-credit-item">
      <div class="agm-credit-label">${esc(label)}</div>
      <div class="agm-credit-value">${pct}%</div>
      <div class="agm-credit-sub">${avail} / ${monthly}</div>
    </div>`;
  }

  function renderSparkline(chart) {
    const points = chart.points || [];
    const rangeMin = chart.displayMinutes || 90;

    if (points.length < 2) {
      return '<div style="text-align:center;font-size:11px;color:var(--agm-fg-dim)">Collecting data — line appears after 2+ data points</div>';
    }

    // Detect if values are flat (no variation) — skip chart if nothing changed
    const promptVals = points.map(p => p.prompt).filter(v => v > 0);
    const flowVals = points.map(p => p.flow).filter(v => v > 0);
    const promptFlat = promptVals.length < 2 || new Set(promptVals).size === 1;
    const flowFlat = flowVals.length < 2 || new Set(flowVals).size === 1;
    if (promptFlat && flowFlat) {
      return `<div style="text-align:center;font-size:11px;color:var(--agm-fg-dim)">
        No changes in the last ${rangeMin}m
      </div>`;
    }

    const W = 280, H = 70, PAD = 2;
    const now = Date.now();
    const t0 = now - rangeMin * 60 * 1000;

    // Determine min/max for Y axis (use both prompt and flow)
    let minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.prompt > 0) { minY = Math.min(minY, p.prompt); maxY = Math.max(maxY, p.prompt); }
      if (p.flow > 0) { minY = Math.min(minY, p.flow); maxY = Math.max(maxY, p.flow); }
    }
    if (minY === Infinity) { minY = 0; maxY = 100; }
    // Add 10% padding to Y range
    const yRange = maxY - minY || 1;
    minY = Math.max(0, minY - yRange * 0.1);
    maxY = maxY + yRange * 0.1;

    function toX(t) { return PAD + ((t - t0) / (now - t0)) * (W - 2 * PAD); }
    function toY(v) { return PAD + (1 - (v - minY) / (maxY - minY)) * (H - 2 * PAD); }

    // Build polyline paths
    const hasPrompt = points.some(p => p.prompt > 0);
    const hasFlow = points.some(p => p.flow > 0);

    function buildPath(key) {
      const filtered = points.filter(p => p[key] > 0);
      if (filtered.length < 2) return '';
      return filtered.map((p, i) => {
        const x = toX(p.t).toFixed(1);
        const y = toY(p[key]).toFixed(1);
        return (i === 0 ? 'M' : 'L') + x + ',' + y;
      }).join(' ');
    }

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="agm-sparkline">`;

    // Grid lines (subtle)
    for (let i = 0; i <= 4; i++) {
      const y = PAD + (i / 4) * (H - 2 * PAD);
      svg += `<line x1="${PAD}" y1="${y.toFixed(1)}" x2="${W - PAD}" y2="${y.toFixed(1)}" stroke="var(--agm-border)" stroke-width="0.5" stroke-dasharray="2,3"/>`;
    }

    // Prompt line (blue)
    if (hasPrompt) {
      const path = buildPath('prompt');
      if (path) {
        svg += `<path d="${path}" fill="none" stroke="#42A5F5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
        // Last point dot
        const last = points.filter(p => p.prompt > 0).slice(-1)[0];
        if (last) svg += `<circle cx="${toX(last.t).toFixed(1)}" cy="${toY(last.prompt).toFixed(1)}" r="3" fill="#42A5F5"/>`;
      }
    }

    // Flow line (purple)
    if (hasFlow) {
      const path = buildPath('flow');
      if (path) {
        svg += `<path d="${path}" fill="none" stroke="#AB47BC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
        const last = points.filter(p => p.flow > 0).slice(-1)[0];
        if (last) svg += `<circle cx="${toX(last.t).toFixed(1)}" cy="${toY(last.flow).toFixed(1)}" r="3" fill="#AB47BC"/>`;
      }
    }

    svg += '</svg>';

    // Y-axis labels
    const topLabel = formatNum(Math.round(maxY));
    const botLabel = formatNum(Math.round(minY));

    let html = `<div class="agm-sparkline-wrap">`;
    html += `<div class="agm-sparkline-ylabels"><span>${topLabel}</span><span>${botLabel}</span></div>`;
    html += svg;
    html += `</div>`;
    html += `<div class="agm-chart-labels"><span>-${rangeMin}m</span><span>Now</span></div>`;
    return html;
  }

  function renderTreeSection(title, section, toggleMsg, itemType) {
    const expanded = section.expanded;
    const folders = section.folders || [];
    const count = folders.length;

    let html = `<div class="agm-section">
      <div class="agm-section-header" data-action="${toggleMsg}">
        <span class="agm-section-arrow ${expanded ? 'expanded' : ''}">▶</span>
        <span>${title}</span>
        <span class="agm-section-badge">${count}</span>
      </div>`;

    if (expanded) {
      if (folders.length === 0) {
        html += `<div style="padding:4px 24px;font-size:11px;opacity:0.5">Empty</div>`;
      } else {
        for (const folder of folders) {
          const toggleAction = itemType === 'task' ? 'toggleTask' : 'toggleContext';
          const deleteAction = itemType === 'task' ? 'deleteTask' : 'deleteContext';

          html += `<div class="agm-tree-item" data-action="${toggleAction}" data-id="${esc(folder.id)}">
            <span class="agm-section-arrow ${folder.expanded ? 'expanded' : ''}">▶</span>
            <span class="agm-tree-item-label" title="${esc(folder.id)}">${esc(folder.label || folder.id)}</span>
            <span class="agm-tree-item-size">${esc(folder.size || '')}</span>
            <button class="agm-delete-btn" data-action="${deleteAction}" data-id="${esc(folder.id)}" title="Delete">🗑️</button>
          </div>`;

          if (folder.expanded && folder.files) {
            for (const file of folder.files) {
              html += `<div class="agm-tree-item agm-tree-file" data-action="openFile" data-path="${esc(file.path)}">
                📄 ${esc(file.name)}
              </div>`;
            }
          }
        }
      }
    }
    html += '</div>';
    return html;
  }

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function formatNum(n) {
    if (n == null) return 'N/A';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toString();
  }

  post('webviewReady');
})();
