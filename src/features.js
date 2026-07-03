/**
 * kiln-features — visitor-side runtime for Kiln's content features.
 *
 * Lazy-loaded by the boot shim ONLY when the page uses one of:
 *   [data-kiln-tags]      tag pills + filter buttons on repeat lists
 *   [data-kiln-gallery]   photo grid + lightbox with paging
 *   [data-kiln-events]    event list with month/week/day/list calendar views
 *   .kiln-doc             uploaded-document chips/cards (styling only)
 *
 * Zero dependencies. Every behavior is presentational — the HTML in the repo
 * remains the single source of truth, and all of this degrades gracefully
 * (no JS = the plain list/grid markup still reads fine).
 *
 * While a Kiln editing session is active, behaviors that would fight the
 * editor (lightbox capture, filter hiding, calendar re-rendering) stand down.
 */
(function () {
  'use strict';

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  function editingSession() {
    try {
      return (localStorage.getItem('kiln_admin') || localStorage.getItem('kiln_editor'))
        && sessionStorage.getItem('kiln_pause') !== '1';
    } catch { return false; }
  }

  function init() {
    injectCss();
    const editing = editingSession();
    if (!editing) {
      initFilters();
      initGalleries();
      initEvents();
    }
  }

  // ─── Tag filters ───────────────────────────────────────────────────────────
  // Any container whose direct children carry data-kiln-tags gets a pill bar:
  // "All" plus one pill per distinct tag. Clicking filters the children.

  function initFilters() {
    const parents = new Set();
    document.querySelectorAll('[data-kiln-tags]').forEach(el => { if (el.parentElement) parents.add(el.parentElement); });
    document.querySelectorAll('[data-kiln-filters]').forEach(el => parents.add(el));
    for (const container of parents) {
      const items = [...container.children].filter(c => c.hasAttribute('data-kiln-tags') || c.matches('[data-cms], article, li, div, tr, figure'));
      const tags = [];
      for (const it of items) {
        for (const t of splitTags(it.getAttribute('data-kiln-tags'))) if (!tags.includes(t)) tags.push(t);
      }
      if (!tags.length) continue;
      const bar = document.createElement('div');
      bar.className = 'kiln-filterbar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Filter list');
      const mk = (label, tag) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'kiln-pill';
        b.setAttribute('aria-pressed', 'false');
        b.textContent = label;
        b.onclick = () => {
          bar.querySelectorAll('.kiln-pill').forEach(p => { p.classList.remove('kiln-pill-on'); p.setAttribute('aria-pressed', 'false'); });
          b.classList.add('kiln-pill-on');
          b.setAttribute('aria-pressed', 'true');
          for (const it of items) {
            const mine = splitTags(it.getAttribute('data-kiln-tags'));
            it.style.display = (!tag || mine.includes(tag)) ? '' : 'none';
          }
        };
        return b;
      };
      const all = mk('All', null);
      all.classList.add('kiln-pill-on');
      all.setAttribute('aria-pressed', 'true');
      bar.appendChild(all);
      tags.forEach(t => bar.appendChild(mk(t, t)));
      // A table body can't host the bar — put it before the table itself.
      const anchor = container.closest('table') || container;
      anchor.parentElement.insertBefore(bar, anchor);
    }
  }

  function splitTags(v) {
    return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  // ─── Gallery lightbox ──────────────────────────────────────────────────────

  function initGalleries() {
    document.querySelectorAll('[data-kiln-gallery]').forEach(gal => {
      gal.classList.add('kiln-gallery-grid');
      // Per-gallery thumbnail size (set in the editor's Gallery options).
      const thumb = parseInt(gal.getAttribute('data-kiln-thumb'), 10);
      if (thumb) gal.style.setProperty('--kiln-thumb', thumb + 'px');
      const imgs = () => [...gal.querySelectorAll('img')];
      gal.addEventListener('click', (e) => {
        const img = e.target.closest('img');
        if (!img || !gal.contains(img)) return;
        e.preventDefault();
        openLightbox(imgs(), imgs().indexOf(img));
      });
    });
  }

  function openLightbox(imgs, index) {
    if (!imgs.length) return;
    let i = index < 0 ? 0 : index;
    const opener = document.activeElement;   // restore focus here on close
    const lb = document.createElement('div');
    lb.className = 'kiln-lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', 'Image viewer');
    lb.innerHTML = `
      <button class="kiln-lb-close" aria-label="Close">✕</button>
      <button class="kiln-lb-prev" aria-label="Previous image">‹</button>
      <figure class="kiln-lb-stage"><img alt=""><figcaption></figcaption></figure>
      <button class="kiln-lb-next" aria-label="Next image">›</button>
      <div class="kiln-lb-count"></div>`;
    document.body.appendChild(lb);
    document.documentElement.style.overflow = 'hidden';

    const stageImg = lb.querySelector('img');
    const cap = lb.querySelector('figcaption');
    const count = lb.querySelector('.kiln-lb-count');
    function show(n) {
      i = (n + imgs.length) % imgs.length;
      const src = imgs[i].closest('a')?.getAttribute('href');
      // Only trust an <a href> as the full-size source if it looks like an image.
      stageImg.src = (src && /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(src)) ? src : imgs[i].currentSrc || imgs[i].src;
      stageImg.alt = imgs[i].alt || '';
      const fc = imgs[i].closest('figure')?.querySelector('figcaption');
      cap.textContent = fc ? fc.textContent : (imgs[i].alt || '');
      count.textContent = `${i + 1} / ${imgs.length}`;
      lb.querySelector('.kiln-lb-prev').style.visibility = imgs.length > 1 ? '' : 'hidden';
      lb.querySelector('.kiln-lb-next').style.visibility = imgs.length > 1 ? '' : 'hidden';
    }
    function close() {
      lb.remove();
      document.documentElement.style.overflow = '';
      document.removeEventListener('keydown', onKey, true);
      if (opener && opener.focus) opener.focus();   // restore focus to the thumbnail
    }
    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowLeft') { show(i - 1); return; }
      if (e.key === 'ArrowRight') { show(i + 1); return; }
      if (e.key === 'Tab') {   // trap focus inside the viewer
        const f = [...lb.querySelectorAll('button')].filter(b => b.style.visibility !== 'hidden');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    lb.querySelector('.kiln-lb-close').onclick = close;
    lb.querySelector('.kiln-lb-prev').onclick = (e) => { e.stopPropagation(); show(i - 1); };
    lb.querySelector('.kiln-lb-next').onclick = (e) => { e.stopPropagation(); show(i + 1); };
    lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
    document.addEventListener('keydown', onKey, true);
    lb.querySelector('.kiln-lb-close').focus();   // initial focus inside the dialog
    // Swipe on touch screens.
    let touchX = null;
    lb.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', (e) => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 40) show(dx > 0 ? i - 1 : i + 1);
      touchX = null;
    }, { passive: true });
    show(i);
  }

  // ─── Events: list + calendar views ─────────────────────────────────────────
  // Container: [data-kiln-events]. Each direct child is one event carrying a
  // <time datetime="…"> (start; a second <time> is the end). The list view is
  // the container's own markup; month/week/day views are rendered FROM it.

  function initEvents() {
    document.querySelectorAll('[data-kiln-events]').forEach(setupEvents);
  }

  // Parse a datetime attribute in LOCAL time. A date-only value ("2026-07-03")
  // is treated as an all-day event at local midnight (not UTC — otherwise US
  // timezones land it on the previous day). Returns { date, allDay } or null.
  function parseDT(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s).trim());
    if (!m) { const d = new Date(s); return isNaN(d) ? null : { date: d, allDay: false }; }
    const [, y, mo, d, h, mi] = m;
    if (h === undefined) return { date: new Date(+y, +mo - 1, +d), allDay: true };
    return { date: new Date(+y, +mo - 1, +d, +h, +mi), allDay: false };
  }

  function parseEvents(container) {
    return [...container.children].map(el => {
      const times = el.querySelectorAll('time[datetime]');
      const p0 = times[0] ? parseDT(times[0].getAttribute('datetime')) : null;
      if (!p0) return null;
      const p1 = times[1] ? parseDT(times[1].getAttribute('datetime')) : null;
      const title = (el.querySelector('.kiln-ev-title, h1,h2,h3,h4')?.textContent || 'Event').trim();
      const loc = (el.querySelector('.kiln-ev-loc')?.textContent || '').trim();
      return { el, start: p0.date, end: p1 ? p1.date : null, allDay: p0.allDay, title, loc };
    }).filter(Boolean).sort((a, b) => a.start - b.start);
  }

  const FMT_MONTH = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  const FMT_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const FMT_TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  /** Every day-key an event spans (start→end, capped) so multi-day events show on each day. */
  function eventDayKeys(ev) {
    const startDay = new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate());
    let endDay = startDay;
    if (ev.end && ev.end > ev.start) {
      endDay = new Date(ev.end.getFullYear(), ev.end.getMonth(), ev.end.getDate());
      // An end at exactly midnight ends the previous day (exclusive boundary).
      if (ev.end.getHours() === 0 && ev.end.getMinutes() === 0 && endDay > startDay) {
        endDay.setDate(endDay.getDate() - 1);
      }
    }
    const keys = [];
    const d = new Date(startDay);
    for (let i = 0; i <= 366 && d <= endDay; i++) { keys.push(dayKey(d)); d.setDate(d.getDate() + 1); }
    return keys;
  }

  function setupEvents(container) {
    const bar = document.createElement('div');
    bar.className = 'kiln-evbar';
    bar.innerHTML = `
      <div class="kiln-evbar-views" role="tablist" aria-label="Calendar view">
        ${['list', 'month', 'week', 'day'].map(v =>
          `<button type="button" class="kiln-pill" role="tab" aria-selected="false" data-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
      </div>
      <div class="kiln-evbar-nav" hidden>
        <button type="button" class="kiln-pill" data-nav="-1" aria-label="Previous">‹</button>
        <span class="kiln-evbar-label"></span>
        <button type="button" class="kiln-pill" data-nav="1" aria-label="Next">›</button>
        <button type="button" class="kiln-pill" data-nav="0">Today</button>
      </div>`;
    container.parentElement.insertBefore(bar, container);
    const cal = document.createElement('div');
    cal.className = 'kiln-cal';
    cal.hidden = true;
    container.parentElement.insertBefore(cal, container.nextSibling);

    let view = 'list';
    try { view = sessionStorage.getItem('kiln_ev_view') || 'list'; } catch { /* private mode */ }
    if (!['list', 'month', 'week', 'day'].includes(view)) view = 'list';
    let cursor = new Date();

    const navEl = bar.querySelector('.kiln-evbar-nav');
    const labelEl = bar.querySelector('.kiln-evbar-label');

    function render() {
      bar.querySelectorAll('[data-view]').forEach(b => {
        const on = b.dataset.view === view;
        b.classList.toggle('kiln-pill-on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      try { sessionStorage.setItem('kiln_ev_view', view); } catch { /* ignore */ }
      const events = parseEvents(container);
      if (view === 'list') {
        container.hidden = false; cal.hidden = true; navEl.hidden = true;
        return;
      }
      container.hidden = true; cal.hidden = false; navEl.hidden = false;
      if (view === 'month') renderMonth(events);
      else if (view === 'week') renderWeek(events);
      else renderDay(events);
    }

    function eventChip(ev) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'kiln-ev-chip';
      // All-day events show no bogus "12:00 AM"; timed events show the time,
      // and a same-day end time renders as a range.
      const timeLabel = ev.allDay ? ''
        : (ev.end && dayKey(ev.end) === dayKey(ev.start) && ev.end > ev.start)
          ? `${FMT_TIME.format(ev.start)}–${FMT_TIME.format(ev.end)}`
          : FMT_TIME.format(ev.start);
      chip.innerHTML = timeLabel
        ? `<span class="kiln-ev-chip-t">${esc(timeLabel)}</span> ${esc(ev.title)}`
        : esc(ev.title);
      chip.onclick = () => showEventPop(ev);
      return chip;
    }

    function showEventPop(ev) {
      document.querySelector('.kiln-ev-pop')?.remove();
      const opener = document.activeElement;
      const pop = document.createElement('div');
      pop.className = 'kiln-ev-pop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-modal', 'true');
      const inner = document.createElement('div');
      inner.className = 'kiln-ev-pop-card';
      inner.appendChild(ev.el.cloneNode(true));
      const x = document.createElement('button');
      x.className = 'kiln-lb-close'; x.textContent = '✕'; x.setAttribute('aria-label', 'Close');
      const close = () => { pop.remove(); document.removeEventListener('keydown', onKey, true); if (opener && opener.focus) opener.focus(); };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      x.onclick = close;
      inner.prepend(x);
      pop.appendChild(inner);
      pop.addEventListener('click', (e) => { if (e.target === pop) close(); });
      document.body.appendChild(pop);
      document.addEventListener('keydown', onKey, true);
      x.focus();
    }

    function renderMonth(events) {
      const y = cursor.getFullYear(), m = cursor.getMonth();
      labelEl.textContent = FMT_MONTH.format(cursor);
      const first = new Date(y, m, 1);
      const startPad = first.getDay();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const byDay = {};
      for (const ev of events) {
        for (const k of eventDayKeys(ev)) (byDay[k] = byDay[k] || []).push(ev);
      }
      const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      let html = `<div class="kiln-cal-month">` + dows.map(d => `<div class="kiln-cal-dow">${d}</div>`).join('');
      for (let i = 0; i < startPad; i++) html += '<div class="kiln-cal-cell kiln-cal-pad"></div>';
      const today = dayKey(new Date());
      for (let d = 1; d <= daysInMonth; d++) {
        const k = `${y}-${m}-${d}`;
        html += `<div class="kiln-cal-cell${k === today ? ' kiln-cal-today' : ''}" data-day="${d}"><div class="kiln-cal-n">${d}</div></div>`;
      }
      html += '</div>';
      cal.innerHTML = html;
      for (let d = 1; d <= daysInMonth; d++) {
        const evs = byDay[`${y}-${m}-${d}`];
        if (!evs) continue;
        const cell = cal.querySelector(`[data-day="${d}"]`);
        evs.forEach(ev => cell.appendChild(eventChip(ev)));
      }
    }

    function renderWeek(events) {
      const start = new Date(cursor);
      start.setDate(start.getDate() - start.getDay());
      const end = new Date(start); end.setDate(end.getDate() + 6);
      const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
      labelEl.textContent = `${fmt.format(start)} – ${fmt.format(end)}`;
      cal.innerHTML = '<div class="kiln-cal-week"></div>';
      const wk = cal.firstChild;
      const today = dayKey(new Date());
      for (let i = 0; i < 7; i++) {
        const day = new Date(start); day.setDate(start.getDate() + i);
        const col = document.createElement('div');
        col.className = 'kiln-cal-wcol' + (dayKey(day) === today ? ' kiln-cal-today' : '');
        col.innerHTML = `<div class="kiln-cal-dow">${new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' }).format(day)}</div>`;
        events.filter(ev => eventDayKeys(ev).includes(dayKey(day))).forEach(ev => col.appendChild(eventChip(ev)));
        wk.appendChild(col);
      }
    }

    function renderDay(events) {
      labelEl.textContent = FMT_DAY.format(cursor);
      cal.innerHTML = '<div class="kiln-cal-day"></div>';
      const list = cal.firstChild;
      const todays = events.filter(ev => eventDayKeys(ev).includes(dayKey(cursor)));
      if (!todays.length) { list.innerHTML = '<p class="kiln-cal-empty">No events this day.</p>'; return; }
      todays.forEach(ev => {
        const item = document.createElement('div');
        item.className = 'kiln-cal-dayitem';
        item.appendChild(ev.el.cloneNode(true));
        list.appendChild(item);
      });
    }

    bar.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { view = b.dataset.view; render(); });
    bar.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => {
      const n = Number(b.dataset.nav);
      if (n === 0) cursor = new Date();
      // Anchor to day 1 before stepping months so the 29th–31st don't overflow
      // (e.g. Jan 31 → "Feb 31" → Mar 3), which silently skips February.
      else if (view === 'month') cursor = new Date(cursor.getFullYear(), cursor.getMonth() + n, 1);
      else if (view === 'week') cursor.setDate(cursor.getDate() + 7 * n);
      else cursor.setDate(cursor.getDate() + n);
      render();
    });
    render();
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ─── Shared CSS (neutral, easily overridden by the site's own styles) ──────

  function injectCss() {
    if (document.getElementById('kiln-features-css')) return;
    const st = document.createElement('style');
    st.id = 'kiln-features-css';
    st.textContent = `
.kiln-filterbar{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.kiln-pill{border:1.5px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:999px;
  padding:5px 14px;font:inherit;font-size:.85em;cursor:pointer;transition:all .15s;line-height:1.3}
.kiln-pill:hover{border-color:currentColor}
.kiln-pill.kiln-pill-on{background:rgba(127,127,127,.18);border-color:currentColor;font-weight:600}
.kiln-doc{text-decoration:none}
.kiln-doc-chip{display:inline-flex;align-items:center;gap:7px;border:1.5px solid rgba(127,127,127,.35);
  border-radius:9px;padding:6px 12px;font-size:.92em;line-height:1.3}
.kiln-doc-chip:hover{border-color:currentColor}
.kiln-doc-card{display:block;max-width:340px;border:1.5px solid rgba(127,127,127,.3);border-radius:12px;
  padding:14px 16px;margin:10px 0;line-height:1.45}
.kiln-doc-card:hover{border-color:currentColor}
.kiln-doc-card small{opacity:.65}
.kiln-gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--kiln-thumb,180px),1fr));gap:10px}
.kiln-gallery-grid figure{margin:0}
.kiln-gallery-grid img{width:100%;height:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;cursor:zoom-in;display:block}
.kiln-gallery-grid figcaption{font-size:.8em;opacity:.75;padding:4px 2px}
.kiln-lightbox{position:fixed;inset:0;z-index:2147483000;background:rgba(8,8,14,.93);display:flex;
  align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.kiln-lb-stage{margin:0;max-width:88vw;max-height:88vh;text-align:center}
.kiln-lb-stage img{max-width:88vw;max-height:82vh;object-fit:contain;border-radius:6px}
.kiln-lb-stage figcaption{color:#cfcfd8;font-size:13px;padding-top:10px}
.kiln-lightbox button{background:rgba(255,255,255,.08);border:none;color:#fff;cursor:pointer;border-radius:50%;
  width:44px;height:44px;font-size:22px;display:flex;align-items:center;justify-content:center;transition:background .15s}
.kiln-lightbox button:hover{background:rgba(255,255,255,.2)}
.kiln-lb-close{position:absolute;top:16px;right:16px;font-size:17px!important}
.kiln-lb-prev{position:absolute;left:14px;top:50%;transform:translateY(-50%)}
.kiln-lb-next{position:absolute;right:14px;top:50%;transform:translateY(-50%)}
.kiln-lb-count{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);color:#b9b9c4;font-size:12.5px}
@media (max-width:600px){.kiln-lb-prev{left:4px}.kiln-lb-next{right:4px}}
.kiln-evbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin:0 0 14px}
.kiln-evbar-views,.kiln-evbar-nav{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.kiln-evbar-label{font-weight:600;min-width:12ch;text-align:center}
.kiln-cal-month{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.kiln-cal-dow{font-size:.75em;text-transform:uppercase;letter-spacing:.05em;opacity:.6;padding:4px 6px}
.kiln-cal-cell{min-height:86px;border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:4px;overflow:hidden}
.kiln-cal-pad{border:none}
.kiln-cal-n{font-size:.8em;opacity:.65;padding:1px 3px}
.kiln-cal-today{outline:2px solid rgba(127,127,127,.55)}
.kiln-ev-chip{display:block;width:100%;text-align:left;border:none;background:rgba(127,127,127,.14);
  color:inherit;border-radius:6px;padding:3px 6px;font:inherit;font-size:.74em;line-height:1.35;cursor:pointer;
  margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kiln-ev-chip:hover{background:rgba(127,127,127,.28)}
.kiln-ev-chip-t{font-weight:600;opacity:.8}
.kiln-cal-week{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.kiln-cal-wcol{border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:6px;min-height:120px}
.kiln-cal-day .kiln-cal-dayitem{border:1px solid rgba(127,127,127,.22);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.kiln-cal-empty{opacity:.65}
.kiln-ev-pop{position:fixed;inset:0;z-index:2147483000;background:rgba(8,8,14,.5);display:flex;
  align-items:center;justify-content:center;padding:20px}
.kiln-ev-pop-card{position:relative;background:#fff;color:#1c1c28;border-radius:14px;padding:22px 26px;
  max-width:480px;width:100%;max-height:80vh;overflow:auto;box-shadow:0 24px 80px rgba(0,0,0,.3)}
.kiln-ev-pop-card .kiln-lb-close{position:absolute;top:10px;right:10px;background:rgba(0,0,0,.06);color:#333}
@media (max-width:640px){.kiln-cal-cell{min-height:56px}.kiln-cal-month{gap:2px}
  .kiln-cal-week{grid-template-columns:1fr 1fr}.kiln-evbar{justify-content:flex-start}}`;
    document.head.appendChild(st);
  }
})();
