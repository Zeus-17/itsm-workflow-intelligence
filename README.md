# ITSM Workflow Intelligence Tool — v25

<!--
[![Version](https://img.shields.io/badge/version-v25-10b981?style=flat-square)](https://zeus-17.github.io/itsm-workflow-intelligence/itsm-workflow-tool-v25.html)
[![ITIL 4](https://img.shields.io/badge/ITIL_4-Current_Edition-6366f1?style=flat-square)](https://www.axelos.com/certifications/itil-service-management/itil-4-foundation)
[![FCA](https://img.shields.io/badge/FCA-SUP_15_%7C_PS21%2F3-f59e0b?style=flat-square)](https://www.fca.org.uk/publications/policy-statements/ps21-3-building-operational-resilience)
[![EU DORA](https://img.shields.io/badge/EU_DORA-Digital_Operational_Resilience_Act-f59e0b?style=flat-square)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R2554)
[![UK GDPR](https://img.shields.io/badge/UK_GDPR-Article_33_ICO_72h-38bdf8?style=flat-square)](https://ico.org.uk/for-organisations/report-a-breach/)
[![Local First](https://img.shields.io/badge/Local--First-No_Signup_Required-10b981?style=flat-square)](https://zeus-17.github.io/itsm-workflow-intelligence/HOW-TO-RUN-LOCALLY.md)
-->

**Designed and built by [James Holford](https://www.linkedin.com/in/james-holford-z17/)**  
Built with [Claude (Anthropic)](https://claude.ai) · © 2026 James Holford

---

A production-grade operational co-pilot for incident management, service review reporting and ITSM workflow guidance. Single HTML file, zero external dependencies, works fully offline.

**[→ Open the tool](https://zeus-17.github.io/itsm-workflow-intelligence/itsm-workflow-tool-v25.html)**  
**[→ Interactive showcase](https://zeus-17.github.io/itsm-workflow-intelligence/itsm-showcase.html)**  
**[→ Guided demo](https://zeus-17.github.io/itsm-workflow-intelligence/itsm-demo-v25.html)**

---

## What it does

The tool solves a specific, real problem: incident managers under pressure have to simultaneously log structured records, communicate to multiple audiences, make compliance assessments, coordinate escalation, and document decisions — often at 3am, alone, with no institutional memory to draw on.

This tool acts as an experienced colleague sitting next to them. It structures the thinking, generates the outputs, surfaces the regulatory obligations, and never sends anything without a human confirming it first.

### Core capabilities

**Incident workflow — 7 stages**
- Triage and impact scoring with auto-severity recommendation
- Full incident record with fields mapped to ServiceNow and Jira API names
- Major incident bridge pack in under 90 seconds
- RCA using 5-Whys or Fishbone methodology
- Problem Record, Change Request and PIR — all paste-ready

**7 structured outputs**
- ServiceNow Incident Record — fields match platform API names exactly
- Jira Bug Ticket — for engineering escalation
- Jira Remediation Story — for product and delivery tracking
- Confluence Post-Incident Review — full PIR narrative
- ServiceNow Problem Record — KEDB and root cause
- ServiceNow Change Request — with ECAB workflow
- Root Cause Analysis Report — standalone governance document

**Intelligence and agentic features**
- **Pre-flight Review Agent** — analyses incident data before generation, surfaces blocking issues, regulatory flags and quality gaps. Rules-based and deterministic — every finding explained, every finding dismissible. Human in the loop by design, appropriate for FCA/DORA-regulated environments.
- **Output confidence scoring** — readiness percentage per output with specific gaps on hover
- **War Room Pulse** — live cockpit: SLA remaining, elapsed time, last comms, next update due, open decisions, MIM, bridge link
- **After-action capture** — 5-question guided debrief triggered at resolution, feeds directly into PIR
- **Cross-session pattern surfacing** — detects when a service has appeared in previous incidents as you type
- **Escalation sequencer** — numbered action steps for P1/P2 when org profile is populated
- **Decision Log** — timestamped decisions during the incident, feeds into PIR and handover pack
- **Severity override auto-log** — timeline entry when score suggests different severity to selection
- 35-check pattern analysis engine for service review reporting

**Regulatory alignment**
- FCA SUP 15, PS21/3 operational resilience
- DORA Articles 9, 17, 18, 19
- UK GDPR Article 33, ICO 72-hour notification window
- PCI DSS handling guidance
- ITIL 4 aligned throughout
- Regulatory guidance fields hidden by default — progressive disclosure reduces noise in non-regulated environments

**Self-updating regulatory content**
A GitHub Actions workflow monitors FCA, EBA (DORA) and ICO publication feeds weekly. When a relevant update is detected, a notice is automatically added pointing users to verify at the authoritative source. No manual maintenance required. Users can also trigger a manual check in Settings.

**Service review and reporting**
- RAG dashboard with configurable severity thresholds per team
- 35-check pattern analysis — incident trends, change quality, SLA trajectory, systemic patterns, YoY comparison
- Four narrative styles: Governance Committee, Board/Exec, Ops Team, Quick Briefing
- Period history with bar charts, quarterly rollup, incidents clustered by service/component

**12 workspaces**
Incident · Customer Report · Pick Up Incident · P1 Fast Track · Practice Run · Problem Record · Retrospective · Reporting · Integration Hub · Change Request · Glossary · Full/Lite Mode

**Accessibility and UX**
Text size 85–145%, dark/light mode, high contrast · Onboarding tour · Quickstart guide · Table of Contents panel · Keyboard shortcuts · Mobile layout · SLA health bar · Shift handover pack · Sanitise for external sharing · 10 named sessions · Export/import

---

## Technical approach

**Single file, zero dependencies**
The entire tool — HTML, CSS, JavaScript, all content — is a single `.html` file (~1MB). No build step, no npm, no server. Open in a browser and it works. Works offline.

**Data architecture**
All session data is stored in browser `localStorage` only. Nothing is ever transmitted to any server. The optional regulatory content fetch from GitHub is outbound-only — guidance text in, nothing out.

**Architecture decisions worth noting**

The Pre-flight Review Agent is deliberately deterministic and rules-based rather than generative AI. In FCA/DORA-regulated environments, explainable and auditable intelligence is more appropriate than a black-box LLM. Every finding has a specific cause, a clear description, and can be dismissed — the practitioner stays in control.

The content layer (regulatory guidance) is separated from the tool structure so it can be updated independently via GitHub Actions without touching the HTML. When DORA RTS thresholds are finalised or FCA Handbook SUP 15 is amended, the update happens in a JSON file only — no release required.

The service worker was deliberately replaced with a kill-switch that clears all caches and self-destructs. A persistent cache causing users to see stale regulatory guidance would be a meaningful failure mode for a tool used in regulated environments.

Organisations can host their own `content.json` for jurisdiction-specific guidance, their own ServiceNow field prefixes, or their own regulatory frameworks — without forking the tool.

---

## About this project

This tool was designed and built as a demonstration of applied AI collaboration, senior ITSM domain expertise, and product thinking. It was built iteratively with Claude (Anthropic) — architecture, implementation, testing and refinement — across an extended development process.

**Domain expertise demonstrated**
- Incident management lifecycle (ITIL 4)
- Major incident management and MIM role
- FCA/PRA operational resilience obligations (PS21/3, SUP 15)
- DORA compliance requirements (Articles 9, 17, 18, 19)
- UK GDPR Article 33 and ICO breach notification
- ServiceNow, Jira and Confluence field-level platform knowledge
- Service review, governance reporting and pattern analysis
- Problem management and RCA methodology
- Change management including emergency CHG, ECAB and rollback frameworks

**Technical and AI literacy demonstrated**
- Architecting and building a production-quality single-file application
- Iterative product development with AI collaboration
- Selecting the appropriate level of AI autonomy for a regulated use case
- Autonomous CI/CD content monitoring via GitHub Actions
- Designing for non-technical users under operational pressure
- Progressive disclosure, accessibility, and mobile-first responsive layout
- Liability-aware design: regulatory attribution, non-commercial licensing, self-updating content

---

## Files

| File | Description |
|---|---|
| `itsm-workflow-tool-v25.html` | The tool — self-contained, works offline |
| `itsm-content-v25.json` | Updatable regulatory guidance content layer |
| `itsm-showcase.html` | 16-slide interactive product showcase |
| `itsm-demo-v25.html` | 12-scene animated walkthrough demo |
| `sw.js` | Service worker kill-switch |
| `.github/workflows/content-monitor.yml` | Autonomous regulatory source monitor |
| `LICENSE` | Usage terms |
| `README.md` | This file |

---

## Licence

© 2026 James Holford. Personal and organisational use permitted. Commercial redistribution or use as the basis of a paid service requires written permission. See [LICENSE](LICENSE) for full terms.

Regulatory guidance is informational only. Not legal or compliance advice. Always verify with authoritative sources and engage your compliance team for decisions specific to your organisation.

---

*Built with [Claude (Anthropic)](https://claude.ai)*  
*Connect on [LinkedIn](https://www.linkedin.com/in/james-holford-z17/)*
