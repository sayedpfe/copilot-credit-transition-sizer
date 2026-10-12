# Copilot Credit Transition Sizing Report

_Generated: 2026-10-12T11:32:48.245Z (UTC) — credit-transition-sizer_

## Why this report exists

Microsoft is retiring AI Builder credits. Seeded AI Builder credits included in Power Platform premium licenses will be **removed on November 1, 2026**, with **no conversion** into Copilot Credits ([End of AI Builder credits](https://learn.microsoft.com/en-us/ai-builder/endofaibcredits)). From that date, all AI Builder capabilities — in Power Apps, Power Automate, and Copilot Studio — consume **Copilot Credits** only. This report sizes the Copilot Credit purchase from actual usage.

## Recommendation

- **Peak month (all environments):** 2025-12 at **33,160 Copilot Credits** (all usage re-rated into Copilot Credits).
- **With 20% growth buffer:** 39,792 Copilot Credits per month.
- **Prepaid packs (tenant pool):** **2 pack(s)** of 25,000 Copilot Credits/month.
- **Prepaid packs (per-environment allocation):** 3 pack(s) in total.
- **Allocation advice:** pooling at tenant level needs 1 fewer pack(s) than per-environment allocation, because environment peaks fall in different months. Prefer the tenant pool unless specific environments need guaranteed, isolated capacity.

## Per-environment sizing

| Environment | Data window | Peak month | Peak forecast (CC) | +Buffer | Packs |
|---|---|---|---:|---:|---:|
| https://contoso-demo-dev.crm.dynamics.com | 2025-11-01 → 2026-10-11 (12 mo) | 2026-03 | 10,528 | 12,633 | 1 |
| https://contoso-demo-prod.crm.dynamics.com | 2025-11-01 → 2026-10-11 (12 mo) | 2025-12 | 30,953 | 37,143 | 2 |

## What each flow, app, and agent will need

_Copilot Credits per month, from actual runs. "Peak month" is that flow's own busiest month; the environment total is the busiest single month with all flows together (usually less than the sum of individual peaks, because flows peak at different times)._

### https://contoso-demo-dev.crm.dynamics.com

| Flow / App / Agent | Used from | Runs | CC / average month | CC / peak month |
|---|---|---:|---:|---:|
| Delivery note processing flow | PowerAutomate | 148 | 1,973.3 | 9,600 |
| Invoice intake flow | PowerAutomate | 60 | 800 | 800 |
| Customer feedback app | PowerApps | 120 | 50 | 50 |
| Complaint summarizer flow | PowerAutomate | 180 | 37.5 | 37.5 |
| HR Assist agent | CopilotStudio | 180 | 30 | 30 |
| Archive scan flow | PowerAutomate | 120 | 10 | 10 |
| (PowerAutomate: Legacy vision scoring v1) | PowerAutomate | 12 | 0 | 0 |
| **Environment total (peak month 2026-03)** | | | | **10,528** |

### https://contoso-demo-prod.crm.dynamics.com

| Flow / App / Agent | Used from | Runs | CC / average month | CC / peak month |
|---|---|---:|---:|---:|
| Invoice intake flow | PowerAutomate | 535 | 7,133.3 | 24,000 |
| Same-credits demo: object detection | PowerAutomate | 240 | 3,200 | 3,200 |
| Delivery note processing flow | PowerAutomate | 180 | 2,400 | 2,400 |
| Same-credits demo: invoice processing | PowerAutomate | 60 | 800 | 800 |
| Same-credits demo: custom documents | PowerAutomate | 24 | 256 | 256 |
| Same-credits demo: OCR | PowerAutomate | 48 | 106.7 | 106.7 |
| Complaint summarizer flow | PowerAutomate | 480 | 100 | 100 |
| Customer feedback app | PowerApps | 120 | 50 | 50 |
| HR Assist agent | CopilotStudio | 180 | 30 | 30 |
| Archive scan flow | PowerAutomate | 120 | 10 | 10 |
| (PowerAutomate: Legacy vision scoring v1) | PowerAutomate | 12 | 0 | 0 |
| **Environment total (peak month 2025-12)** | | | | **30,953** |

## Consumption by user

_The user is the run's creating identity. Caveat: flow-triggered runs record the executing identity — often the flow/connection owner — not necessarily the person who triggered the flow._

### https://contoso-demo-dev.crm.dynamics.com

| User | Runs | AIB credits | CC observed | Forecast CC |
|---|---:|---:|---:|---:|
| Automation Service Account | 208 | 334,400 | 0 | 33,280 |
| Maria Lopez | 120 | 12,000 | 0 | 600 |
| Jonas Weber | 180 | 5,400 | 0 | 450 |
| HR Agent Service | 180 | 0 | 360 | 360 |
| Anna Schmidt | 120 | 3,600 | 0 | 120 |
| (not recorded) | 12 | 3,000 | 0 | 0 |

### https://contoso-demo-prod.crm.dynamics.com

| User | Runs | AIB credits | CC observed | Forecast CC |
|---|---:|---:|---:|---:|
| Automation Service Account | 715 | 702,400 | 0 | 114,400 |
| (not recorded) | 384 | 156,600 | 0 | 52,352 |
| Jonas Weber | 480 | 14,400 | 0 | 1,200 |
| Maria Lopez | 120 | 12,000 | 0 | 600 |
| HR Agent Service | 180 | 0 | 360 | 360 |
| Anna Schmidt | 120 | 3,600 | 0 | 120 |

## How the numbers are calculated

Worked example — one flow processes a 20-page invoice batch:

```
Observed:  the run consumed 640 AI Builder credits (invoice processing)
Step 1:    640 AIB credits ÷ 32 AIB credits/page  = 20 pages of work
Step 2:    20 pages × 8 Copilot Credits/page      = 160 Copilot Credits
           → after Nov 1, 2026 this exact run will cost 160 Copilot Credits
```

Then, per environment:

```
all runs re-priced → summed per calendar month → take the HIGHEST month (peak)
packs to buy = peak × 1.20 (growth buffer) ÷ 25,000 per pack, rounded up
```

_Why the peak and not the average: unused Copilot Credits expire at the end of each month, so the subscription must cover the busiest month. Prompts (GPT) are priced from their exact token counts when the event recorded them. Runs already paid in Copilot Credits (agents, agent flows) are taken over unchanged. Every rate comes from Microsoft's published dual-currency rate table (sources below)._

## Monthly forecast detail (tenant)

| Month | Observed AIB credits | Observed Copilot Credits | Forecast Copilot Credits |
|---|---:|---:|---:|
| 2025-11 | 89,150 | 60 | 14,760 |
| 2025-12 | 162,750 | 60 | 33,160 |
| 2026-01 | 89,150 | 60 | 14,760 |
| 2026-02 | 89,150 | 60 | 14,760 |
| 2026-03 | 193,150 | 60 | 23,080 |
| 2026-04 | 89,150 | 60 | 14,760 |
| 2026-05 | 89,150 | 60 | 14,760 |
| 2026-06 | 89,150 | 60 | 14,760 |
| 2026-07 | 89,150 | 60 | 14,760 |
| 2026-08 | 89,150 | 60 | 14,760 |
| 2026-09 | 89,150 | 60 | 14,760 |
| 2026-10 | 89,150 | 60 | 14,760 |

## Method and assumptions

1. **Data source:** Dataverse AI Event table (`msdyn_aievent`) per environment, read-only.
2. **Forecast:** 100% of observed consumption — both currencies — is re-rated into Copilot Credits, because after November 1, 2026 this tenant has no AI Builder credits (seeded credits only, no add-ons). There is no official conversion ratio between the currencies; the re-rating derives capability units from the published dual-currency rate table and prices them at the Copilot Credit rate.
3. **Sizing basis:** the peak calendar month, not the average — unused Copilot Credits do not roll over and consumption resets on the 1st of each month.
4. **Prompts:** where the event payload includes token counts, exact input/output token rates are used; otherwise Microsoft's published 90/10 input/output blend is assumed.
5. **Unmapped events** are excluded from the forecast and listed separately — they are never silently dropped or guessed.

## Warnings

- https://contoso-demo-dev.crm.dynamics.com: 12 event(s) totaling 3000 AI Builder credits could not be mapped to a capability and are EXCLUDED from the forecast. Review the Unmapped sheet and extend config/rate-tables/aibuilder-rates.json match patterns.
- https://contoso-demo-prod.crm.dynamics.com: 12 event(s) totaling 3000 AI Builder credits could not be mapped to a capability and are EXCLUDED from the forecast. Review the Unmapped sheet and extend config/rate-tables/aibuilder-rates.json match patterns.

## Sources (Microsoft Learn, retrieved 2026-07-13)

- [End of AI Builder credits](https://learn.microsoft.com/en-us/ai-builder/endofaibcredits) (GA)
- [Licensing and AI Builder credits](https://learn.microsoft.com/en-us/ai-builder/credit-management) (GA)
- [Licensing and Copilot Credits](https://learn.microsoft.com/en-us/ai-builder/message-management) (GA)
- [Overview of licensing — AI Builder capability rate table](https://learn.microsoft.com/en-us/ai-builder/administer-licensing) (GA)
- [AI Builder consumption report](https://learn.microsoft.com/en-us/ai-builder/administer-consumption-report) (GA)
- [Monitor AI Builder activity](https://learn.microsoft.com/en-us/ai-builder/activity-monitoring) (GA)
- [Copilot Studio billing rates](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management) (GA)
- [Copilot Studio licensing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/billing-licensing) (GA)

---

> **Disclaimer:** estimates only. This tool reads the `msdyn_aievent` table, which Microsoft documents as a schema reference rather than a supported consumption-reporting API, and applies published list rates that Microsoft may change. Verify all figures against the Microsoft Power Platform Licensing Guide and the Copilot Credit Guide before purchasing.
