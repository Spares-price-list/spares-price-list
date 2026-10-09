/* Sales price list: shows selling prices only.
   The price file is encrypted; this phone keeps the unlock key after the first password.
   Screens: Home (brand cards with models)  ->  Parts list (brand / model / search). */
(() => {
  'use strict';

  const KEY_STORE = 'price-list-key-v2';
  const DATA_URL = 'data/prices.json';
  const META_URL = 'data/meta.json';
  const PAGE = 60;            // part cards added per scroll step
  const TOP_MODELS = 5;       // models shown on a brand card before "Show all"
  const SMALL_BRAND = 10;     // brands with fewer parts go into "More brands"
  const NO_MODEL = '~';

  const $ = (id) => document.getElementById(id);
  const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => n.toLocaleString('en-IN');

  let ENC = null;        // encrypted file
  let DATA = null;       // decrypted payload
  let PARTS = [];
  let BRANDS = [];       // [{key, name, parts, models:[{key,name,count}]}]
  let route = { b: '', m: '' };
  let filtered = [];
  let shown = 0;
  let lastCheck = 0;
  let homeScroll = 0;

  // ---------- storage (may be blocked: always wrapped) ----------
  const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  const load = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };

  // ---------- crypto ----------
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64e = (u8) => { let s = ''; u8.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };

  async function deriveRaw(password, enc) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64d(enc.salt), iterations: enc.iter }, base, 256);
    return new Uint8Array(bits);
  }

  async function decrypt(raw, enc) {
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(enc.iv) }, key, b64d(enc.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function fetchJSON(url) {
    const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  function savedKey() {
    try {
      const s = JSON.parse(load(KEY_STORE) || 'null');
      return s && s.k && s.s ? s : null;
    } catch (e) { return null; }
  }

  // ---------- start / lock ----------
  async function start() {
    if (!window.crypto || !crypto.subtle) {
      showLock('This browser cannot open the price list. Please use Chrome or Safari.');
      return;
    }
    try {
      ENC = await fetchJSON(DATA_URL);
    } catch (e) {
      showLock('Cannot load prices. Check the internet and open the link again.');
      return;
    }
    const s = savedKey();
    if (s) {
      if (s.s === ENC.salt) {
        try { openApp(await decrypt(b64d(s.k), ENC)); return; } catch (e) { /* password changed */ }
      }
      store(KEY_STORE, null);
      showLock('The password was changed. Please enter the new password.');
      return;
    }
    showLock('');
  }

  function showLock(msg) {
    $('app').hidden = true;
    $('lock').hidden = false;
    $('lockMsg').textContent = msg || '';
    $('pw').value = '';
    setTimeout(() => $('pw').focus(), 50);
  }

  $('lockForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pw = $('pw').value;
    if (!pw || !ENC) return;
    const btn = $('unlockBtn');
    btn.disabled = true; btn.textContent = 'Checking…';
    $('lockMsg').textContent = '';
    try {
      const raw = await deriveRaw(pw, ENC);
      const data = await decrypt(raw, ENC);
      store(KEY_STORE, JSON.stringify({ k: b64e(raw), s: ENC.salt }));
      openApp(data);
    } catch (e) {
      $('lockMsg').textContent = 'Wrong password. Please try again.';
      $('pw').select();
    } finally {
      btn.disabled = false; btn.textContent = 'Unlock';
    }
  });

  $('lockBtn').addEventListener('click', () => {
    store(KEY_STORE, null);
    DATA = null; PARTS = []; BRANDS = [];
    $('list').textContent = ''; $('bgrid').textContent = '';
    showLock('Locked. Enter the password to open again.');
  });

  // ---------- data ----------
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_./]/g, '');
  const brandKey = (b) => (/^(|-|unidentified|not available|n\/a)$/i.test((b || '').trim()) ? 'OTHER' : b.trim().toUpperCase());
  const modelKey = (m) => (m || '').trim().toUpperCase().replace(/\s+/g, ' ') || NO_MODEL;

  function openApp(data) {
    DATA = data;
    lastCheck = Date.now();
    PARTS = data.parts.map(([n, p, b, m, o], i) => ({
      n, p, b, m, o, i,
      bk: brandKey(b),
      mk: modelKey(m),
      key: norm(p),
      hay: [n, p, b, m].join(' ').toLowerCase(),
      hayN: norm([n, p, m].join(' ')),
    }));
    buildBrands();
    $('updated').textContent = 'Updated ' + (data.updated_text || '');
    $('lock').hidden = true;
    $('app').hidden = false;
    readRoute();
    render();
  }

  function buildBrands() {
    const map = new Map();
    for (const x of PARTS) {
      let br = map.get(x.bk);
      if (!br) {
        br = { key: x.bk, name: x.bk === 'OTHER' ? 'Other / no brand' : x.b.trim(), parts: 0, priced: 0, models: new Map() };
        map.set(x.bk, br);
      }
      br.parts++;
      if (x.o.some((o) => o[1] != null)) br.priced++;
      const md = br.models.get(x.mk) || { key: x.mk, name: x.mk === NO_MODEL ? '' : x.m.trim(), count: 0 };
      md.count++;
      br.models.set(x.mk, md);
    }
    BRANDS = [...map.values()].map((br) => ({
      ...br,
      models: [...br.models.values()].sort((a, b) =>
        (a.key === NO_MODEL) - (b.key === NO_MODEL) || b.count - a.count || a.name.localeCompare(b.name)),
    })).sort((a, b) => (a.key === 'OTHER') - (b.key === 'OTHER') || a.name.localeCompare(b.name));
    buildHome();
  }

  // ---------- routing (#/b/BRAND and #/b/BRAND/m/MODEL; phone back button works) ----------
  function readRoute() {
    const m = location.hash.match(/^#\/b\/([^/]+)(?:\/m\/(.+))?$/);
    route = m ? { b: decodeURIComponent(m[1]), m: m[2] ? decodeURIComponent(m[2]) : '' } : { b: '', m: '' };
    if (route.b && !BRANDS.some((br) => br.key === route.b)) route = { b: '', m: '' };
  }

  function go(b, m) {
    if (!route.b) homeScroll = window.scrollY;
    $('q').value = '';
    const hash = b ? '#/b/' + encodeURIComponent(b) + (m ? '/m/' + encodeURIComponent(m) : '') : '#/';
    if (location.hash === hash || (!b && !location.hash)) { readRoute(); render(); } else location.hash = hash;
  }

  window.addEventListener('hashchange', () => { if (DATA) { readRoute(); render(); } });

  // ---------- small DOM helpers ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function hue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function initials(name) {
    const w = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (!w.length) return '#';
    return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase();
  }

  const CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

  // ---------- home: brand cards ----------
  function row(label, count, b, m, cls) {
    const li = el('li', cls || null);
    const btn = el('button', 'mrow');
    btn.type = 'button';
    btn.dataset.b = b;
    if (m) btn.dataset.m = m;
    btn.append(el('span', 'mname', label), el('span', 'mnum', num(count)));
    li.append(btn);
    return li;
  }

  function coverage(priced, total) {
    const bar = el('div', 'cov');
    const pct = total ? Math.round((priced / total) * 100) : 0;
    bar.title = num(priced) + ' of ' + num(total) + ' parts have a price';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', bar.title);
    const fill = el('span');
    fill.style.width = pct + '%';
    bar.append(fill);
    return bar;
  }

  function brandCard(br) {
    const card = el('section', 'bcard');
    const head = el('button', 'bhead');
    head.type = 'button';
    head.dataset.b = br.key;
    const mono = el('span', 'mono', br.key === 'OTHER' ? '?' : initials(br.name));
    mono.style.setProperty('--h', hue(br.key));
    head.append(mono, el('span', 'bname', br.name), el('span', 'bnum', num(br.parts) + ' parts'));
    head.insertAdjacentHTML('beforeend', CHEVRON);
    card.append(head, coverage(br.priced, br.parts));

    const ul = el('ul', 'mlist');
    const named = br.models.filter((m) => m.key !== NO_MODEL);
    const rest = br.models.find((m) => m.key === NO_MODEL);
    if (!named.length) {
      ul.append(row('All parts', br.parts, br.key, ''));
    } else {
      named.forEach((m, i) => ul.append(row(m.name, m.count, br.key, m.key, i >= TOP_MODELS ? 'extra' : '')));
      if (rest) ul.append(row('Other parts (no model)', rest.count, br.key, NO_MODEL, 'rest'));
    }
    card.append(ul);

    if (named.length > TOP_MODELS) {
      const t = el('button', 'mtoggle', 'Show all ' + named.length + ' models');
      t.type = 'button';
      t.addEventListener('click', () => {
        const open = card.classList.toggle('open');
        t.textContent = open ? 'Show fewer' : 'Show all ' + named.length + ' models';
      });
      card.append(t);
    }
    return card;
  }

  function buildHome() {
    const grid = $('bgrid');
    grid.textContent = '';
    const big = BRANDS.filter((b) => b.parts >= SMALL_BRAND || b.key === 'OTHER');
    const small = BRANDS.filter((b) => b.parts < SMALL_BRAND && b.key !== 'OTHER');
    big.forEach((br) => grid.append(brandCard(br)));
    if (small.length) {
      const card = el('section', 'bcard');
      const head = el('div', 'bhead static');
      const mono = el('span', 'mono', '+');
      mono.style.setProperty('--h', 200);
      head.append(mono, el('span', 'bname', 'More brands'), el('span', 'bnum', small.length + ' brands'));
      card.append(head, coverage(small.reduce((a, b) => a + b.priced, 0), small.reduce((a, b) => a + b.parts, 0)));
      const ul = el('ul', 'mlist');
      small.forEach((br) => ul.append(row(br.name, br.parts, br.key, '')));
      card.append(ul);
      grid.append(card);
    }
  }

  $('bgrid').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-b]');
    if (btn) go(btn.dataset.b, btn.dataset.m || '');
  });

  // ---------- rendering the current screen ----------
  function brandOf(key) { return BRANDS.find((b) => b.key === key); }

  function crumbs(q) {
    const nav = $('crumbs');
    nav.textContent = '';
    const add = (label, b, m) => {
      const btn = el('button', 'crumb', label);
      btn.type = 'button';
      btn.addEventListener('click', () => go(b, m));
      nav.append(btn);
    };
    const sep = () => nav.append(el('span', 'sep', '›'));
    const back = el('button', 'crumb back');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back to all brands');
    back.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>';
    back.append(el('span', null, 'All brands'));
    back.addEventListener('click', () => go('', ''));
    nav.append(back);
    const br = route.b && brandOf(route.b);
    if (br) {
      sep();
      if (route.m || q) add(br.name, br.key, ''); else nav.append(el('span', 'here', br.name));
      if (route.m) {
        const md = br.models.find((x) => x.key === route.m);
        const label = route.m === NO_MODEL ? 'Other parts' : (md ? md.name : route.m);
        sep();
        if (q) add(label, br.key, route.m); else nav.append(el('span', 'here', label));
      }
    }
    if (q) { sep(); nav.append(el('span', 'here', 'Search')); }
  }

  function render() {
    const q = $('q').value.trim().toLowerCase();
    $('clearQ').hidden = !q;
    const atHome = !route.b && !q;

    $('home').hidden = !atHome;
    $('results').hidden = atHome;
    $('crumbs').hidden = atHome;

    if (atHome) {
      $('count').textContent = num(PARTS.length) + ' parts · ' + BRANDS.length + ' brands';
      requestAnimationFrame(() => window.scrollTo(0, homeScroll));
      return;
    }

    let list = PARTS;
    if (route.b) list = list.filter((x) => x.bk === route.b && (!route.m || x.mk === route.m));
    const scopeTotal = list.length;
    if (q) {
      const qn = norm(q);
      const toks = q.split(/\s+/).filter(Boolean);
      const scored = [];
      for (const x of list) {
        let s = -1;
        if (qn && x.key === qn) s = 0;
        else if (qn && x.key.startsWith(qn)) s = 1;
        else if (qn.length >= 2 && x.key.includes(qn)) s = 2;
        else if (toks.every((t) => x.hay.includes(t) || (norm(t) && x.hayN.includes(norm(t))))) s = 3;
        if (s >= 0) scored.push([s, x]);
      }
      scored.sort((a, b) => a[0] - b[0] || a[1].i - b[1].i);
      list = scored.map((z) => z[1]);
    }
    crumbs(q);
    filtered = list;
    shown = 0;
    $('list').textContent = '';
    renderMore();
    $('count').textContent = q
      ? num(filtered.length) + ' of ' + num(scopeTotal) + ' parts'
      : num(filtered.length) + ' parts';
    $('empty').hidden = filtered.length > 0;
  }

  // ---------- part cards ----------
  function priceEl(v) {
    return v == null ? el('span', 'price request', 'Price on request') : el('span', 'price', '₹' + money.format(v));
  }

  const WA_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.1 5.1 0 0 0 1.1 2.7 11.6 11.6 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c0-.1-.2-.2-.4-.3z"/></svg>';

  const tidy = (s) => String(s || '').replace(/[*_~]/g, '').trim();

  function message(x, o) {
    const lines = ['*Enquiry for: ' + tidy(x.n) + '*', 'Part No: ' + (x.p || '-')];
    const bm = [x.b && 'Brand: ' + x.b, x.m && 'Model: ' + x.m].filter(Boolean).join(' | ');
    if (bm) lines.push(bm);
    if (o[0]) lines.push('Option: ' + o[0]);
    lines.push('Price: ' + (o[1] == null ? 'On request' : '₹' + money.format(o[1])));
    if (DATA.updated_text) lines.push('_Price as of ' + DATA.updated_text + '_');
    return lines.join('\n');
  }

  function shareBtn(x, o) {
    const a = el('a', 'share');
    a.href = 'https://wa.me/?text=' + encodeURIComponent(message(x, o));
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = WA_ICON;
    a.append(el('span', null, 'Share'));
    a.setAttribute('aria-label', 'Share ' + x.n + (o[0] ? ', ' + o[0] : '') + ' on WhatsApp');
    return a;
  }

  function card(x) {
    const c = el('article', 'card');
    const head = el('div', 'card-head');
    const info = el('div', 'info');
    info.append(el('h2', 'name', x.n));
    const meta = el('div', 'meta');
    if (x.p) meta.append(el('span', 'pn', x.p));
    if (x.b) meta.append(el('span', 'brand', x.b));
    if (x.m) meta.append(el('span', 'chip', x.m));
    info.append(meta);
    head.append(info);
    c.append(head);

    const single = x.o.length === 1 && !x.o[0][0];
    if (single) {
      const side = el('div', 'side');
      side.append(priceEl(x.o[0][1]), shareBtn(x, x.o[0]));
      head.append(side);
    } else {
      const opts = el('div', 'opts');
      for (const o of x.o) {
        const r = el('div', 'opt');
        r.append(el('span', 'opt-label', o[0] || 'Price'), priceEl(o[1]), shareBtn(x, o));
        opts.append(r);
      }
      c.append(opts);
    }
    return c;
  }

  function renderMore() {
    const frag = document.createDocumentFragment();
    const end = Math.min(filtered.length, shown + PAGE);
    for (let i = shown; i < end; i++) frag.append(card(filtered[i]));
    shown = end;
    $('list').append(frag);
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && DATA && !$('results').hidden && shown < filtered.length) renderMore();
    }, { rootMargin: '600px' }).observe($('more'));
  } else {
    window.addEventListener('scroll', () => {
      if (DATA && shown < filtered.length && innerHeight + scrollY > document.body.offsetHeight - 800) renderMore();
    });
  }

  // ---------- search ----------
  let timer = 0;
  $('q').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!route.b && $('q').value.trim() && !$('home').hidden) homeScroll = window.scrollY;
      render();
      if (!$('results').hidden) window.scrollTo(0, 0);
    }, 120);
  });
  $('clearQ').addEventListener('click', () => { $('q').value = ''; render(); $('q').focus(); });

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- keep prices fresh while the page stays open ----------
  async function checkForUpdate() {
    if (!DATA || Date.now() - lastCheck < 5 * 60 * 1000) return;
    lastCheck = Date.now();
    let enc;
    try {
      const meta = await fetchJSON(META_URL);
      if (!meta || meta.updated === DATA.updated) return;
      enc = await fetchJSON(DATA_URL);
    } catch (e) { return; /* offline: try again later */ }
    const s = savedKey();
    let data = null;
    if (s && s.s === enc.salt) {
      try { data = await decrypt(b64d(s.k), enc); } catch (e) { data = null; }
    }
    ENC = enc;
    if (!data) {
      store(KEY_STORE, null);
      DATA = null;
      showLock('The password was changed. Please enter the new password.');
      return;
    }
    const y = window.scrollY;
    openApp(data);
    window.scrollTo(0, y);
    toast('Prices updated');
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  setInterval(checkForUpdate, 10 * 60 * 1000);

  const net = () => {
    const off = navigator.onLine === false;
    $('offline').hidden = !off;
    document.body.classList.toggle('is-offline', off);
  };

  // "/" jumps to search (computer keyboards), Esc clears it
  document.addEventListener('keydown', (ev) => {
    if ($('app').hidden) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (ev.key === '/' && !inField) { ev.preventDefault(); $('q').focus(); }
    else if (ev.key === 'Escape' && document.activeElement === $('q')) {
      if ($('q').value) { $('q').value = ''; render(); } else $('q').blur();
    }
  });
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  start();
})();
