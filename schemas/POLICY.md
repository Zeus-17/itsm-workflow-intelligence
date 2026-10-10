# ITSM Workflow Intelligence tool - what happens when an input is unresolved

*Generated from `unresolved-policy.json` by `build_schemas.py`. Do not edit by hand.*

For every leaf input of every engine: what happens when the input arrives as 'unresolved'. 'block' = no verdict can be produced (UI shows the distinct 'cannot be determined' state). 'fallback' = a named, conservative value is substituted AND a caveat is attached to the result. Model-inferred values are never an allowed provenance.

**Block** = no verdict can be produced; the UI shows the distinct 'cannot be determined' state (or 'not assessed' where the engine would otherwise show nothing).  
**Fallback** = a named, conservative value is used AND a caveat travels with the result.  
**Agent may write: no** = only an explicit human action may set the value; the agent can show evidence but never supply it.

## `incident_score`

updateScore()/calcScore() - six factors summed; P4 0-5, P3 6-10, P2 11-16, P1/Major 17+. A SUGGESTION: the tier is chosen by the user, and a score of 17+ also sets the major-incident flag regardless of the chosen tier.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `users` | **Block** (`score_users_unknown`) | cannot be determined | yes | No neutral value exists: the form's 0 / 'Unknown' scores as 'no impact', which silently LOWERS the suggested tier. (The form's 'Unknown / not assessed' = 0 is exactly the unresolved state, so it is treated as unresolved, not as an answer.) |
| `business` | **Block** (`score_business_unknown`) | cannot be determined | yes | No neutral value exists: the form's 0 / 'Unknown' scores as 'no impact', which silently LOWERS the suggested tier. |
| `workaround` | **Block** (`score_workaround_unknown`) | cannot be determined | yes | No neutral value exists: the form's 0 / 'Unknown' scores as 'no impact', which silently LOWERS the suggested tier. (0 means 'a workaround fully resolves impact' - a real answer, not 'don't know'.) |
| `duration` | **Block** (`score_duration_unknown`) | cannot be determined | yes | No neutral value exists: the form's 0 / 'Unknown' scores as 'no impact', which silently LOWERS the suggested tier. |
| `regulatory` | **Block** (`score_regulatory_unknown`) | cannot be determined | yes | No neutral value exists: the form's 0 / 'Unknown' scores as 'no impact', which silently LOWERS the suggested tier. (0 = 'None identified' is a claim about the world, not an absence of information.) |
| `recurring` | **Block** (`score_recurring_unknown`) | cannot be determined | yes | No neutral value exists: the form's 0 / 'Unknown' scores as 'no impact', which silently LOWERS the suggested tier. |

## `severity_record`

setSev() - RECORDS the tier the user picked. The agent layer may present the engine's suggestion but may never choose or set the tier.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `severity` | **Block** (`severity_not_chosen`) | cannot be determined | no | The tier is the user's decision. The agent may show the engine's suggestion but can never choose it. |

## `intel_hint`

showIntelHint() - one hint per incident type (7 of the 8 types; 'other' and '' show nothing).

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `incidentType` | Fallback `""` | computed + caveat `incident_type_not_classified` | yes | 'Not classified' is a real state in the form and shows no hint; the caveat stops that being read as 'checked, nothing to flag'. |

## `preflight`

generatePreflightFindings() - completeness checks, severity-override warning, and payment / personal-data keyword scans over short description + service. Substring keyword matching: 'Refund' and 'Discard' trigger the payment warning.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `shortDescription` | Fallback `""` | computed + caveat `payment_pii_scan_incomplete` | yes | Blank text means the payment / personal-data keyword scan has nothing to scan: the absence of a warning would be silent, so the caveat is mandatory. |
| `observation` | Fallback `""` | computed + caveat `payment_pii_scan_incomplete` | yes | Blank text means the payment / personal-data keyword scan has nothing to scan: the absence of a warning would be silent, so the caveat is mandatory. |
| `service` | Fallback `""` | computed + caveat `payment_pii_scan_incomplete` | yes | Blank text means the payment / personal-data keyword scan has nothing to scan: the absence of a warning would be silent, so the caveat is mandatory. |
| `startedAt` | Fallback `""` | computed + caveat `preflight_field_treated_as_blank` | yes | A blank field is exactly what the pre-flight review exists to report, so treating unresolved as blank is conservative (it raises a finding). |
| `diagnosis` | Fallback `""` | computed + caveat `preflight_field_treated_as_blank` | yes | A blank field is exactly what the pre-flight review exists to report, so treating unresolved as blank is conservative (it raises a finding). |
| `assignmentGroup` | Fallback `""` | computed + caveat `preflight_field_treated_as_blank` | yes | A blank field is exactly what the pre-flight review exists to report, so treating unresolved as blank is conservative (it raises a finding). |
| `ci` | Fallback `""` | computed + caveat `preflight_field_treated_as_blank` | yes | A blank field is exactly what the pre-flight review exists to report, so treating unresolved as blank is conservative (it raises a finding). |
| `resolvedAt` | Fallback `""` | computed + caveat `preflight_field_treated_as_blank` | yes | A blank field is exactly what the pre-flight review exists to report, so treating unresolved as blank is conservative (it raises a finding). |
| `resolution` | Fallback `""` | computed + caveat `preflight_field_treated_as_blank` | yes | A blank field is exactly what the pre-flight review exists to report, so treating unresolved as blank is conservative (it raises a finding). |
| `rootCause` | Fallback `""` | computed + caveat `preflight_field_treated_as_blank` | yes | A blank field is exactly what the pre-flight review exists to report, so treating unresolved as blank is conservative (it raises a finding). |
| `permanentFix` | Fallback `""` | computed + caveat `preflight_field_treated_as_blank` | yes | A blank field is exactly what the pre-flight review exists to report, so treating unresolved as blank is conservative (it raises a finding). |
| `severity` | Fallback `""` | computed + caveat `severity_override_check_skipped` | yes | No tier means the override warning cannot fire; caveat required. |
| `triageScore` | Fallback `0` | computed + caveat `severity_override_check_skipped` | yes | A score of 0 makes the engine skip the override comparison; caveat required. |
| `timelineCount` | Fallback `0` | computed + caveat `timeline_treated_as_empty` | yes | Conservative: raises the 'timeline is empty' prompt. |
| `decisionCount` | Fallback `0` | computed + caveat `decision_log_treated_as_empty` | yes | Conservative: raises the 'no decisions logged' prompt for P1/P2. |
| `regulatoryFlagChecked` | Fallback `false` | computed + caveat `regulatory_flag_treated_as_unset` | yes | Conservative: an unset flag makes the payment / personal-data warnings fire. |

