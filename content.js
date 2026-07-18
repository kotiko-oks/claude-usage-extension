(function () {
  'use strict';

  const REFRESH_INTERVAL = 60 * 1000;
  const MODES      = ['full', 'mini', 'dot'];
  const STORAGE_KEY = 'cuw_mode';
  const DOCK_KEY    = 'cuw_docked';
  const POS_KEY     = 'cuw_pos';

  let widgetEl     = null;
  let refreshTimer = null;
  let currentOrgId = null;
  let lastData     = null;
  let currentMode  = 'full';
  let isDocked     = false;
  let dockTargetEl = null;
  let isDragging   = false;

  // Stores the widget-level mousedown handler so we can remove it before adding a new one.
  // Prevents accumulation of stale listeners when switching to/from dot mode.
  let _widgetDragHandler = null;

  /* ── theme ── */

  function detectTheme() {
    const cookieM = document.cookie.match(/CH-prefers-color-scheme=(light|dark)/);
    if (cookieM) return cookieM[1];
    const html = document.documentElement;
    if (html.classList.contains('dark'))  return 'dark';
    if (html.classList.contains('light')) return 'light';
    const attr = html.getAttribute('data-color-scheme') || html.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m  = bg && bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const luma = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
      return luma < 140 ? 'dark' : 'light';
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    if (!widgetEl) return;
    const theme = detectTheme();
    widgetEl.setAttribute('data-cuw-theme', theme);
    if (dockTargetEl) dockTargetEl.setAttribute('data-cuw-theme', theme);
  }

  /* ── helpers ── */

  function getOrgId() {
    const m = document.cookie.match(/lastActiveOrg=([a-f0-9-]{36})/);
    if (m) return m[1];
    const urlM = location.pathname.match(/organizations\/([a-f0-9-]{36})/);
    if (urlM) return urlM[1];
    return null;
  }

  async function fetchUsage(orgId) {
    const res = await fetch(
      `https://claude.ai/api/organizations/${orgId}/usage`,
      { credentials: 'include', headers: { 'content-type': 'application/json' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function formatTimeLeft(isoString) {
    const diff = new Date(isoString) - Date.now();
    if (diff <= 0) return 'истекла';
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    const s = Math.floor((diff % 60_000) / 1_000);
    if (h > 0) return `${h}ч ${m}м`;
    if (m > 0) return `${m}м ${s}с`;
    return `${s}с`;
  }

  function getSev(pct) {
    if (pct >= 90) return 'danger';
    if (pct >= 70) return 'warning';
    return 'ok';
  }

  /* ── mode ── */

  function setMode(mode) {
    currentMode = mode;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) {}
    renderWidget();
    // Snap to nearest edge after resize — skip during drag or when docked
    if (!isDocked && !isDragging) {
      setTimeout(function () {
        if (!widgetEl || isDragging || isDocked) return;
        const r = widgetEl.getBoundingClientRect();
        applyEdgePosition(widgetEl, r.left, r.top);
      }, 0);
    }
  }

  /* ── render ── */

  function renderWidget() {
    if (!widgetEl) return;
    applyTheme();

    const session   = lastData?.five_hour;
    const pct       = session ? Math.round(session.utilization ?? 0) : 0;
    const sev       = getSev(pct);
    const timeLeft  = session?.resets_at ? formatTimeLeft(session.resets_at) : '—';
    const resetTime = session?.resets_at
      ? new Date(session.resets_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : '—';

    widgetEl.setAttribute('data-cuw-mode', currentMode);

    /* ── DOT ── */
    if (currentMode === 'dot') {
      const R   = 17;
      const C   = 2 * Math.PI * R;
      const off = C - (pct / 100) * C;
      // Smaller SVG when embedded in the sidebar
      const svgSize = isDocked ? 28 : 44;
      const tip = isDocked
        ? `Нажмите — открыть · Тяните — вытащить (${pct}%, осталось ${timeLeft})`
        : `Развернуть (${pct}%, осталось ${timeLeft})`;
      widgetEl.innerHTML = `
        <button class="cuw-dot-btn" title="${tip}">
          <svg width="${svgSize}" height="${svgSize}" viewBox="0 0 44 44" fill="none">
            <circle cx="22" cy="22" r="${R}" class="cuw-ring-bg"/>
            <circle cx="22" cy="22" r="${R}" class="cuw-ring-fill cuw-ring-${sev}"
              stroke-dasharray="${C.toFixed(2)}"
              stroke-dashoffset="${off.toFixed(2)}"
              transform="rotate(-90 22 22)"/>
            <text x="22" y="26" class="cuw-ring-text">${pct}%</text>
          </svg>
        </button>`;
      // Non-docked: button-element click (the 2px border ring) expands the widget.
      // SVG-element click and docked-click are handled by the drag handler's mouseup.
      if (!isDocked) {
        widgetEl.querySelector('.cuw-dot-btn').addEventListener('click', function () {
          setMode('full');
        });
      }
      makeDraggable(widgetEl, null);
      return;
    }

    /* ── MINI ── */
    if (currentMode === 'mini') {
      widgetEl.innerHTML = `
        <div class="cuw-mini-inner">
          <div class="cuw-mini-row">
            <span class="cuw-mini-pct cuw-${sev}">${pct}%</span>
            <span class="cuw-mini-time">${timeLeft}</span>
            <button class="cuw-btn-icon cuw-refresh-mini" title="Обновить">↻</button>
            <button class="cuw-btn-icon" data-mode="full" title="Развернуть">▣</button>
            <button class="cuw-btn-icon" data-mode="dot" title="Свернуть в точку">◉</button>
          </div>
          <div class="cuw-bar">
            <div class="cuw-fill cuw-fill-${sev}" style="width:${Math.min(pct, 100)}%"></div>
          </div>
        </div>`;
      widgetEl.querySelector('.cuw-refresh-mini').addEventListener('click', function () { loadData(true); });
      widgetEl.querySelectorAll('[data-mode]').forEach(function (btn) {
        btn.addEventListener('click', function () { setMode(btn.dataset.mode); });
      });
      makeDraggable(widgetEl, '.cuw-mini-inner');
      return;
    }

    /* ── FULL ── */
    widgetEl.innerHTML = `
      <div class="cuw-header">
        <span class="cuw-title">Сессия · 5ч</span>
        <button class="cuw-btn-icon cuw-refresh" title="Обновить">↻</button>
        <button class="cuw-btn-icon" data-mode="mini" title="Компактный режим">▤</button>
        <button class="cuw-btn-icon" data-mode="dot" title="Свернуть в точку">◉</button>
      </div>
      <div class="cuw-body">
        ${!lastData
          ? '<div class="cuw-loading">Загрузка…</div>'
          : `<div class="cuw-pct cuw-${sev}">${pct}%</div>
             <div class="cuw-bar-wrap">
               <div class="cuw-bar">
                 <div class="cuw-fill cuw-fill-${sev}" style="width:${Math.min(pct, 100)}%"></div>
               </div>
             </div>
             <div class="cuw-meta">
               <span class="cuw-label">Осталось</span>
               <span class="cuw-value">${timeLeft}</span>
             </div>
             <div class="cuw-meta">
               <span class="cuw-label">Сброс в</span>
               <span class="cuw-value">${resetTime}</span>
             </div>
             <div class="cuw-updated">обновлено только что</div>`
        }
      </div>`;
    widgetEl.querySelector('.cuw-refresh')?.addEventListener('click', function () { loadData(true); });
    widgetEl.querySelectorAll('[data-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () { setMode(btn.dataset.mode); });
    });
    makeDraggable(widgetEl, '.cuw-header');
  }

  /* ── data ── */

  async function loadData(manual = false) {
    if (!widgetEl) return;
    if (!currentOrgId) currentOrgId = getOrgId();

    if (!currentOrgId) {
      if (currentMode === 'full') {
        const body = widgetEl.querySelector('.cuw-body');
        if (body) body.innerHTML = '<div class="cuw-error">Не найден org ID</div>';
      }
      return;
    }

    if (manual && currentMode === 'full') {
      const body = widgetEl.querySelector('.cuw-body');
      if (body) body.innerHTML = '<div class="cuw-loading">Загрузка…</div>';
    }

    try {
      lastData = await fetchUsage(currentOrgId);
      renderWidget();
      scheduleRefresh();
    } catch (e) {
      if (currentMode === 'full') {
        const body = widgetEl.querySelector('.cuw-body');
        if (body) body.innerHTML = `<div class="cuw-error">Ошибка: ${e.message}</div>`;
      }
      scheduleRefresh();
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { loadData(); }, REFRESH_INTERVAL);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      clearTimeout(refreshTimer);
      loadData();
    }
  });

  /* ── dock ── */

  function injectDockTarget() {
    if (document.getElementById('cuw-dock-target')) {
      dockTargetEl = document.getElementById('cuw-dock-target');
      return true;
    }

    // The button sits inside: div.relative.overflow-visible → flex-row (gap-2 etc.)
    const appsBtn   = document.querySelector('[aria-label="Get apps and extensions"]');
    if (!appsBtn) return false;
    const btnWrapper = appsBtn.parentElement;          // div.relative.overflow-visible
    const flexRow    = btnWrapper && btnWrapper.parentElement; // the flex row
    if (!flexRow) return false;

    dockTargetEl = document.createElement('div');
    dockTargetEl.id    = 'cuw-dock-target';
    dockTargetEl.title = 'Перетащите виджет сюда чтобы встроить';
    dockTargetEl.setAttribute('data-cuw-theme', detectTheme());
    flexRow.insertBefore(dockTargetEl, btnWrapper);

    // Restore dock state that was saved before SPA navigation
    try {
      if (localStorage.getItem(DOCK_KEY) === '1' && !isDocked && widgetEl) {
        dockWidget();
      }
    } catch (_) {}

    return true;
  }

  function tryInjectDockTarget(attempt) {
    attempt = attempt || 0;
    if (!injectDockTarget() && attempt < 20) {
      setTimeout(function () { tryInjectDockTarget(attempt + 1); }, 500);
    }
  }

  function dockWidget() {
    if (!dockTargetEl || !widgetEl) return;
    isDocked = true;
    try { localStorage.setItem(DOCK_KEY, '1'); } catch (_) {}
    // Clear all inline position styles so CSS can take over (position: static !important)
    widgetEl.style.position = '';
    widgetEl.style.left     = '';
    widgetEl.style.right    = '';
    widgetEl.style.top      = '';
    widgetEl.style.bottom   = '';
    widgetEl.setAttribute('data-cuw-docked', 'true');
    dockTargetEl.appendChild(widgetEl);
    dockTargetEl.classList.remove('cuw-dock-dragging', 'cuw-dock-active', 'cuw-dock-hover');
    dockTargetEl.classList.add('cuw-dock-occupied');
    setMode('dot'); // always dock as dot; re-renders with isDocked=true (28px SVG)
  }

  function undockWidget(targetX, targetY) {
    if (!widgetEl) return;
    isDocked = false;
    try { localStorage.removeItem(DOCK_KEY); } catch (_) {}
    widgetEl.removeAttribute('data-cuw-docked');
    document.body.appendChild(widgetEl);
    if (dockTargetEl) dockTargetEl.classList.remove('cuw-dock-occupied');
    const x = (targetX !== null && targetX !== undefined) ? targetX : window.innerWidth - 80;
    const y = (targetY !== null && targetY !== undefined) ? targetY : window.innerHeight - 80;
    applyEdgePosition(widgetEl, x, y);
    // Caller is responsible for rendering/mode changes after undocking
  }

  /* ── drag (edge-anchored + dock support) ── */

  function applyEdgePosition(el, left, top) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w  = el.offsetWidth;
    const h  = el.offsetHeight;
    const M  = 8;
    left = Math.max(M, Math.min(left, vw - w - M));
    top  = Math.max(M, Math.min(top,  vh - h - M));
    const fr = vw - left - w;
    const fb = vh - top  - h;
    el.style.left   = left <= fr ? left + 'px' : 'auto';
    el.style.right  = left <= fr ? 'auto' : fr + 'px';
    el.style.top    = top  <= fb ? top  + 'px' : 'auto';
    el.style.bottom = top  <= fb ? 'auto' : fb + 'px';
  }

  let resizeListenerAdded = false;

  function makeDraggable(el, handleSelector) {
    // Always remove the previous widget-level handler to prevent listener accumulation.
    // Handlers on child elements (.cuw-header, .cuw-mini-inner) auto-clean when innerHTML is replaced.
    if (_widgetDragHandler) {
      el.removeEventListener('mousedown', _widgetDragHandler);
      _widgetDragHandler = null;
    }

    const handle = handleSelector ? el.querySelector(handleSelector) : el;
    if (!handle) return;

    if (!isDocked) handle.style.cursor = 'grab';

    const handler = function (e) {
      // Non-docked: if the click lands directly on a BUTTON element, let its own
      // click handler fire (e.g. ◉ mode buttons, ↻ refresh). Drag is on non-button areas.
      if (e.target.tagName === 'BUTTON' && !isDocked) return;

      // preventDefault suppresses text-selection and (in Chrome/Firefox) the subsequent
      // click event — so manual action on mouseup is needed for click-without-drag.
      e.preventDefault();

      const wasDocked = isDocked;
      const mX = e.clientX; // position at mousedown
      const mY = e.clientY;

      let dragStarted = false;
      let ox = 0, oy = 0;
      let dragRefX = mX;
      let dragRefY = mY;

      function onMove(ev) {
        // Threshold of 4 px to distinguish click from drag
        if (!dragStarted && (Math.abs(ev.clientX - mX) > 4 || Math.abs(ev.clientY - mY) > 4)) {
          dragStarted = true;
          isDragging  = true;

          // Step 1: undock if needed. Docked is always 28px dot → re-render to 44px floating dot.
          if (wasDocked) {
            undockWidget(mX - 24, mY - 24);
            setMode('dot'); // re-renders at floating 44px size, positions near cursor
          }
          // Non-docked: widget stays in its current mode (full/mini/dot) during drag.

          // Step 2: capture reference position for subsequent move calculations.
          const rect = el.getBoundingClientRect();
          ox       = rect.left;
          oy       = rect.top;
          dragRefX = mX;
          dragRefY = mY;

          document.body.style.cursor = 'grabbing';
          // cuw-dock-dragging makes the slot visible; cuw-dock-active highlights it.
          if (dockTargetEl) dockTargetEl.classList.add('cuw-dock-dragging', 'cuw-dock-active');
        }

        if (dragStarted) {
          applyEdgePosition(el, ox + ev.clientX - dragRefX, oy + ev.clientY - dragRefY);

          if (dockTargetEl) {
            const dr   = dockTargetEl.getBoundingClientRect();
            const over = ev.clientX >= dr.left && ev.clientX <= dr.right
                      && ev.clientY >= dr.top  && ev.clientY <= dr.bottom;
            dockTargetEl.classList.toggle('cuw-dock-hover', over);
          }
        }
      }

      function onUp(ev) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',  onUp);
        document.body.style.cursor = '';
        isDragging = false;

        if (!dragStarted) {
          // ── Click without drag ──
          if (wasDocked) {
            // Position full widget to the right of the sidebar dock zone
            const dr = dockTargetEl ? dockTargetEl.getBoundingClientRect() : null;
            const tx = dr ? Math.min(dr.right + 16, window.innerWidth - 240) : window.innerWidth - 240;
            const ty = dr ? Math.max(8, dr.top - 80) : window.innerHeight - 200;
            undockWidget(tx, ty);
            setMode('full');
          } else if (currentMode === 'dot') {
            // Non-docked dot: SVG-area click (button-element clicks are handled by the button's listener)
            setMode('full');
          }
          return;
        }

        // ── Drag ended — check if dropped on dock zone ──
        if (dockTargetEl) {
          const dr   = dockTargetEl.getBoundingClientRect();
          const over = ev.clientX >= dr.left && ev.clientX <= dr.right
                    && ev.clientY >= dr.top  && ev.clientY <= dr.bottom;
          dockTargetEl.classList.remove('cuw-dock-dragging', 'cuw-dock-active', 'cuw-dock-hover');
          if (over) { dockWidget(); return; }
        }
        // Dropped elsewhere — widget stays in its current mode
        try { localStorage.setItem(POS_KEY, JSON.stringify({l: widgetEl.style.left, r: widgetEl.style.right, t: widgetEl.style.top, b: widgetEl.style.bottom})); } catch(_) {}
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',  onUp);
    };

    handle.addEventListener('mousedown', handler);

    // Remember widget-level handler for cleanup on the next makeDraggable call
    if (!handleSelector) {
      _widgetDragHandler = handler;
    }

    if (!resizeListenerAdded) {
      resizeListenerAdded = true;
      window.addEventListener('resize', function () {
        if (!widgetEl || isDocked) return;
        const r = widgetEl.getBoundingClientRect();
        applyEdgePosition(widgetEl, r.left, r.top);
        try { localStorage.setItem(POS_KEY, JSON.stringify({l: widgetEl.style.left, r: widgetEl.style.right, t: widgetEl.style.top, b: widgetEl.style.bottom})); } catch(_) {}
      });
    }
  }

  /* ── init ── */

  function init() {
    if (document.getElementById('claude-usage-widget')) return;

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (MODES.includes(saved)) currentMode = saved;
    } catch (_) {}

    currentOrgId = getOrgId();

    widgetEl = document.createElement('div');
    widgetEl.id = 'claude-usage-widget';
    document.body.appendChild(widgetEl);
    try {
      const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (pos) { widgetEl.style.left = pos.l; widgetEl.style.right = pos.r; widgetEl.style.top = pos.t; widgetEl.style.bottom = pos.b; }
    } catch(_) {}

    renderWidget();
    loadData();

    // Try to inject dock target immediately; retries up to 10 s for lazy sidebar render
    tryInjectDockTarget();

    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true, attributeFilter: ['class', 'data-color-scheme', 'data-theme']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // SPA navigation + dock target resurrection
  let lastUrl = location.href;
  new MutationObserver(function () {
    // Re-inject whenever the dock target is removed (e.g. nav sidebar re-render on toggle).
    // Setting dockTargetEl = null immediately prevents re-entry on the same wave of mutations.
    if (dockTargetEl && !document.contains(dockTargetEl)) {
      dockTargetEl = null;
      tryInjectDockTarget();
    }

    if (location.href === lastUrl) return;
    lastUrl = location.href;
    setTimeout(function () {
      currentOrgId = getOrgId();

      // If dock target was destroyed by SPA navigation while widget was docked,
      // rescue the widget back to the floating layer before it's lost
      if (isDocked && !document.getElementById('cuw-dock-target')) {
        if (widgetEl) {
          document.body.appendChild(widgetEl);
          widgetEl.removeAttribute('data-cuw-docked');
          isDocked = false;
          applyEdgePosition(widgetEl, window.innerWidth - 80, window.innerHeight - 80);
          renderWidget();
        }
      }

      if (!document.getElementById('claude-usage-widget')) {
        widgetEl = null;
        _widgetDragHandler = null;
        init();
      } else {
        loadData();
        tryInjectDockTarget();
      }
    }, 800);
  }).observe(document.body, { childList: true, subtree: true });

})();
