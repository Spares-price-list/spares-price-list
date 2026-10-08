/* Sales price list: shows selling prices only.
   The price file is encrypted; this phone keeps the unlock key after the first password. */
(() => {
  'use strict';

  const KEY_STORE = 'price-list-key-v2';
  const BRAND_STORE = 'price-list-brand';
  const DATA_URL = 'data/prices.json';
  const META_URL = 'data/meta.json';
  const PAGE = 60;

  const $ = (id) => document.getElementById(id);
  const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let ENC = null;        // encrypted file
  let DATA = null;       // decrypted payload
  let PARTS = [];
  let filtered = [];
  let shown = 0;
  let lastCheck = 0;

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

  // ---------- start ----------
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
    DATA = null; PARTS = []; $('list').textContent = '';
    showLock('Locked. Enter the password to open again.');
  });

  // ---------- data ----------
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_./]/g, '');

  function openApp(data) {
    DATA = data;
    lastCheck = Date.now();
    PARTS = data.parts.map(([n, p, b, m, o], i) => ({
      n, p, b, m, o, i,
      bk: /^(|-|unidentified|not available|n\/a)$/i.test((b || '').trim()) ? 'OTHER' : b.trim().toUpperCase(),
      key: norm(p),
      hay: [n, p, b, m].join(' ').toLowerCase(),
      hayN: norm([n, p, m].join(' ')),
    }));
    $('updated').textContent = 'Prices updated ' + (data.updated_text || '');
    buildBrands();
    $('lock').hidden = true;
    $('app').hidden = false;
    applyFilter();
  }

  function buildBrands() {
    const sel = $('brand');
    const counts = new Map();
    const names = new Map();
    for (const x of PARTS) {
      counts.set(x.bk, (counts.get(x.bk) || 0) + 1);
      if (!names.has(x.bk)) names.set(x.bk, x.bk === 'OTHER' ? 'Other' : x.b.trim());
    }
    const keep = sel.value || load(BRAND_STORE) || '';
    sel.textContent = '';
    sel.append(new Option('All brands', ''));
    [...counts.keys()].sort((a, b) => (a === 'OTHER') - (b === 'OTHER') || a.localeCompare(b))
      .forEach((k) => sel.append(new Option(names.get(k) + ' (' + counts.get(k) + ')', k)));
    sel.value = counts.has(keep) ? keep : '';
  }

  function applyFilter() {
    const q = $('q').value.trim().toLowerCase();
    const brand = $('brand').value;
    $('clearQ').hidden = !q;
    let list = brand ? PARTS.filter((x) => x.bk === brand) : PARTS;
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
    filtered = list;
    shown = 0;
    $('list').textContent = '';
    renderMore();
    const total = PARTS.length.toLocaleString('en-IN');
    $('count').textContent = (q || brand)
      ? filtered.length.toLocaleString('en-IN') + ' of ' + total + ' parts'
      : total + ' parts';
    $('empty').hidden = filtered.length > 0;
  }

  // ---------- rendering ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

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
      if (entries.some((e) => e.isIntersecting) && DATA && shown < filtered.length) renderMore();
    }, { rootMargin: '600px' }).observe($('more'));
  } else {
    window.addEventListener('scroll', () => {
      if (DATA && shown < filtered.length && innerHeight + scrollY > document.body.offsetHeight - 800) renderMore();
    });
  }

  // ---------- controls ----------
  let timer = 0;
  $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(applyFilter, 120); });
  $('clearQ').addEventListener('click', () => { $('q').value = ''; applyFilter(); $('q').focus(); });
  $('brand').addEventListener('change', () => { store(BRAND_STORE, $('brand').value); applyFilter(); window.scrollTo(0, 0); });

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

  const net = () => { $('offline').hidden = navigator.onLine !== false; };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  start();
})();
