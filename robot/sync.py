#!/usr/bin/env python3
"""
Price Robot
===========
Reads EVERY tab of the private Google Sheet and keeps ONLY:
    part description, part number, brand, model and selling price (INR).
Everything is published as one password-encrypted file for the sales site.

Cost prices, USD/RMB, exchange rates, A-H category codes, quantities,
quoted prices and dates never leave this script. The log never shows
prices, codes or keys (the log of a public repository is public).

How it finds the data (no fixed layout needed):
  * Header row = the first row (within the top 6) that has a Selling Price
    column plus a Part Number or Part Description column.
  * Columns are matched by NAME, so tabs may differ in column order and count.
  * "Q1 Selling Price", "Quality 2 Selling Price" ... become quality options.
  * Tabs named "<something> Supplier A", "<something> Supplier B" ... are
    merged: one card per part, with every supplier/quality price as an option.
  * Same part number in two tabs: the priced row wins, then the normal tab
    wins over a low-priority tab (config.json "low_priority_tabs").
  * Tabs are left off the site when: the name starts with "_", the tab is
    hidden, or the name matches config.json "skip_tabs".

Run by GitHub Actions (.github/workflows/price-robot.yml).
Local test with an exported .xlsx:
    python robot/sync.py --xlsx Master.xlsx --out _site --password "test-password-123" --salt test
"""

import argparse
import base64
import datetime as dt
import fnmatch
import hashlib
import hmac
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.request

FORMAT_VERSION = 2
PBKDF2_ITERATIONS = 250_000
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

class RobotError(Exception):
    """An error with a plain-English message for the Actions log."""


def fail(msg):
    raise RobotError(msg)


def clean(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).replace("\u00a0", " ").strip()
    s = re.sub(r"\s+", " ", s)
    return "" if s.lower() in ("none", "nan") else s


def norm_header(v):
    s = clean(v).lower()
    s = s.replace("\u2013", "-").replace("\u2014", "-")
    return s


