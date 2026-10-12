# copilot-credit-transition-sizer

Sizes the **Copilot Credit** purchase a tenant needs when its **seeded AI Builder credits retire** (November 1, 2026, or the end of the license contract term for pre-Nov-2026 purchases/renewals) — from actual usage, not guesses.

**Quickstart (no tenant access needed):**

```bash
git clone <this-repo> && cd copilot-credit-transition-sizer
npm ci && npm run build && npm test
node tools/generate-demo-data.mjs
node dist/cli.js --data-dir ./data-demo --out-dir ./output-demo forecast
```

Then open `output-demo/sizing-report.xlsx` — or just look at [`samples/`](samples/) for pre-built sample data, reports, and a walkthrough presentation. For real-tenant runs, follow [`RUN-GUIDE.md`](RUN-GUIDE.md) (validated end-to-end). Architecture: [`docs/solution-architecture.html`](docs/solution-architecture.html).

> **Disclaimer: estimates only.** This tool applies Microsoft's published list rates to usage data read from the Dataverse `msdyn_aievent` table, which Microsoft documents as a schema reference — not as a supported consumption-reporting API. Rates and behavior can change. **Always verify the result against the [Microsoft Power Platform Licensing Guide](https://go.microsoft.com/fwlink/?LinkId=2085130) and the [Copilot Credit Guide](https://go.microsoft.com/fwlink/?linkid=2368800) before purchasing.**

## Business context

