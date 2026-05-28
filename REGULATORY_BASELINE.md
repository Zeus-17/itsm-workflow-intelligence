# Regulatory Baseline — ITSM Workflow Intelligence Tool v25

This document records every regulatory framework, standard and platform reference
embedded in the tool, the version or publication it was written against, and the
date it was last reviewed.

The tool's content layer (`itsm-content-v25.json`) is monitored weekly by a GitHub
Actions workflow that checks FCA, EBA and ICO publication feeds. When a relevant
update is detected, a notice is added to the JSON and surfaced to users via the
📋 Reg button in the tool nav.

**Guidance in this tool is informational only.** It is not legal or compliance advice.
For decisions specific to your organisation, engage your compliance team.

---

## Regulatory Frameworks

| Framework | Provisions referenced | Version / publication | Last reviewed |
|---|---|---|---|
| **FCA Handbook — SUP 15** | SUP 15.3.1R notification obligations; operational incident reporting thresholds | FCA Handbook as at January 2026 | January 2026 |
| **FCA PS21/3** | Operational resilience — impact tolerances for important business services | Policy Statement PS21/3, March 2021 | January 2026 |
| **FCA CP22/25 / SS1/21** | Operational resilience joint statement with PRA | FCA/PRA SS1/21, March 2021 | January 2026 |
| **DORA Article 9** | ICT risk management framework requirements; CVE tracking obligations | EU Regulation 2022/2554 | January 2026 |
| **DORA Article 17** | ICT-related incident management process; human oversight requirement | EU Regulation 2022/2554 | January 2026 |
| **DORA Article 18** | ICT-related incident classification criteria | EU Regulation 2022/2554 — **RTS pending final publication** | January 2026 |
| **DORA Article 19** | Major ICT-related incident reporting: 4h initial / 72h intermediate / 1 month final | EU Regulation 2022/2554 — **RTS pending final publication** | January 2026 |
| **DORA Article 28** | ICT third-party service provider contractual obligations | EU Regulation 2022/2554 | January 2026 |
| **UK GDPR Article 33** | Personal data breach notification to ICO within 72 hours | UK GDPR as retained post-Brexit | January 2026 |
| **UK GDPR Article 5(1)(c)** | Data minimisation principle — case reference over personal data in incident records | UK GDPR as retained post-Brexit | January 2026 |
| **ICO Breach Reporting** | 72-hour notification window; DPO engagement guidance | ICO guidance as at January 2026 | January 2026 |
| **PCI DSS** | Card data handling warnings; truncation and masking at point of entry | PCI DSS v4.0 | January 2026 |
| **Payment Services Regulations 2017** | PSR notification for payment service incidents | PSR 2017 as amended | January 2026 |

---

## Standards and Frameworks

| Standard | Provisions referenced | Version | Last reviewed |
|---|---|---|---|
| **ITIL 4** | Incident, Problem, Change, Service Review practice definitions and workflow | ITIL 4 current edition (AXELOS) | January 2026 |
| **ISO 20000** | IT service management alignment notes | ISO/IEC 20000-1:2018 | January 2026 |

---

## Platform References

| Platform | What is referenced | Version validated against | Last reviewed |
|---|---|---|---|
| **ServiceNow** | Field API names (incident, problem, change tables); ITSM workflow conventions | Washington DC / Xanadu release | January 2026 |
| **Jira / JSM** | REST API v3 field names; issue type conventions | Jira Cloud as at January 2026 | January 2026 |
| **Confluence** | REST API v2 endpoint structure; space and page conventions | Confluence Cloud as at January 2026 | January 2026 |
| **PagerDuty** | Webhook payload schema | PagerDuty API v2 | January 2026 |
| **Datadog** | Webhook payload schema | Datadog API as at January 2026 | January 2026 |
| **Dynatrace** | Webhook payload schema | Dynatrace API as at January 2026 | January 2026 |
| **Grafana** | Webhook payload schema | Grafana Alerting as at January 2026 | January 2026 |

---

## Known Pending Items

| Item | Detail | Expected resolution |
|---|---|---|
| **DORA Article 18 RTS** | Regulatory Technical Standards governing incident classification thresholds — pending final EBA/ESMA/EIOPA publication. Thresholds shown in the tool are indicative. | Q2–Q4 2026 |
| **DORA Article 19 RTS** | Regulatory Technical Standards for incident reporting templates — pending final publication. | Q2–Q4 2026 |

When these RTS are finalised, update `itsm-content-v25.json`:
1. Update the relevant `regulatory_references` entries
2. Remove the pending warnings from `content_warnings`
3. Increment `content_version` to the date of the update
4. Update `changelog` with one line describing the change

---

## Review Cadence

| Trigger | Action |
|---|---|
| FCA Handbook update published | Review SUP 15 and PS21/3 entries; update JSON if thresholds or obligations change |
| EBA/ESMA/EIOPA DORA publication | Review DORA entries; update JSON; remove pending flags if RTS finalised |
| ICO guidance update | Review UK GDPR breach notification entry |
| ServiceNow major release (bi-annual) | Validate field API names against release notes |
| Quarterly (minimum) | Review all entries; update `next_review` in `itsm-content-v25.json` |

The GitHub Actions workflow (`content-monitor.yml`) monitors FCA, EBA and ICO RSS
feeds weekly and adds notices automatically. This file captures the authoritative
baseline that the content layer is validated against.

---

*Last reviewed: January 2026*  
*Maintained by: James Holford*  
*Tool version: v25*