def to_number(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        x = float(v)
    else:
        s = clean(v).replace(",", "").replace("\u20b9", "")
        s = re.sub(r"(?i)^(inr|rs\.?)\s*", "", s).strip()
        try:
            x = float(s)
        except ValueError:
            return None
    if not math.isfinite(x) or x <= 0:
        return None
    return x


def to_price(v):
    x = to_number(v)
    return None if x is None else round(x, 2)


def norm_pn(pn):
    """Part number key: ignore case, spaces, dashes, dots, slashes."""
    return re.sub(r"[\s\-_.\/]", "", clean(pn)).upper()


def brand_tokens(b):
    words = set(w for w in re.findall(r"[a-z]+", clean(b).lower()) if len(w) >= 3)
    return words - {"unidentified", "not", "available", "brand", "other", "unknown"}


def brands_compatible(a, b):
    ta, tb = brand_tokens(a), brand_tokens(b)
    return not ta or not tb or bool(ta & tb)


DATE_FORMATS = ("%Y-%m-%d", "%d-%b-%Y", "%d/%m/%Y", "%d-%m-%Y", "%d %b %Y",
                "%d.%m.%Y", "%Y/%m/%d", "%d-%B-%Y", "%m/%d/%Y")


def to_date_ordinal(v):
    if isinstance(v, (dt.date, dt.datetime)):
        return v.toordinal()
    s = clean(v).split(" ")[0] if clean(v) else ""
    for f in DATE_FORMATS:
        try:
            return dt.datetime.strptime(s, f).toordinal()
        except ValueError:
            pass
    return 0


def matches_any(name, patterns):
    n = name.strip().lower()
    return any(fnmatch.fnmatch(n, p.strip().lower()) for p in patterns)


def cell(row, i):
    if i is None or row is None or i >= len(row):
        return None
    return row[i]


def short_rows(rows, limit=15):
    rows = sorted(set(rows))
    txt = ", ".join(str(r) for r in rows[:limit])
    return txt + (f" and {len(rows) - limit} more" if len(rows) > limit else "")


class Tab:
    def __init__(self, name, index, hidden, fmt_rows, raw_rows):
        self.name = name
        self.index = index
        self.hidden = hidden
        self.fmt = fmt_rows    # what the sheet shows (text)
        self.raw = raw_rows    # unformatted values (numbers stay numbers)


# --------------------------------------------------------------------------
# Reading the sheet
# --------------------------------------------------------------------------

def read_google(sheet_id, sa_key_text):
    try:
        info = json.loads(sa_key_text)
        robot_email = info["client_email"]
    except Exception:
        fail("GOOGLE_SA_KEY is not the full key file. Open the .json key in Notepad, "
             "press Ctrl+A then Ctrl+C, and paste it again into the GOOGLE_SA_KEY secret.")

    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    from google.auth.exceptions import RefreshError

    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    session = AuthorizedSession(creds)
    base = f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}"

    def get(url, params):
        try:
            r = session.get(url, params=params, timeout=90)
        except RefreshError:
            fail("Google refused the robot key (GOOGLE_SA_KEY). The key may be deleted or "
                 "pasted wrongly. Create a new JSON key for the robot and paste it again.")
        if r.status_code == 200:
            return r.json()
        body = r.text[:2000]
        if r.status_code == 403 and ("SERVICE_DISABLED" in body or "has not been used" in body):
            fail("Google Sheets API is switched off in the Google Cloud project. "
                 "Open console.cloud.google.com, search 'Google Sheets API' and click Enable.")
        if r.status_code == 403:
            fail(f"The robot cannot open the sheet. In the Google Sheet click Share, add "
                 f"{robot_email} as Viewer (untick Notify people) and run again.")
        if r.status_code == 404:
            fail("SHEET_ID is wrong. Copy the part of the sheet link between /d/ and /edit "
                 "and paste it into the SHEET_ID secret.")
        fail(f"Google Sheets answered with error {r.status_code}. Run the workflow again; "
             f"if it stays red, check the secrets.")

    meta = get(base, {"fields": "sheets.properties(title,index,hidden,sheetType)"})
    props = [s["properties"] for s in meta.get("sheets", [])
             if s["properties"].get("sheetType", "GRID") == "GRID"]
    if not props:
        fail("The Google Sheet has no tabs the robot can read.")

    def quote(title):
        return "'" + title.replace("'", "''") + "'"

    fmt_values, raw_values = {}, {}
    for start in range(0, len(props), 40):
        chunk = props[start:start + 40]
        ranges = [quote(p["title"]) for p in chunk]
        for render, store in (("FORMATTED_VALUE", fmt_values), ("UNFORMATTED_VALUE", raw_values)):
            data = get(base + "/values:batchGet", {
                "ranges": ranges,
                "valueRenderOption": render,
                "dateTimeRenderOption": "FORMATTED_STRING",
                "majorDimension": "ROWS",
            })
            for p, vr in zip(chunk, data.get("valueRanges", [])):
                store[p["title"]] = vr.get("values", [])

    tabs = []
    for p in sorted(props, key=lambda x: x.get("index", 0)):
        t = p["title"]
        tabs.append(Tab(t, p.get("index", 0), bool(p.get("hidden")),
                        fmt_values.get(t, []), raw_values.get(t, [])))
    return tabs


def read_xlsx(path):
    """Local test mode: read an .xlsx exported from Google Sheets (cached values)."""
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)

    def as_text(v):
        if v is None:
            return ""
        if isinstance(v, dt.datetime):
            return v.strftime("%Y-%m-%d")
        if isinstance(v, float) and v.is_integer():
            return str(int(v))
        return str(v)

    tabs = []
    for i, ws in enumerate(wb.worksheets):
        raw = [list(r) for r in ws.iter_rows(values_only=True)]
        while raw and all(v in (None, "") for v in raw[-1]):
            raw.pop()
        fmt = [[as_text(v) for v in r] for r in raw]
        tabs.append(Tab(ws.title, i, ws.sheet_state != "visible", fmt, raw))
    return tabs


