# Price List Sync (version 2)

Private Google Sheet → Price Robot (GitHub Actions, every 30 min) → password-protected sales site (GitHub Pages).

Salespersons see **only** part name, part number, brand, model and selling price.
Cost prices, USD/RMB, exchange rates and A–H codes never leave the robot.

## What is new in version 2

| | Version 1 (dummy test) | Version 2 |
|---|---|---|
| Sheet layout | Every tab needed the exact 10 headers | **Any layout.** Columns are found by header name |
| New brand tab | Robot had to be changed | Shows on the site by itself |
| Two qualities / two suppliers | Two separate rows | **One card** with every price as an option |
| Same part in two tabs | Shown twice | One card: priced row wins, then the brand tab wins over `Parts_` tabs |
| WhatsApp message | Part name first | Starts with **Enquiry for:** |
| Robot commits | Yes (caused "push rejected") | **No commits.** Deploys only when prices change |
| Safety | – | Stops if parts suddenly drop by half; warns when a price was typed over the formula |

## How the robot reads the sheet

* **Header row:** the first row (in the top 6) that has a *Selling Price* column and a *Part Number* or *Part Description* column.
* **Headers it understands:** Part Number / Part No · Part Description / Part Name · Brand · M-Model / Model · Selling Price (INR) · Q1, Q2, Q3 Selling Price (INR). All other columns are ignored and never published.
* **Supplier tabs:** tabs named `<name> Supplier A`, `<name> Supplier B` … are merged into one card per part. Labels come from `robot/config.json` → `option_labels` (Supplier A = "Original", Supplier B Quality 1 = "Quality 1" …).
* **Left off the site:** a tab whose name starts with `_`, a hidden tab, or a tab listed in `config.json` → `skip_tabs`.
* **Price on request:** a row with no selling price (no price yet, no code yet, or a code that is not A–H).
* **Site title:** `robot/config.json` → `site_title`.

## Secrets (Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `SHEET_ID` | The part of the sheet link between `/d/` and `/edit` |
| `GOOGLE_SA_KEY` | The whole robot `.json` key file (Notepad → Ctrl+A → Ctrl+C → paste) |
| `SITE_PASSWORD` | Made up by you, 12+ characters |
| `SITE_SALT` | Made up by you, any random text |

Changing `SITE_PASSWORD` or `SITE_SALT` locks every phone; each salesperson must type the new password once.

## Go-live with the real sheet

1. **Pages:** Settings → Pages → Source = **GitHub Actions** (before the first push).
2. **New robot key:** Google Cloud → IAM & Admin → Service Accounts → robot → Keys → Add key → JSON. Paste it into `GOOGLE_SA_KEY`. Delete the old test key in Google Cloud and the old key files on your computer.
3. **Share the real sheet** with the robot e-mail as **Viewer** (untick Notify people).
4. Update **`SHEET_ID`**, set a new **`SITE_PASSWORD`** and **`SITE_SALT`**.
5. **Replace the code** in your clone folder (PowerShell, inside the repo folder):
   ```powershell
   git pull
   Remove-Item -Recurse -Force .github, docs, robot
   Copy-Item -Path "$HOME\Downloads\price-list-site-v2\*" -Destination . -Recurse -Force
   git status            # must list the new files
   git add -A
   git commit -m "Price robot v2 for the real price list"
   git push
   ```
6. **Run it:** Actions → Price Robot → the run started by the push → both jobs green. Open the run summary to see the tab report.
7. **Check:** Sir checks 10 random parts on the site against the sheet.
8. Remove the robot from the dummy sheet's Share list.
9. Share the link and the password with the salespersons.

## When a run is red or yellow

* Open the run → click the red step → read the line starting with `STOPPED:`. It says what to fix in plain English.
* Yellow warnings in the run summary are sheet checks (code not A–H, formula missing, price typed over the formula, same part with two prices). The site still updates.
* "Safety stop": the number of parts fell by more than half. Fix the sheet, or run by hand (Actions → Price Robot → Run workflow) and tick **Allow a big drop in parts**.

## Everyday rules

* Edit only the sheet. The site updates within about 30 minutes; for urgent changes: Actions → Price Robot → Run workflow.
* Never type a selling price over the formula. Never share the sheet link with salespersons.
* The key and the password go only into GitHub Secrets: never chat, WhatsApp, e-mail, screenshots or recordings.
* After changing site files, bump `SHELL` in `docs/sw.js` (v3 → v4) so phones load the new version.

## Local test (optional)

Export the sheet as .xlsx, then:

```bash
pip install -r robot/requirements.txt openpyxl
python robot/sync.py --xlsx Master.xlsx --out _site --password "any-test-password" --salt test
```

It prints the same tab report and checks as the robot, without publishing anything.
