(function () {
  'use strict';

  const REFRESH_INTERVAL = 60 * 1000;
  const MODES = ['full', 'mini', 'dot'];
  const STORAGE_KEY = 'cuw_mode';

  let widgetEl = null;
  let refreshTimer = null;
  let currentOrgId = null;
  let lastData = null;
  let currentMode = 'full';

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
    widgetEl.setAttribute('data-cuw-theme', detectTheme());
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
    setTimeout(() => {
      const r = widgetEl.getBoundingClientRect();
      applyEdgePosition(widgetEl, r.left, r.top);
    }, 0);
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
      const R = 17;
      const C = 2 * Math.PI * R;
      const off = C - (pct / 100) * C;
      widgetEl.innerHTML = `
        <button class="cuw-dot-btn" title="Развернуть (${pct}%, осталось ${timeLeft})">
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
            <circle cx="22" cy="22" r="${R}" class="cuw-ring-bg"/>
            <circle cx="22" cy="22" r="${R}" class="cuw-ring-fill cuw-ring-${sev}"
              stroke-dasharray="${C.toFixed(2)}"
              stroke-dashoffset="${off.toFixed(2)}"
              transform="rotate(-90 22 22)"/>
            <text x="22" y="26" class="cuw-ring-text">${pct}%</text>
          </svg>
        </button>`;
      widgetEl.querySelector('.cuw-dot-btn').addEventListener('click', () => setMode('full'));
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
            <div class="cuw-fill cuw-fill-${sev}" style="width:${Math.min(pct,100)}%"></div>
          </div>
        </div>`;
      widgetEl.querySelector('.cuw-refresh-mini').addEventListener('click', () => loadData(true));
      widgetEl.querySelectorAll('[data-mode]').forEach(btn =>
        btn.addEventListener('click', () => setMode(btn.dataset.mode))
      );
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
                 <div class="cuw-fill cuw-fill-${sev}" style="width:${Math.min(pct,100)}%"></div>
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
    widgetEl.querySelector('.cuw-refresh')?.addEventListener('click', () => loadData(true));
    widgetEl.querySelectorAll('[data-mode]').forEach(btn =>
      btn.addEventListener('click', () => setMode(btn.dataset.mode))
    );
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
      scheduleRefresh(); // retry even on error
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadData(), REFRESH_INTERVAL);
  }

  /* ── visibility: reload immediately when tab becomes active again ── */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clearTimeout(refreshTimer);
      loadData();
    }
  });

  /* ── drag (edge-anchored) ── */

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
    const handle = handleSelector ? el.querySelector(handleSelector) : el;
    if (!handle) return;

    handle.style.cursor = 'grab';

    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      handle.style.cursor = 'grabbing';

      const sx = e.clientX, sy = e.clientY;
      const { left: ox, top: oy } = el.getBoundingClientRect();

      const move = (ev) =>
        applyEdgePosition(el, ox + ev.clientX - sx, oy + ev.clientY - sy);

      const up = () => {
        handle.style.cursor = 'grab';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    if (!resizeListenerAdded) {
      resizeListenerAdded = true;
      window.addEventListener('resize', () => {
        if (!widgetEl) return;
        const r = widgetEl.getBoundingClientRect();
        applyEdgePosition(widgetEl, r.left, r.top);
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

    renderWidget();
    loadData();

    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true, attributeFilter: ['class', 'data-color-scheme', 'data-theme']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    setTimeout(() => {
      currentOrgId = getOrgId();
      if (!document.getElementById('claude-usage-widget')) {
        widgetEl = null;
        init();
      }
      loadData();
    }, 800);
  }).observe(document.body, { childList: true, subtree: true });
})();