# --------------------------------------------------------------------------
# Understanding a tab
# --------------------------------------------------------------------------

PN_NAMES = {"part number", "part no", "part no.", "part #", "part num", "p/n", "pn",
            "part number.", "part nos", "part no:"}
DESC_NAMES = {"part description", "part name", "description", "item description",
              "item name", "part details", "particulars", "item"}
BRAND_NAMES = {"brand", "make", "brand name"}
MODEL_NAMES = {"m-model", "m model", "model", "machine model", "model no", "model no.",
               "m-model no", "machine"}
DATE_NAMES = {"price date", "quotation date", "quote date", "date", "price as of"}


def classify(header):
    """Return (field, quality_number) for one header, or (None, None)."""
    h = norm_header(header)
    if not h:
        return None, None
    m = re.match(r"^(?:q|quality)\s*(\d+)\b[\s:\-]*(.*)$", h)
    qn = int(m.group(1)) if m else 0
    rest = m.group(2).strip() if m else h

    if "selling price" in rest or rest.startswith("selling"):
        return "sell", qn
    if re.search(r"\bcode\b", rest) and ("category" in rest or rest.startswith("code")):
        return "code", qn
    if rest == "currency":
        return "currency", 0
    if rest in ("rmb", "usd", "inr", "rmb price", "usd price"):
        return "cost:" + rest[:3].upper(), qn
    if rest in DATE_NAMES or rest.endswith(" date"):
        return "date", 0
    pm = re.match(r"^(?:(?:unit|current|purchase|foreign|cost|supplier)\s+)*price\s*(?:\((\w+)\))?$", rest)
    if pm:
        cur = (pm.group(1) or "").upper()
        return ("cost:" + cur) if cur else "cost", qn
    if m:  # other Q-columns are not part info
        return None, None
    if h in PN_NAMES:
        return "pn", 0
    if h in DESC_NAMES:
        return "desc", 0
    if h in BRAND_NAMES:
        return "brand", 0
    if h in MODEL_NAMES:
        return "model", 0
    return None, None


def find_layout(tab):
    """Find the header row and the column of every field we understand."""
    for hi in range(min(6, len(tab.fmt))):
        lay = {"header_row": hi, "sell": {}, "code": {}, "cost": {}}
        for ci, h in enumerate(tab.fmt[hi]):
            field, qn = classify(h)
            if field is None:
                continue
            if field in ("sell", "code"):
                lay[field].setdefault(qn, ci)
            elif field.startswith("cost"):
                cur = field.split(":")[1] if ":" in field else None
                lay["cost"].setdefault(qn, []).append((ci, cur))
            else:
                lay.setdefault(field, ci)
        if lay["sell"] and ("pn" in lay or "desc" in lay):
            return lay
    return None


def find_rules(tabs):
    """Exchange rates and A-H divisors, used only for the self-check."""
    for t in tabs:
        for hi in range(min(6, len(t.fmt))):
            hdr = [norm_header(x) for x in t.fmt[hi]]
            if "divisor" in hdr and "category" in hdr and "currency" in hdr:
                ci, ki, di = hdr.index("currency"), hdr.index("category"), hdr.index("divisor")
                ri = next((i for i, h in enumerate(hdr) if "inr" in h or "rate" in h), None)
                rates, divisors = {"INR": 1.0}, {}
                for row in t.raw[hi + 1:]:
                    cur = clean(cell(row, ci)).upper()
                    rate = to_number(cell(row, ri))
                    if re.fullmatch(r"[A-Z]{3}", cur) and rate:
                        rates[cur] = rate
                    k = clean(cell(row, ki)).upper()
                    d = to_number(cell(row, di))
                    if re.fullmatch(r"[A-H]", k) and d:
                        divisors[k] = d
                if len(divisors) >= 2:
                    return rates, divisors
    return None, None