## `change_risk`

calcRiskScore() - six factors summed; low <= 30, medium <= 60, high above. Since the 2026-10-10 fix, any factor left at 'Select...' shows 'Incomplete' instead of a risk level (previously: 'Low Risk - expedited review path').

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `blast` | **Block** (`change_risk_blast_unset`) | cannot be determined | yes | The form's 'Select...' (0) adds nothing to the total, so an unset factor LOWERS the risk (before the 2026-10-10 display fix, all six unset showed 'Low Risk'). No default is safe. |
| `complexity` | **Block** (`change_risk_complexity_unset`) | cannot be determined | yes | The form's 'Select...' (0) adds nothing to the total, so an unset factor LOWERS the risk (before the 2026-10-10 display fix, all six unset showed 'Low Risk'). No default is safe. |
| `rollback` | **Block** (`change_risk_rollback_unset`) | cannot be determined | yes | The form's 'Select...' (0) adds nothing to the total, so an unset factor LOWERS the risk (before the 2026-10-10 display fix, all six unset showed 'Low Risk'). No default is safe. |
| `testing` | **Block** (`change_risk_testing_unset`) | cannot be determined | yes | The form's 'Select...' (0) adds nothing to the total, so an unset factor LOWERS the risk (before the 2026-10-10 display fix, all six unset showed 'Low Risk'). No default is safe. |
| `history` | **Block** (`change_risk_history_unset`) | cannot be determined | yes | The form's 'Select...' (0) adds nothing to the total, so an unset factor LOWERS the risk (before the 2026-10-10 display fix, all six unset showed 'Low Risk'). No default is safe. |
| `timing` | **Block** (`change_risk_timing_unset`) | cannot be determined | yes | The form's 'Select...' (0) adds nothing to the total, so an unset factor LOWERS the risk (before the 2026-10-10 display fix, all six unset showed 'Low Risk'). No default is safe. |

## `routing_suggestion`

suggestRoutingGroup() - 10 keyword rules (custom rules take priority). Highest keyword count wins, ties go to the earlier rule. The two text fields are joined WITHOUT a space before matching.

*Engine-level rule:* at least one of `observation`, `service` must carry real content, otherwise the result is **not_assessed** (`routing_text_missing`).

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `observation` | Fallback `""` | computed + caveat `routing_text_partial` | yes | The engine routes on whatever text exists; the caveat says the other field was not considered. |
| `service` | Fallback `""` | computed + caveat `routing_text_partial` | yes | As above. |

## `currency_risk`

assessCurrencyRisk() - certificate, vulnerability, support-status, penetration-test and patching signals. An empty list is NOT an all-clear when any input was skipped.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `certificates` | Fallback `[]` | computed + caveat `certificates_not_assessed` | yes | No certificate list means no certificate risk can be raised - an all-clear by omission. Allowed only with the mandatory caveat (output forced to complete=false). |
| `certificates[].name` | Fallback `""` | computed + caveat `certificate_unnamed` | yes | The engine prints 'unnamed' for a blank name. |
| `certificates[].status` | Fallback `"unknown"` | computed + caveat `certificate_status_not_assessed` | yes | 'unknown' raises no risk; caveat forces complete=false. |
| `certificates[].daysLeft` | **Block** (`certificate_days_left_unknown`) | cannot be determined | yes | The 'expiring in N days' text needs a real number. |
| `vulnerabilities` | Fallback `[]` | computed + caveat `vulnerabilities_not_assessed` | yes | As for certificates: omission is not clearance. |
| `vulnerabilities[].severity` | **Block** (`vulnerability_severity_unknown`) | cannot be determined | yes | NOT conservative to default: only critical/high are counted, so a defaulted low severity could hide one. |
| `supportStatus` | Fallback `""` | computed + caveat `support_status_not_checked` | yes | 'Not checked' is a real form state; caveat required. |
| `lastPentest` | Fallback `""` | computed + caveat `pentest_date_not_assessed` | yes | Blank date skips the staleness check; caveat required. |
| `lastPatched` | Fallback `""` | computed + caveat `patch_date_not_assessed` | yes | Blank date skips the staleness check; caveat required. |

## `sla_clock`

startSLAClock()/slaMins - the SLA limit for the chosen tier. The running clock itself is display-only.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `severity` | **Block** (`sla_severity_missing`) | cannot be determined | no | Without a tier there is no SLA limit. |
| `startedAt` | **Block** (`sla_start_missing`) | cannot be determined | yes | The tool itself warns that SLA and MTTR are incorrect without a start time; the agent path refuses to produce a limit without one. |
| `pausedMinutes` | Fallback `0` | computed + caveat `sla_pause_not_applied` | yes | Pauses are an adjustment on top of a valid clock; caveat tells the user none were applied. |