- Microsoft announced the progressive end of AI Builder credits in October 2025. **Seeded AI Builder credits** (included in Power Apps Premium, Power Automate Premium, etc.) are **removed on 2026-11-01** with **no conversion** into Copilot Credits ([End of AI Builder credits](https://learn.microsoft.com/en-us/ai-builder/endofaibcredits), GA, retrieved 2026-07-13).
- Customers replace them by purchasing **Copilot Credits**: prepaid packs of **25,000 credits per month** per pack, and/or pay-as-you-go at $0.01/credit ([Copilot Studio licensing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/billing-licensing), GA; [PAYG meters](https://learn.microsoft.com/en-us/microsoft-365/copilot/pay-as-you-go/meters), GA, retrieved 2026-07-13). **Copilot Credits are never seeded free** with Power Platform licenses — packs are purchased tenant subscriptions ([capacity packs](https://learn.microsoft.com/en-us/microsoft-365/copilot/pay-as-you-go/copilot-capacity-packs), GA, retrieved 2026-07-13).
- This tool targets tenants with **only seeded credits** (no AI Builder capacity add-ons): after 2026-11-01 their AI Builder credit balance is zero, so **100% of AI Builder usage must be re-rated into Copilot Credits**.

## How it sizes

1. **Ingest** — reads every AI run from the Dataverse **AI Event** table (`msdyn_aievent`, queried via the Web API entity set `msdyn_aievents`) per environment: timestamp, model/template, consumption source, credits consumed, and the raw `msdyn_eventdata` JSON (parsed defensively for currency indicators, token counts, and LLM model name). Read-only; GET requests only. Fallback: the PPAC "AI Builder consumption report" CSV/XLSX export.
2. **Tag currency** per event (`AIB | CC | inferred-AIB | inferred-CC`) — see rules below.
3. **Re-rate** all consumption into Copilot Credits using the two config-driven rate tables. There is **no official conversion ratio** between the currencies ("There isn't a conversion of entitlement from one currency into the other currency" — [endofaibcredits FAQ](https://learn.microsoft.com/en-us/ai-builder/endofaibcredits)). Instead, per capability: `units = AIB credits ÷ AIB rate`, then `Copilot Credits = units × CC rate`. Prompt events with token counts in `msdyn_eventdata` use exact input/output token rates; otherwise Microsoft's published 90/10 input/output blend.
4. **Size on the peak month** — unused Copilot Credits don't roll over and consumption resets on the 1st ([administer-licensing](https://learn.microsoft.com/en-us/ai-builder/administer-licensing)), so the purchase must cover the highest month, not the average.
5. **Buffer and packs** — `packs = ceil(peak × (1 + growthBuffer) / 25,000)`, computed both per environment (allocated capacity) and as a tenant pool, with a recommendation which is cheaper in packs.
6. **Validate** — compares the tool's AI Builder credit totals against the PPAC consumption report and flags deltas > 5% (configurable). Note: PPAC computation can lag **five or more days**, and the report covers a **rolling 30 days** ([consumption report](https://learn.microsoft.com/en-us/ai-builder/administer-consumption-report)).

### Currency rules (implemented in `src/domain/currency-tagger.ts`)

| Context (`msdyn_consumptionsource`) | Rule | Source |
|---|---|---|
| Copilot Studio (`3 = MCS`): agents, agent flows | **Always Copilot Credits.** AI Builder credits are never consumed here. → `inferred-CC` | [message-management](https://learn.microsoft.com/en-us/ai-builder/message-management) |
| Power Apps (`1`), Power Automate (`0`), API (`2`) | **AI Builder credits first**; Copilot Credits only when AIB credits are exhausted/unavailable. Resets monthly. → `inferred-AIB` | [credit-management](https://learn.microsoft.com/en-us/ai-builder/credit-management), [endofaibcredits](https://learn.microsoft.com/en-us/ai-builder/endofaibcredits) |
| Explicit currency indicator in `msdyn_eventdata` | **Trusted over any inference** → `AIB` / `CC` | design rule |

A classic flow converted to an **agent flow** switches permanently to Copilot Credits ([message-management](https://learn.microsoft.com/en-us/ai-builder/message-management)) — such runs arrive with source `MCS` and are handled by rule 1.

### Per-capability conversion factors (derived, both rates published by Microsoft)

| Capability | AIB rate | CC rate | CC per 1 AIB credit |
|---|---|---|---|
| Object detection | 8 / image | 8 / image | 1.0 |
| Receipt, invoice, ID / contract, health card, image description | 32 | 8 | 0.25 |
| Custom document processing | 100 / page | 8 / page | 0.08 |
| Prompt basic / standard / premium (90/10 blend) | 1.2 / 24 / 182 per 1K tokens | 0.1 / 1.5 / 10 | ≈0.083 / 0.0625 / ≈0.055 |
| Advanced text analysis | 20 / 1K chars | 1.5 | 0.075 |
| Text translation | 22 / 1K chars | 1.5 | ≈0.068 |
| Simple text analysis | 2 / 1K chars | 0.1 | 0.05 |
| Text recognition (OCR) | 3 / page | 0.1 / page | ≈0.033 |
| Business card, prediction | free | free | — |

Source: [AI Builder capability rate table](https://learn.microsoft.com/en-us/ai-builder/administer-licensing#ai-builder-capability-rate-table) (GA, retrieved 2026-07-13). The tool computes these at runtime from the two rate-table files — never hardcoded.

## Setup

Requirements: **Node.js 20+**. No other tooling.

```powershell
cd packages/credit-transition-sizer
npm install
npm run build        # or run directly with: npm run sizer -- <command>
copy .env.example .env   # then edit
```

### Choosing an identity model

| Option | Setup effort | Security posture | Best for |
|---|---|---|---|
| **A. Delegated — Azure CLI (`--auth azcli`)** | None beyond `az login` — **no app registration, no app users** | Runs as the signed-in admin; MFA/Conditional Access apply; Power Platform admin self-elevation to System Administrator is temporary and **audited in Microsoft Purview** (auto-expires with PIM) | One-off sizing runs by an admin — the typical case for this tool |
| **B. App registration + application users** | App registration + one app user per environment | Unattended, least-privilege custom role, standing credential to manage | Recurring/scheduled runs, or when admins may not touch data directly |
| **C. No API access — PPAC CSV fallback** | None | Zero data-plane access | Customers who grant nothing; rough estimate only |

**Option A details (no app registration).** Microsoft no longer grants Power Platform admins automatic Dataverse data access; the admin **self-elevates to System Administrator per environment** in the Power Platform admin center, and every elevation is logged to Microsoft Purview ([Manage high-privileged admin roles](https://learn.microsoft.com/en-us/power-platform/admin/manage-high-privileged-admin-roles), GA, retrieved 2026-07-13). Then:

```powershell
az login                     # the Power Platform admin's own identity
node dist/cli.js ingest --auth azcli --environment https://yourorg.crm.dynamics.com
```

The tool requests a Dataverse token per environment through Azure CLI (delegated `user_impersonation`; still GET-only). Set `AUTH_MODE=azcli` in `.env` to make it the default. Requirements: [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed; note that some tenants restrict Azure CLI sign-in via Conditional Access — if blocked, use option B.

**Scaling option B with less effort:** application users can be created per environment via script instead of clicking through PPAC — `pac admin assign-user --environment <envId> --user <appId> --application-user --role <role>` in a loop over environments (Power Platform CLI).

### Entra app + Dataverse permissions (per environment, option B)

1. **App registration** (Entra admin center → App registrations → New): single tenant. Add a **client secret** or upload a **certificate**. No delegated/application API permissions are needed for Dataverse client-credentials — access is granted per environment via an application user.
2. **Application user in each environment** ([Power Platform admin center](https://admin.powerplatform.microsoft.com/) → Environments → *env* → Settings → Users + permissions → Application users → New app user): pick the app registration.
3. **Security role**: assign a role with **Read** on the tables **AI Event** (`msdyn_aievent`), **AI Model** (`msdyn_aimodel`), and **AI Template** (`msdyn_aitemplate`), organization scope. A minimal custom role is recommended; System Administrator also works but is over-privileged. The tool performs GET requests only.
4. Fill `.env`: `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET` (or `CERT_PEM_PATH` + `CERT_THUMBPRINT`), `ENVIRONMENT_URLS`.
5. Optional, needed for `validate` with multiple environments: in `config/sizer.config.json` set each environment's `environmentId` (the GUID from the PPAC report / maker-portal URL) and/or display `name`.

## Usage — test one environment first, then scale

```powershell
# 1. Ingest a single environment (read-only)
npm run sizer -- ingest --environment https://yourorg.crm.dynamics.com

# 2. Reconcile against the PPAC consumption report before trusting the numbers
#    (PPAC → Licensing → Capacity add-ons → Download reports → AI Builder)
npm run sizer -- validate --csv .\ppac-aibuilder-report.xlsx --environment https://yourorg.crm.dynamics.com

# 3. Forecast + reports for that environment
npm run sizer -- forecast --environment https://yourorg.crm.dynamics.com

# 4. When the validation deltas are acceptable, run all environments
npm run sizer -- ingest
npm run sizer -- forecast
```

Fallback without API access (rough estimate — blended factor, no capability detail):

```powershell
npm run sizer -- forecast --csv .\ppac-aibuilder-report.xlsx
```

Outputs: `output/sizing-report.xlsx` (Summary, Per-Flow, **Per-User**, Per-Environment, Per-Capability, Unmapped, How-it-is-calculated sheets), `output/sizing-report.md` (customer-ready executive summary incl. per-flow and per-user tables; set `numberLocale: "de-DE"` for German number formatting), plus a console summary. Per-user attribution note: the user is the run's creating identity (`createdby`) — flow-triggered runs record the executing identity (often the flow/connection owner), not necessarily the person who triggered the flow; the PPAC consumption report's own per-user view (UserId column, rolling 30 days) is the official cross-check.

## Per-agent consumption view (`sizer consumption`)

Replacement for per-agent trend reporting after Microsoft retired the unsupported `v0.1-alpha` licensing endpoint (403 since June 2026). Built **only on documented surfaces** and read-only:

```powershell
node dist\cli.js consumption --auth azcli --environment https://yourorg.crm.dynamics.com
```

- **Measured:** conversation **sessions per agent per month** (Dataverse `bot` + `conversationtranscript` — metadata only, conversation content is never read or cached) and **AI-tool Copilot Credits** from `msdyn_aievent` MCS rows (attributed to an agent when the event payload carries a matching bot id).
- **Estimated (opt-in only):** conversational credits = sessions × `consumptionEstimate.creditsPerSession` from `config\sizer.config.json`. Off by default — zero-rated M365 Copilot usage can't be distinguished, so estimates run high; the report says so.
- **Billing truth stays** PPAC → Licensing → Copilot Studio → **Manage Agents** (month-to-date billed credits per agent, GA, UI-only). Use this command for trends/attribution and reconcile monthly.
- Outputs: `output\consumption-report.md` + `.csv`, console summary. Session window is bounded by the environment's transcript retention.

## Refreshing the rate tables when Microsoft updates them

1. Re-read the [AI Builder capability rate table](https://learn.microsoft.com/en-us/ai-builder/administer-licensing#ai-builder-capability-rate-table) and [Copilot Studio billing rates](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management#copilot-credits-billing-rates).
2. Edit `config/rate-tables/aibuilder-rates.json` and `config/rate-tables/copilot-credit-rates.json`; bump `version`, set `retrievedDate`, keep `sourceUrl(s)` accurate.
3. New model/capability names go into the `match.patterns` of the right capability (first match in array order wins — keep prebuilt document models before generic `document processing`). Events matching nothing are **never guessed**: they land in the Unmapped sheet with a warning.
4. Re-run `sizer forecast` — cached ingested data is re-rated without re-ingesting.

## Caveats (read before presenting to a customer)

- `msdyn_aievent` is documented as a **schema reference**, not a supported reporting API `[doc-only]` — that is why the `validate` command exists. Reconcile before you present.
- The row-level currency is not a dedicated column; where `msdyn_eventdata` lacks an explicit indicator the tool **infers** per the documented rules and tags accordingly (`inferred-*`). The XLSX shows the tag per aggregate.
- `msdyn_aievent` retention may be shorter than 12 months (bulk-deletion jobs, [activity-monitoring](https://learn.microsoft.com/en-us/ai-builder/activity-monitoring)); the tool reports the actual data window it found.
- PPAC consumption computation can lag 5+ days; expect small deltas for recent days ([endofaibcredits FAQ](https://learn.microsoft.com/en-us/ai-builder/endofaibcredits)).
- Copilot Studio consumption **other than AI Builder capabilities** (generative answers, agent actions, agent flow actions, tenant graph grounding) is not in `msdyn_aievent` and is **out of scope** — size it with the [Copilot Studio agent usage estimator](https://microsoft.github.io/copilot-studio-estimator/).
- Prepaid pack **pricing** is intentionally out of scope; quantity sizing only.

## Sources consulted (all GA, retrieved 2026-07-13)

- https://learn.microsoft.com/en-us/ai-builder/endofaibcredits
- https://learn.microsoft.com/en-us/ai-builder/credit-management
- https://learn.microsoft.com/en-us/ai-builder/message-management
- https://learn.microsoft.com/en-us/ai-builder/administer-licensing (AI Builder capability rate table)
- https://learn.microsoft.com/en-us/ai-builder/administer-consumption-report
- https://learn.microsoft.com/en-us/ai-builder/activity-monitoring
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/billing-licensing
- https://learn.microsoft.com/en-us/microsoft-365/copilot/pay-as-you-go/copilot-capacity-packs
- https://learn.microsoft.com/en-us/microsoft-365/copilot/pay-as-you-go/meters
- https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/msdyn_aievent

## Development

```powershell
npm test          # vitest: currency rules, rate mapping, peak/pack math, CSV parser (synthetic fixtures only)
npm run build     # tsc -> dist/
```

No real customer data anywhere in this repository — all test fixtures and samples are synthetic.

## Contributing

The most valuable contributions are **rate-table updates**: when Microsoft changes a rate or ships new LLM model names, the fix is a PR against `config/rate-tables/*.json` (bump `version`, set `retrievedDate`, keep `sourceUrl` accurate — see "Refreshing the rate tables" above). Please include the Microsoft Learn source for any rate change. Code PRs: `npm test` must stay green (CI runs build + tests + the demo pipeline).

## License

[MIT](LICENSE) © Sayed Ali. **Not an official Microsoft solution** — estimates only; verify against the Microsoft Power Platform Licensing Guide and the Copilot Credit Guide before purchasing.