SUPPLIER_RE = re.compile(r"^(.*?)[\s_\-]*supplier[\s_\-]*([A-Za-z0-9]+)\s*$", re.I)


# --------------------------------------------------------------------------
# Building the price list
# --------------------------------------------------------------------------

def option_label(cfg, supplier, qn):
    labels = cfg.get("option_labels", {})
    if supplier:
        raw = f"Supplier {supplier}" + (f" Quality {qn}" if qn else "")
        fallback = f"Quality {qn}" if qn else f"Option {supplier}"
    else:
        if not qn:
            return ""
        raw = f"Quality {qn}"
        fallback = raw
    return labels.get(raw, fallback)


def build(tabs, cfg, explain=None):
    rates, divisors = find_rules(tabs)
    report, warnings, items = [], [], []

    for t in tabs:
        rep = {"tab": t.name, "status": "", "rows": 0, "site": 0, "on_request": 0, "dropped": 0}
        report.append(rep)
        if t.name.startswith("_"):
            rep["status"] = "left off (name starts with _)"
            continue
        if t.hidden and cfg.get("skip_hidden_tabs", True):
            rep["status"] = "left off (tab is hidden)"
            continue
        if matches_any(t.name, cfg.get("skip_tabs", [])):
            rep["status"] = "left off (skip_tabs in config.json)"
            continue
        lay = find_layout(t)
        if not lay:
            rep["status"] = "left off (no Part Number/Description + Selling Price headers)"
            continue

        sm = SUPPLIER_RE.match(t.name)
        group = sm.group(1).strip() if sm and sm.group(1).strip() else None
        supplier = sm.group(2).upper() if group else None
        low = matches_any(t.name, cfg.get("low_priority_tabs", []))

        bad_code, mismatch, missing = [], [], []
        hi = lay["header_row"]
        for r in range(hi + 1, max(len(t.fmt), len(t.raw))):
            frow = t.fmt[r] if r < len(t.fmt) else []
            rrow = t.raw[r] if r < len(t.raw) else []
            pn = clean(cell(frow, lay.get("pn")))
            desc = clean(cell(frow, lay.get("desc")))
            if not pn and not desc:
                continue
            sheet_row = r + 1
            rep["rows"] += 1
            opts = []
            for qn in sorted(lay["sell"]):
                price = to_price(cell(rrow, lay["sell"][qn]))
                opts.append({"q": qn, "label": option_label(cfg, supplier, qn), "price": price,
                             "order": (supplier or "", qn)})

                # ---- self-check against price x rate / divisor (never logged with values)
                code_col = lay["code"].get(qn)
                if code_col is None:
                    continue
                code = clean(cell(frow, code_col)).upper()
                if code and not re.fullmatch(r"[A-H]", code):
                    bad_code.append(sheet_row)
                    continue
                if not code or not divisors or code not in divisors:
                    continue
                total, known, any_cost = 0.0, True, False
                for ci, fixed in lay["cost"].get(qn, []):
                    v = to_number(cell(rrow, ci))
                    if v is None:
                        continue
                    cur = fixed or clean(cell(frow, lay.get("currency"))).upper()
                    if cur not in rates:
                        known = False
                        continue
                    total += v * rates[cur]
                    any_cost = True
                if not any_cost or not known:
                    continue
                expected = total / divisors[code]
                if price is None:
                    missing.append(sheet_row)
                elif abs(price - expected) > max(1.0, expected * 0.006):
                    mismatch.append(sheet_row)

            items.append({
                "tab": t.name, "tab_index": t.index, "row": sheet_row,
                "pn": pn, "desc": desc,
                "brand": clean(cell(frow, lay.get("brand"))),
                "model": clean(cell(frow, lay.get("model"))),
                "date": to_date_ordinal(cell(frow, lay.get("date"))) if "date" in lay else 0,
                "prio": 2 if low else 1,
                "source": ("group:" + group.lower()) if group else ("tab:" + t.name),
                "opts": opts, "rep": rep,
            })

        if bad_code:
            warnings.append(f"{t.name}: category code is not one letter A-H in row(s) "
                            f"{short_rows(bad_code)} - those parts show 'Price on request'.")
        if missing:
            warnings.append(f"{t.name}: price and code are filled but Selling Price is empty in "
                            f"row(s) {short_rows(missing)} - copy the formula down.")
        if mismatch:
            warnings.append(f"{t.name}: Selling Price does not match price x rate / divisor in "
                            f"row(s) {short_rows(mismatch)} - a price may have been typed over "
                            f"the formula.")
        if rep["rows"] == 0:
            rep["status"] = "empty - shows on the site when filled"
        else:
            rep["status"] = "on site" + (" (low priority)" if low else "") + \
                            (f" (options: {group} Supplier {supplier})" if group else "")

    # ---- 1. merge Supplier A / Supplier B ... tabs into one card per part
    cards, by_key = [], {}
    for it in items:
        if it["source"].startswith("group:"):
            key = (it["source"], norm_pn(it["pn"]) or "D:" + it["desc"].lower())
            if key in by_key:
                card = by_key[key]
                have = {o["label"] for o in card["opts"]}
                card["opts"] += [o for o in it["opts"] if o["label"] not in have]
                card["members"].append(it)
                if not card["brand"]:
                    card["brand"] = it["brand"]
                if not card["model"]:
                    card["model"] = it["model"]
                continue
            card = dict(it, opts=list(it["opts"]), members=[it])
            by_key[key] = card
        else:
            card = dict(it, members=[it])
        cards.append(card)
    for c in cards:
        c["opts"].sort(key=lambda o: o["order"])
        priced = [o for o in c["opts"] if o["price"] is not None]
        c["opts"] = priced if priced else [{"label": "", "price": None}]
        c["has_price"] = bool(priced)

    # ---- 2. same part number in more than one place
    keep = [True] * len(cards)
    groups = {}
    for i, c in enumerate(cards):
        k = norm_pn(c["pn"])
        if len(k) >= 2:
            groups.setdefault(k, []).append(i)
    same_tab_conflicts = {}
    for k, idxs in groups.items():
        if len(idxs) < 2:
            continue
        idxs.sort(key=lambda i: (not cards[i]["has_price"], cards[i]["prio"], -cards[i]["date"],
                                 cards[i]["tab_index"], cards[i]["row"]))
        win = cards[idxs[0]]
        for i in idxs[1:]:
            c = cards[i]
            if not brands_compatible(win["brand"], c["brand"]):
                continue
            if c["source"] != win["source"]:
                keep[i] = False                       # other tab: the winner stays
                if explain is not None:
                    explain.append(("other tab", c["tab"], c["row"], win["tab"], win["row"]))
            else:
                same_prices = [o["price"] for o in c["opts"]] == [o["price"] for o in win["opts"]]
                if same_prices:
                    keep[i] = False                   # exact repeat in the same tab
                    if explain is not None:
                        explain.append(("same tab, same price", c["tab"], c["row"], win["tab"], win["row"]))
                else:
                    same_tab_conflicts.setdefault(c["tab"], set()).update({win["row"], c["row"]})
    for i, c in enumerate(cards):
        if not keep[i]:
            for m in c["members"]:
                m["rep"]["dropped"] += 1
    for tab, rows in same_tab_conflicts.items():
        warnings.append(f"{tab}: the same part number has DIFFERENT prices in row(s) "
                        f"{short_rows(rows)} - both are on the site; please check.")

    parts = []
    for i, c in enumerate(cards):
        if not keep[i]:
            continue
        for m in c["members"]:
            m["rep"]["site"] += 1
            if not c["has_price"]:
                m["rep"]["on_request"] += 1
        parts.append([
            c["desc"] or c["pn"], c["pn"], c["brand"], c["model"],
            [[o["label"], o["price"]] for o in c["opts"]],
        ])
    return parts, report, warnings, bool(divisors)


