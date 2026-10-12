# Run Guide — Copilot Credit Transition Sizer

You have just extracted this package. Follow the steps **in order** — each step tells you what success looks like. Everything you need is inside this folder; **no internet downloads are required**. The tool is **read-only**: it sends GET requests only and changes nothing in your tenant.

**What it does:** Microsoft removes seeded AI Builder credits on **November 1, 2026** (no conversion). This tool reads your actual AI usage, re-prices it in **Copilot Credits**, and tells you how many prepaid packs (25,000 credits/month each) to buy — per flow/app, per environment, and for the whole tenant.

---

## Step 0 — Open PowerShell in this folder

In File Explorer, open the extracted folder, right-click inside it → **Open in Terminal** (or open PowerShell and `cd` to the folder). Verify you're in the right place:

```powershell
Get-ChildItem     # you should see: dist, node_modules, prerequisites, tools, config, docs, RUN-GUIDE.md
```

> **Cloned this repo instead of receiving the offline zip?** Install [Node.js 20+](https://nodejs.org) yourself, then `npm ci && npm run build` once — after that every command below works the same (there is no `prerequisites\` folder in the repo). The offline zip, with bundled installers and pre-built code, is produced by `tools\Build-CustomerPackage.ps1` and attached to GitHub Releases.

## Step 1 — Check prerequisites (installers are in `prerequisites\`)

```powershell
node --version    # need v20 or higher
```

- No Node? Double-click `prerequisites\node-*.msi`, accept defaults, **open a new PowerShell window**, try again.
- Planning to use admin sign-in (Step 4, recommended)? Also install `prerequisites\azure-cli-*.msi` the same way, then check `az --version`.
- Do **not** run `npm install` — dependencies are already bundled in `node_modules\`.

Smoke test — this must print the tool's help:

```powershell
node dist\cli.js --help
```

## Step 2 — Rehearse with demo data (no tenant access needed)

Prove the whole pipeline on **synthetic** data before touching any tenant:

```powershell
node tools\generate-demo-data.mjs
node dist\cli.js --data-dir .\data-demo --out-dir .\output-demo forecast
node dist\cli.js --data-dir .\data-demo validate --csv .\data-demo\demo-ppac-prod.csv --environment https://contoso-demo-prod.crm.dynamics.com
```

Success: a sizing summary with two fake environments and per-flow numbers, reports in `output-demo\`, and a validation delta of 0%. Open `output-demo\sizing-report.xlsx` to see what the real deliverable will look like. Demo output is rehearsal only — never present it as measurements.

## Step 3 — Get your environment URL(s)

In [make.powerapps.com](https://make.powerapps.com): pick the environment (top right) → gear icon → **Session details** → copy the **Instance url** (like `https://org1234abcd.crm.dynamics.com`).

## Step 4 — Authenticate. FAST PATH: admin sign-in — zero configuration

> **If a Power Platform admin runs the tool, you need NO app registration and NO .env file.** This is the recommended path for a one-off sizing.

1. The admin needs read access to the environment's Dataverse. Power Platform admins self-elevate to **System Administrator** on the environment in the [Power Platform admin center](https://admin.powerplatform.microsoft.com) (temporary; every elevation is audited in Microsoft Purview).
2. Sign in once and run — that's the entire setup:

```powershell
az login --allow-no-subscriptions
node dist\cli.js ingest --auth azcli --environment https://yourorg.crm.dynamics.com
```

Success looks like:

```
Auth: Azure CLI delegated tokens (running as the signed-in az user).
  N events cached → ...\data\yourorg.crm.dynamics.com.json
  actual data window: YYYY-MM-DD → YYYY-MM-DD
```

`0 events` is also a valid outcome — it means that environment never ran AI Builder models or prompts (or retention purged the table); the report will state the actual data window found.

**Alternative — app registration (unattended/recurring runs):** create an Entra app with a client secret; add it as an **Application user** in each environment (PPAC → Settings → Users + permissions) with Read on *AI Event*, *AI Model*, *AI Template*; then `copy .env.example .env` and fill `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`. The `.env` file (`ENVIRONMENT_URLS`) is also where you list multiple environments so `ingest` can run without `--environment`.

## Step 5 — Validate against Microsoft's own report

Download the PPAC report: [PPAC](https://admin.powerplatform.microsoft.com) → **Resources → Capacity → Summary → Download reports → +New → AI Builder → Submit**, then download the `.xlsx`. Compare:

```powershell
node dist\cli.js validate --csv .\AIBuilderReport.xlsx --environment https://yourorg.crm.dynamics.com
```

Pass: delta ≤ 5%. PPAC computation can lag 5+ days — if a delta appears on recent days, re-check a closed month with `--month YYYY-MM`. With multiple environments, set each environment's `environmentId` (GUID from the PPAC report) in `config\sizer.config.json` so matching is explicit.

## Step 6 — Forecast (the deliverable)

```powershell
node dist\cli.js forecast --environment https://yourorg.crm.dynamics.com
```

Outputs in `output\`:
- **sizing-report.xlsx** — Summary · **Per-Flow** (each flow/app/agent → CC per average & peak month) · Per-Environment · Per-Capability · Unmapped · **How it is calculated** (the math, step by step).
- **sizing-report.md** — executive summary (set `numberLocale: "de-DE"` in `config\sizer.config.json` for German formatting).

**Read the Unmapped sheet first.** Events there were excluded — never guessed. Add their model names to `config\rate-tables\aibuilder-rates.json` match patterns and re-run `forecast` (no re-ingest needed).

## Step 7 — Scale out, then act

For many environments, run **one batch**: list all URLs (comma-separated) in `ENVIRONMENT_URLS` — either in `.env` or discovered tenant-wide:

```powershell
$envs = az rest --resource "https://globaldisco.crm.dynamics.com" --url "https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances" --query "value[].Url" -o tsv
$env:ENVIRONMENT_URLS = ($envs -join ",")
node dist\cli.js ingest --auth azcli
```

The batch shows an `[i/N]` progress counter, **continues past failures** (403 = your account has no role in that environment yet), and finishes with an OK/failed summary. Every environment's outcome is appended to **`data\ingest-log.csv`** — your coverage tracker. Re-run only the failures after fixing access:

```powershell
$failed = Import-Csv .\data\ingest-log.csv | Where-Object status -eq 'FAILED' | Select-Object -ExpandProperty environment -Unique
$env:ENVIRONMENT_URLS = ($failed -join ","); node dist\cli.js ingest --auth azcli
```

When coverage is complete, `node dist\cli.js forecast` (no flag) sizes the whole tenant. Then act: purchase the packs (M365 admin center → Marketplace → "Microsoft Copilot Studio"), allocate credits per environment in PPAC, set guardrails (pay-as-you-go overage plan, per-agent limits, notifications). On Nov 1, 2026 the cutover is automatic — apps and flows fall back to Copilot Credits without any rebuild.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot find module` on step 1 | Extraction incomplete — re-extract the full zip (node_modules must be present). |
| `HTTP 401/403` during ingest | Your identity has no role in that environment's Dataverse. Admin path: self-elevate to System Administrator in PPAC. App path: check the application user + role. |
| `AADSTS…` error | Wrong tenant or Conditional Access blocks Azure CLI. `az login --tenant <tenant-id> --allow-no-subscriptions`, or use the app-registration path. |
| `0 events` ingested | Environment never ran AI Builder/prompts, or the AI Event table was purged by retention jobs. |
| `validate` says "no PPAC match" | Set the environment's `environmentId` or `name` in `config\sizer.config.json`. |
| Everything lands in Unmapped | Extend the match patterns in `config\rate-tables\aibuilder-rates.json`. |

## Privacy note

The local cache (`data\*.json`) can contain run details from the event payload — for text scenarios this may include model input text. Treat `data\` as confidential; review before sharing outside your organization.

---

*Estimates only — verify against the Microsoft Power Platform Licensing Guide and the Copilot Credit Guide before purchasing. Methodology, citations, and architecture: `README.md` and `docs\solution-architecture.html`. This guide was validated end-to-end on 2026-07-14.*
