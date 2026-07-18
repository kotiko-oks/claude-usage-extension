(function () {
  'use strict';

  const REFRESH_INTERVAL = 60 * 1000;
  const MODES       = ['full', 'mini', 'dot'];
  const STORAGE_KEY = 'cuw_mode';
  const DOCK_KEY    = 'cuw_dock_slot'; // stores slot id of active dock, or nothing
  const POS_KEY     = 'cuw_pos';

  let widgetEl     = null;
  let refreshTimer = null;
  let currentOrgId = null;
  let lastData     = null;
  let currentMode  = 'full';
  let isDocked     = false;
  let activeDockEl = null;   // the dock target el the widget currently lives in
  let allDockEls   = [];     // all injected dock target elements
  let isDragging   = false;

  let _widgetDragHandler = null;

  /* ── theme ── */

  function detectTheme() {
    const cm = document.cookie.match(/CH-prefers-color-scheme=(light|dark)/);
    if (cm) return cm[1];
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
    allDockEls.forEach(function (el) { el.setAttribute('data-cuw-theme', theme); });
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
        btn.addEventListener('click', function () {
          if (isDocked && btn.dataset.mode === 'full') {
            // Expand button while docked: fly out of the slot then open full
            const dr = activeDockEl ? activeDockEl.getBoundingClientRect() : null;
            const tx = dr ? Math.min(dr.right + 16, window.innerWidth - 240) : window.innerWidth - 240;
            const ty = dr ? Math.max(8, dr.top - 80) : window.innerHeight - 200;
            undockWidget(tx, ty);
            setMode('full');
          } else {
            setMode(btn.dataset.mode);
          }
        });
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

  function makeDockEl(id, mode) {
    const el = document.createElement('div');
    el.id = id;
    el.dataset.cuwDockMode = mode;
    el.setAttribute('data-cuw-theme', detectTheme());
    if (mode === 'mini') el.classList.add('cuw-dock-mini');
    return el;
  }

  // Restore saved dock after injection
  function tryRestoreDock(el) {
    try {
      if (localStorage.getItem(DOCK_KEY) === el.id && !isDocked && widgetEl) {
        dockWidget(el);
      }
    } catch (_) {}
  }

  function injectSidebarDock() {
    if (document.getElementById('cuw-dock-sidebar')) {
      const existing = document.getElementById('cuw-dock-sidebar');
      if (!allDockEls.includes(existing)) allDockEls.push(existing);
      return true;
    }
    const appsBtn   = document.querySelector('[aria-label="Get apps and extensions"]');
    if (!appsBtn) return false;
    const btnWrapper = appsBtn.parentElement;
    const flexRow    = btnWrapper && btnWrapper.parentElement;
    if (!flexRow) return false;

    const el = makeDockEl('cuw-dock-sidebar', 'dot');
    el.title = 'Перетащите виджет сюда';
    flexRow.insertBefore(el, btnWrapper);
    allDockEls.push(el);
    tryRestoreDock(el);
    return true;
  }

  function injectChatDocks() {
    const wiggleDiv = document.querySelector('[data-testid="wiggle-controls-actions"]');
    if (!wiggleDiv) return false;

    // Left dot — first child of wiggleDiv
    if (!document.getElementById('cuw-dock-chat-left')) {
      const el = makeDockEl('cuw-dock-chat-left', 'dot');
      el.title = 'Перетащите виджет сюда (точка)';
      wiggleDiv.prepend(el);
      allDockEls.push(el);
      tryRestoreDock(el);
    } else {
      const ex = document.getElementById('cuw-dock-chat-left');
      if (!allDockEls.includes(ex)) allDockEls.push(ex);
    }

    // Right dot — last child of wiggleDiv
    if (!document.getElementById('cuw-dock-chat-right')) {
      const el = makeDockEl('cuw-dock-chat-right', 'dot');
      el.title = 'Перетащите виджет сюда (точка)';
      wiggleDiv.append(el);
      allDockEls.push(el);
      tryRestoreDock(el);
    } else {
      const ex = document.getElementById('cuw-dock-chat-right');
      if (!allDockEls.includes(ex)) allDockEls.push(ex);
    }

    // Mini strip — absolutely positioned below wiggleDiv inside its parent
    if (!document.getElementById('cuw-dock-chat-mini')) {
      const parent = wiggleDiv.parentElement;
      if (!parent) return true; // dots are done at least
      const el = makeDockEl('cuw-dock-chat-mini', 'mini');
      el.title = 'Перетащите виджет сюда (мини)';
      // wiggleDiv is md:absolute md:top-0; h-12 = 48px, so top:48px places us right below
      el.style.cssText = 'position:absolute;top:48px;right:0;';
      // ensure parent is a positioned container
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(el);
      allDockEls.push(el);
      tryRestoreDock(el);
    } else {
      const ex = document.getElementById('cuw-dock-chat-mini');
      if (!allDockEls.includes(ex)) allDockEls.push(ex);
    }

    return true;
  }

  function injectInputBarDocks() {
    // 1. Right of attach button (after div.relative.shrink-0 wrapping it)
    if (!document.getElementById('cuw-dock-input-attach')) {
      const attachBtn = document.querySelector('[aria-label="Add files, connectors, and more"]');
      if (!attachBtn) return false;
      const attachWrapper = attachBtn.parentElement && attachBtn.parentElement.parentElement;
      if (!attachWrapper) return false;
      const el = makeDockEl('cuw-dock-input-attach', 'dot');
      el.title = 'Перетащите виджет сюда';
      attachWrapper.insertAdjacentElement('afterend', el);
      allDockEls.push(el);
      tryRestoreDock(el);
    } else {
      const ex = document.getElementById('cuw-dock-input-attach');
      if (!allDockEls.includes(ex)) allDockEls.push(ex);
    }

    // 2. Left of model selector container (before the flex wrapper holding model button)
    if (!document.getElementById('cuw-dock-input-model')) {
      const modelBtn = document.querySelector('[data-testid="model-selector-dropdown"]');
      if (!modelBtn) return false;
      // button → div.overflow-hidden → span.inline-flex → div.flex.items-center.gap-2
      const modelContainer = modelBtn.parentElement &&
                             modelBtn.parentElement.parentElement &&
                             modelBtn.parentElement.parentElement.parentElement;
      if (!modelContainer) return false;
      const el = makeDockEl('cuw-dock-input-model', 'dot');
      el.title = 'Перетащите виджет сюда';
      modelContainer.insertAdjacentElement('beforebegin', el);
      allDockEls.push(el);
      tryRestoreDock(el);
    } else {
      const ex = document.getElementById('cuw-dock-input-model');
      if (!allDockEls.includes(ex)) allDockEls.push(ex);
    }

    // 3. Left of recording/settings area (before div.shrink-0 wrapping them)
    if (!document.getElementById('cuw-dock-input-record')) {
      const recordBtn = document.querySelector('[aria-label="Press and hold to record"]');
      if (!recordBtn) return false;
      // button → div.flex.items-center.rounded-lg → div.shrink-0
      const recordWrapper = recordBtn.parentElement && recordBtn.parentElement.parentElement;
      if (!recordWrapper) return false;
      const el = makeDockEl('cuw-dock-input-record', 'dot');
      el.title = 'Перетащите виджет сюда';
      recordWrapper.insertAdjacentElement('beforebegin', el);
      allDockEls.push(el);
      tryRestoreDock(el);
    } else {
      const ex = document.getElementById('cuw-dock-input-record');
      if (!allDockEls.includes(ex)) allDockEls.push(ex);
    }

    return true;
  }

  function tryInjectAll(attempt) {
    attempt = attempt || 0;
    injectSidebarDock();
    injectChatDocks();
    injectInputBarDocks();
    // Retry a few times for lazy-rendered elements
    if (attempt < 20) {
      const needSidebar   = !document.getElementById('cuw-dock-sidebar');
      const needChat      = !document.getElementById('cuw-dock-chat-left');
      const needInputBar  = !document.getElementById('cuw-dock-input-attach');
      if (needSidebar || needChat || needInputBar) {
        setTimeout(function () { tryInjectAll(attempt + 1); }, 500);
      }
    }
  }

  function dockWidget(targetEl) {
    if (!targetEl || !widgetEl) return;
    activeDockEl = targetEl;
    isDocked     = true;
    const mode   = targetEl.dataset.cuwDockMode || 'dot';
    try { localStorage.setItem(DOCK_KEY, targetEl.id); } catch (_) {}
    widgetEl.style.position = '';
    widgetEl.style.left     = '';
    widgetEl.style.right    = '';
    widgetEl.style.top      = '';
    widgetEl.style.bottom   = '';
    widgetEl.setAttribute('data-cuw-docked', 'true');
    widgetEl.setAttribute('data-cuw-dock-mode', mode);
    targetEl.appendChild(widgetEl);
    targetEl.classList.remove('cuw-dock-dragging', 'cuw-dock-active', 'cuw-dock-hover');
    targetEl.classList.add('cuw-dock-occupied');
    setMode(mode);
  }

  function undockWidget(targetX, targetY) {
    if (!widgetEl) return;
    if (activeDockEl) activeDockEl.classList.remove('cuw-dock-occupied');
    activeDockEl = null;
    isDocked     = false;
    try { localStorage.removeItem(DOCK_KEY); } catch (_) {}
    widgetEl.removeAttribute('data-cuw-docked');
    widgetEl.removeAttribute('data-cuw-dock-mode');
    document.body.appendChild(widgetEl);
    const x = (targetX !== null && targetX !== undefined) ? targetX : window.innerWidth - 80;
    const y = (targetY !== null && targetY !== undefined) ? targetY : window.innerHeight - 80;
    applyEdgePosition(widgetEl, x, y);
  }

  /* ── drag ── */

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
    if (_widgetDragHandler) {
      el.removeEventListener('mousedown', _widgetDragHandler);
      _widgetDragHandler = null;
    }

    const handle = handleSelector ? el.querySelector(handleSelector) : el;
    if (!handle) return;

    if (!isDocked) handle.style.cursor = 'grab';

    const handler = function (e) {
      // Skip buttons when there's a specific drag handle (mini/full mode) — let them fire normally.
      // In dot mode (handleSelector=null) we have no separate handle, so buttons go through
      // drag logic and are handled manually in onUp (click-without-drag → undock/expand).
      if (e.target.tagName === 'BUTTON' && handleSelector) return;
      e.preventDefault();

      const wasDocked  = isDocked;
      const prevDockEl = activeDockEl;
      const mX = e.clientX;
      const mY = e.clientY;

      let dragStarted  = false;
      let ox = 0, oy = 0;
      let dragRefX = mX;
      let dragRefY = mY;
      let hoveredDockEl = null;

      function onMove(ev) {
        if (!dragStarted && (Math.abs(ev.clientX - mX) > 4 || Math.abs(ev.clientY - mY) > 4)) {
          dragStarted = true;
          isDragging  = true;

          // When undocking from a docked state: restore the mode it was docked in
          if (wasDocked) {
            const dockMode = prevDockEl ? (prevDockEl.dataset.cuwDockMode || 'dot') : 'dot';
            undockWidget(mX - 24, mY - 24);
            setMode(dockMode); // dot→floating dot (44px), mini→floating mini
          }
          // Non-docked: stay in current mode during drag

          const rect = el.getBoundingClientRect();
          ox       = rect.left;
          oy       = rect.top;
          dragRefX = mX;
          dragRefY = mY;

          document.body.style.cursor = 'grabbing';
          allDockEls.forEach(function (d) { d.classList.add('cuw-dock-dragging', 'cuw-dock-active'); });
        }

        if (dragStarted) {
          applyEdgePosition(el, ox + ev.clientX - dragRefX, oy + ev.clientY - dragRefY);

          // Hover detection across all dock targets
          let newHovered = null;
          allDockEls.forEach(function (d) {
            const dr = d.getBoundingClientRect();
            if (ev.clientX >= dr.left && ev.clientX <= dr.right &&
                ev.clientY >= dr.top  && ev.clientY <= dr.bottom) newHovered = d;
          });
          if (newHovered !== hoveredDockEl) {
            if (hoveredDockEl) hoveredDockEl.classList.remove('cuw-dock-hover');
            hoveredDockEl = newHovered;
            if (hoveredDockEl) hoveredDockEl.classList.add('cuw-dock-hover');
          }
        }
      }

      function onUp(ev) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',  onUp);
        document.body.style.cursor = '';
        isDragging = false;

        if (!dragStarted) {
          // Click without drag
          if (wasDocked && currentMode === 'dot') {
            // Docked dot: just refresh data, don't undock
            loadData(true);
          } else if (wasDocked) {
            const dr = prevDockEl ? prevDockEl.getBoundingClientRect() : null;
            const tx = dr ? Math.min(dr.right + 16, window.innerWidth - 240) : window.innerWidth - 240;
            const ty = dr ? Math.max(8, dr.top - 80) : window.innerHeight - 200;
            undockWidget(tx, ty);
            setMode('full');
          } else if (currentMode === 'dot') {
            setMode('full');
          }
          return;
        }

        // Find drop target FIRST — elements must still be visible (display:inline-flex via cuw-dock-dragging)
        // for getBoundingClientRect() to return real coordinates. Removing cuw-dock-dragging first
        // causes display:none → all rects become zero → drop never registers.
        const dropTarget = allDockEls.find(function (d) {
          const dr = d.getBoundingClientRect();
          return ev.clientX >= dr.left && ev.clientX <= dr.right &&
                 ev.clientY >= dr.top  && ev.clientY <= dr.bottom;
        });

        // THEN clean up dock highlights
        allDockEls.forEach(function (d) {
          d.classList.remove('cuw-dock-dragging', 'cuw-dock-active', 'cuw-dock-hover');
        });

        if (dropTarget) {
          dockWidget(dropTarget);
        } else {
          // Stays floating in current mode — save position
          try { localStorage.setItem(POS_KEY, JSON.stringify({l: el.style.left, r: el.style.right, t: el.style.top, b: el.style.bottom})); } catch(_) {}
        }
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',  onUp);
    };

    handle.addEventListener('mousedown', handler);

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

    // Restore saved floating position
    try {
      const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (pos) { widgetEl.style.left = pos.l; widgetEl.style.right = pos.r; widgetEl.style.top = pos.t; widgetEl.style.bottom = pos.b; }
    } catch (_) {}

    renderWidget();
    loadData();
    tryInjectAll();

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
    // Detect removed dock targets and re-inject
    const missing = allDockEls.filter(function (d) { return !document.contains(d); });
    if (missing.length) {
      // If widget was inside a removed dock, rescue it first
      if (missing.includes(activeDockEl) && widgetEl) {
        document.body.appendChild(widgetEl);
        widgetEl.removeAttribute('data-cuw-docked');
        widgetEl.removeAttribute('data-cuw-dock-mode');
        activeDockEl = null;
        isDocked     = false;
        try { localStorage.removeItem(DOCK_KEY); } catch (_) {}
        applyEdgePosition(widgetEl, window.innerWidth - 80, window.innerHeight - 80);
        renderWidget();
      }
      allDockEls = allDockEls.filter(function (d) { return document.contains(d); });
      tryInjectAll();
    }

    // SPA navigation
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    setTimeout(function () {
      currentOrgId = getOrgId();
      if (!document.getElementById('claude-usage-widget')) {
        widgetEl = null;
        _widgetDragHandler = null;
        allDockEls = [];
        activeDockEl = null;
        isDocked = false;
        init();
      } else {
        loadData();
        tryInjectAll();
      }
    }, 800);
  }).observe(document.body, { childList: true, subtree: true });

})();