# --------------------------------------------------------------------------
# Encrypting and writing the site
# --------------------------------------------------------------------------

def derive_key(password, site_salt):
    salt = hashlib.sha256(("price-list-sync:" + site_salt).encode("utf-8")).digest()[:16]
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS, 32)
    return salt, key


def encrypt(payload, password, site_salt):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, key = derive_key(password, site_salt)
    iv = os.urandom(12)
    plain = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(key).encrypt(iv, plain, None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return {"v": FORMAT_VERSION, "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITERATIONS,
            "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def fetch_previous_meta(site_url):
    if not site_url:
        return None
    url = site_url.rstrip("/") + "/data/meta.json?t=" + str(int(time.time()))
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-cache"}),
                                    timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def write_github(name, value):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{name}={value}\n")


def write_summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description="Price Robot")
    ap.add_argument("--xlsx", help="local test: read this exported .xlsx instead of Google Sheets")
    ap.add_argument("--out", default=os.path.join(REPO, "_site"))
    ap.add_argument("--password", default=os.environ.get("SITE_PASSWORD", ""))
    ap.add_argument("--salt", default=os.environ.get("SITE_SALT", ""))
    ap.add_argument("--site-url", default=os.environ.get("SITE_URL", ""))
    ap.add_argument("--force", action="store_true",
                    default=os.environ.get("FORCE_DEPLOY", "").lower() == "true")
    ap.add_argument("--allow-big-drop", action="store_true",
                    default=os.environ.get("ALLOW_BIG_DROP", "").lower() == "true")
    args = ap.parse_args()

    with open(os.path.join(HERE, "config.json"), encoding="utf-8") as f:
        cfg = json.load(f)

    password, site_salt = args.password, args.salt
    if len(password) < 12:
        fail("SITE_PASSWORD is missing or shorter than 12 characters. Set it in "
             "Settings > Secrets and variables > Actions.")
    if not site_salt:
        fail("SITE_SALT is missing. Add any random text as the SITE_SALT secret.")

    if args.xlsx:
        tabs = read_xlsx(args.xlsx)
        print(f"Reading local file: {os.path.basename(args.xlsx)}")
    else:
        sheet_id = os.environ.get("SHEET_ID", "").strip()
        sa_key = os.environ.get("GOOGLE_SA_KEY", "").strip()
        if not sheet_id:
            fail("SHEET_ID secret is empty. Copy the part of the sheet link between /d/ and /edit.")
        if not sa_key:
            fail("GOOGLE_SA_KEY secret is empty. Paste the whole robot .json key file into it.")
        tabs = read_google(sheet_id, sa_key)
        print(f"Read {len(tabs)} tabs from the Google Sheet.")

    parts, report, warnings, checked = build(tabs, cfg)

    # ---- log (counts only, never prices or codes)
    print("\nTab report")
    print("-" * 78)
    lines = ["## Price Robot report", "",
             "| Tab | Rows read | On site | Price on request | Left off (duplicate) | Status |",
             "|---|---:|---:|---:|---:|---|"]
    for rep in report:
        print(f"{rep['tab'][:28]:<28} rows {rep['rows']:>4}  on site {rep['site']:>4}  "
              f"on request {rep['on_request']:>4}  duplicate {rep['dropped']:>3}  {rep['status']}")
        lines.append(f"| {rep['tab']} | {rep['rows']} | {rep['site']} | {rep['on_request']} | "
                     f"{rep['dropped']} | {rep['status']} |")
    priced = sum(1 for p in parts if any(o[1] is not None for o in p[4]))
    print("-" * 78)
    print(f"Parts on the site: {len(parts)} ({priced} with a price, "
          f"{len(parts) - priced} 'Price on request')")
    lines += ["", f"**Parts on the site: {len(parts)}** ({priced} with a price, "
                  f"{len(parts) - priced} price on request)"]
    if not checked:
        print("Note: no Pricing Rules tab found, so the formula self-check was skipped.")
    if warnings:
        print("\nPlease check in the sheet:")
        lines += ["", "### Please check in the sheet"]
        for w in warnings:
            print("  ! " + w)
            lines.append("- " + w)
            if os.environ.get("GITHUB_ACTIONS"):
                print("::warning::" + w)
    write_summary(lines)

    if not parts:
        fail("No parts found. Every brand tab needs a header row with Part Number (or Part "
             "Description) and Selling Price (INR).")

    title = clean(cfg.get("site_title")) or "Price List"
    body = {"v": FORMAT_VERSION, "title": title, "parts": parts}
    canon = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hmac.new((site_salt + "\x00" + password).encode("utf-8"), canon.encode("utf-8"),
                      hashlib.sha256).hexdigest()[:32]

    prev = fetch_previous_meta(args.site_url)
    if prev and prev.get("count") and not args.allow_big_drop:
        drop = float(cfg.get("safety_stop_drop_percent", 50))
        if len(parts) < prev["count"] * (1 - drop / 100):
            fail(f"Safety stop: parts fell from {prev['count']} to {len(parts)}. If a tab was "
                 f"deleted or renamed by mistake, fix the sheet. If this is intended, run the "
                 f"workflow by hand and tick 'Allow a big drop in parts'.")

    same = bool(prev) and prev.get("hash") == digest
    if same and prev.get("updated"):
        updated, updated_text = prev["updated"], prev.get("updated_text", "")
    else:
        now = dt.datetime.now(IST)
        updated = now.isoformat(timespec="seconds")
        updated_text = (f"{now:%d %b %Y}, {now.hour % 12 or 12}:{now:%M} "
                        f"{'am' if now.hour < 12 else 'pm'}")

    changed = (not same) or args.force
    write_github("changed", "true" if changed else "false")
    if not changed:
        print("\nNo price changes since the last update. The site stays as it is.")
        return

    payload = dict(body, updated=updated, updated_text=updated_text)
    out = os.path.abspath(args.out)
    if os.path.isdir(out):
        shutil.rmtree(out)
    shutil.copytree(os.path.join(REPO, "docs"), out)
    import html as _html
    for fname in os.listdir(out):
        if fname.endswith((".html", ".webmanifest")):
            fp = os.path.join(out, fname)
            with open(fp, encoding="utf-8") as f:
                txt = f.read()
            safe = _html.escape(title) if fname.endswith(".html") else json.dumps(title)[1:-1]
            with open(fp, "w", encoding="utf-8") as f:
                f.write(txt.replace("__SITE_TITLE__", safe))
    os.makedirs(os.path.join(out, "data"), exist_ok=True)
    with open(os.path.join(out, "data", "prices.json"), "w", encoding="utf-8") as f:
        json.dump(encrypt(payload, password, site_salt), f, separators=(",", ":"))
    with open(os.path.join(out, "data", "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"v": FORMAT_VERSION, "title": title, "updated": updated,
                   "updated_text": updated_text, "count": len(parts), "hash": digest}, f)
    print(f"\nSite built: {len(parts)} parts, prices as of {updated_text}"
          + (" (prices changed)" if not same else " (no price change, site files refreshed)"))


if __name__ == "__main__":
    try:
        main()
    except RobotError as e:
        if os.environ.get("GITHUB_ACTIONS"):
            print("::error::" + str(e))
        print("\nSTOPPED: " + str(e))
        sys.exit(1)
