# AI Questionnaire — Application Assessment

## Scope and response convention

This assessment covers the current CMMI V3.0 Audit Platform in this repository, not an earlier retired product. The application is a deterministic, server-side CMMI evidence-audit system: it extracts uploaded documents and applies a versioned rule catalogue. It does **not** contain a foundation model, LLM/GenAI inference, model training or fine-tuning, prompt/chat interface, or chat history. The retired predecessor’s AI chat assistant is explicitly out of scope.



Accordingly, the response to the questionnaire’s role question is **Otherwise**. Questions that specifically concern an AI model, prompt, training data, model output, or AI lifecycle are **N/A**. “N/A” is not a claim that a control exists; it means the risk object does not exist in this application. For the few questions that still map to ordinary application security, the answer is based solely on implemented controls.

| Questionnaire item | Applicability | Response | Evidence / concise explanation |
|---|---|---|---|
| Role (row 7) | Applicable | **Otherwise** | The application has no AI model or AI deployment. Its scanning is deterministic/rule-based. |
| G.A.1 — foundational models deployed | Not applicable | **N/A** | No foundation model is deployed. |
| G.A.2 — AI TEVV | Not applicable | **N/A** | There is no GenAI/AI system or output to test. The repository has conventional automated tests for application behavior. |
| G.A.3 — real-world AI performance testing/metrics | Not applicable | **N/A** | No AI performance or model-behavior component exists. |
| G.A.4 — model management-system certification | Not applicable | **N/A** | No model-management system exists; no certification is evidenced. |
| G.A.5 — EU AI Act / AI-regulation compliance | Not applicable | **N/A** | The implemented product is not an AI provider or deployer. No AI-regulatory compliance program is evidenced. |
| G.A.6 — EU AI Act classification | Not applicable | **N/A** | No AI system is implemented, so no AI Act risk classification applies. |
| G.A.7 — AI GRC framework | Not applicable | **N/A** | No AI-risk/GRC process is implemented or evidenced. |
| G.A.8 — AI/model-use risk guidance | Not applicable | **N/A** | There is no AI/model use. Deployment/security guidance exists for the conventional web application only. |
| G.A.9 — vulnerability detection-to-remediation time | Partly applicable to the web application | **No** | No documented vulnerability-remediation SLA, target response time, or security-incident workflow is implemented. |
| G.A.10 — AI security-incident response plan | Not applicable | **N/A** | There is no AI system; a defined AI-incident response plan is not evidenced. |
| D.L.U.1 — sensitivity tags in prompt input | Not applicable | **N/A** | No prompt interface exists. Uploaded evidence is not prompt input and has no sensitivity-tag detection. |
| D.L.U.2 — reject tagged prompt data | Not applicable | **N/A** | No prompt processing or tag-based rejection configuration exists. |
| D.L.U.3 — prompt documents saved on the IS | Not applicable | **N/A** | No prompt documents exist. Separately, evidence files uploaded for audit are stored on the configured server filesystem. |
| D.L.U.4 — erase sensitive prompt data on demand | Not applicable | **N/A** | No prompt data exists. No user-facing secure-erasure-on-demand process for uploaded evidence is evidenced. |
| D.L.P.1 — de-identification of model training data | Not applicable | **N/A** | The product has no training data or model-training process. |
| D.L.P.2 — prevent training data/IP in AI output | Not applicable | **N/A** | The product does not generate AI content and has no training corpus. |
| D.L.P.3 — access to model alignment instructions | Not applicable | **N/A** | No model or alignment instructions exist. |
| D.L.A.1 — anonymization/pseudonymization/encryption of chat history | Not applicable | **N/A** | No chat feature or chat-history store exists. |
| D.L.A.2 — disable chat history | Not applicable | **N/A** | No chat history exists. |
| D.L.A.3 — chat-history logging | Not applicable | **N/A** | No chat history exists. The application does maintain ordinary audit logs for selected security/business actions. |
| D.L.A.4 — public-cloud chat-log retention | Not applicable | **N/A** | No chat logs or public-cloud AI service is implemented. |
| D.L.A.5 — remove customer data from AI system on termination | Not applicable | **N/A** | There is no AI system. No contractual/data-deletion process is evidenced for uploaded audit evidence. |
| D.L.D.1 — AI decommissioning, model archive and training-data deletion | Not applicable | **N/A** | No trained/fine-tuned model, model archive, or AI decommissioning process exists. |
| D.L.D.2 — SaaS tenant isolation for AI/fine-tuning/context | Not applicable | **N/A** | The current documented use is local/development deployment, not a multi-tenant AI SaaS; no AI-context or fine-tuning exists. |
| U.R.1 — audit AI data-access patterns | Partly applicable to the web application | **No** | Authentication and selected security/business actions (login, user/role changes, uploads and scans) are written to `audit_logs`, but the application does not monitor and review per-document data-access patterns. |
| U.R.2 — alert on unauthorized information access | Applicable to uploaded evidence access | **No** | The app returns authorization failures through RBAC, but no user alert workflow for attempted unauthorized data access is implemented. |
| U.R.3 — log unauthorized-access alert | Applicable to uploaded evidence access | **No** | There is no such alert mechanism, hence no associated alert log. |
| U.R.4 — restrict output to documents a user may access | Applicable to uploaded evidence access | **No** | Access is role/screen based; no per-user/per-document entitlement model restricts findings or output to individual document permissions. |
| U.R.5 — determine data a user may access | Applicable to uploaded evidence access | **No** | The implemented authorization decision is page/action RBAC, not data/document-level authorization. |
| U.R.6 — identify tags on data/documents accessed by model | Not applicable | **N/A** | No model accesses documents, and no document sensitivity-tagging feature is implemented. |
| U.R.7 — limit output by data tag | Not applicable | **N/A** | No model output or tag-based output filtering exists. |
| O.1 — document AI knowledge limitations/output monitoring | Not applicable | **N/A** | No AI knowledge base or AI output exists. |
| O.2 — guidance for validating/correcting AI output | Not applicable | **N/A** | No AI output exists. The audit workflow supports human review/remediation of rule-scan findings, which is distinct from AI-output validation. |
| O.3 — human oversight of AI-driven decisions | Not applicable | **N/A** | No AI-driven decisions are made. Users can review findings and record remediation in the conventional audit workflow. |
| O.4 — interpretability/explainability of AI decisions | Not applicable | **N/A** | No AI decisions exist. Deterministic rule findings retain rule/evidence provenance. |
| O.5 — references used for AI output | Not applicable | **N/A** | No AI output exists. Scan findings are associated with evidence/rules, but that is not generative AI citation. |
| B.H.I.C.1 — bias metrics for AI output | Not applicable | **N/A** | No AI output exists. |
| B.H.I.C.2 — demographic/systemic AI risk assessment | Not applicable | **N/A** | No AI system exists. |
| B.H.I.C.3 — AI output moderation | Not applicable | **N/A** | No AI-generated text, image, video, or audio exists. |
| B.H.I.C.4 — tests preventing unlawful/harmful AI content | Not applicable | **N/A** | No content-generating AI capability exists. |
| H.1 — hallucination measurement | Not applicable | **N/A** | No generative model exists, so hallucination does not apply. |
| H.2 — express AI uncertainty/hallucination | Not applicable | **N/A** | No AI output exists. |
| H.3 — explainability evaluation of GenAI tools | Not applicable | **N/A** | No GenAI tools are used or developed in the current product. |
| H.4 — communicate explainability results | Not applicable | **N/A** | No GenAI explainability activity exists. |
| P.I.1 — prompt-injection safeguards | Not applicable | **N/A** | No prompt/LLM integration exists. |
| P.I.2 — prompt-injection alert | Not applicable | **N/A** | No prompt/LLM integration exists. |
| P.I.3 — prompt-injection resilience testing | Not applicable | **N/A** | No prompt/LLM integration exists. |
| P.I.4 — prompt moderation | Not applicable | **N/A** | No prompt/LLM integration exists. |
| E.P.1 — detect/prevent permission escalation | Applicable to application access control | **No** | RBAC, authenticated sessions, protected routes, and role-management safeguards prevent unauthorized page/action access. However, no dedicated privilege-escalation detection/alerting mechanism is implemented. |
| E.P.2 — input data used to train the model / training opt-out | Not applicable | **N/A** | No model is trained; uploaded evidence is not used for training. This is architectural fact, not a contractual training-opt-out control. |
| E.P.3 — monitor model/system-configuration modification | Not applicable | **N/A** | No AI model configuration exists. Application role/rule-catalog changes are audited, but that is not model-configuration monitoring. |
| E.P.4 — monitor training-data changes | Not applicable | **N/A** | No model training data exists. |
| E.P.5 — monitor fine-tuning-instruction changes | Not applicable | **N/A** | No fine-tuning or fine-tuning instructions exist. |
| D.O.S.1 — failover/continuity during DoS | Applicable to application availability | **No** | Docker restart and a health check are configured, but no redundant deployment, failover architecture, or documented DoS contingency plan is implemented. |
| D.O.S.2 — DoS anomaly detection | Applicable to application availability | **No** | No traffic anomaly-detection capability is implemented. Login/reset request rate limits do not constitute DoS detection. |
| D.O.S.3 — terminate resource-intensive/infinite request | Applicable to scan processing | **No** | Upload/archive limits and a two-hour stale scan-job lease exist, but there is no implemented per-request execution timeout or administrator kill control. |
| D.O.S.4 — monitor model/system resource use | Applicable to application availability | **No** | No CPU/memory/resource monitoring is implemented in the application or Compose configuration. |
| S.C.A.1 — assess/secure third-party libraries, frameworks and APIs | Applicable | **No** | Dependencies are declared and versions bounded in `requirements.txt`, but no implemented SCA/vulnerability-scanning or supplier-assessment process is evidenced. |
| S.C.A.2 — public third-party plugins/add-ons | Applicable | **No** | The product does not provide a plugin/add-on marketplace or third-party extension mechanism. |
| S.C.A.3 — review public plugins/add-ons | Not applicable | **N/A** | No third-party plugins/add-ons are permitted or published. |
| S.C.D.1 — training-data integrity/provenance | Not applicable | **N/A** | No model development or training data exists. |
| S.C.D.2 — authenticate/secure pre-trained models | Not applicable | **N/A** | No pre-trained model/component is integrated. |
| S.C.D.3 — model-lifecycle change audit | Not applicable | **N/A** | No model lifecycle exists. |
| D.P.1 — prevent unauthorized training/fine-tuning data changes | Not applicable | **N/A** | No training or fine-tuning datasets exist. |
| D.P.2 — detect data-poisoning performance degradation | Not applicable | **N/A** | No trained model or training dataset exists. |
| D.P.3 — fine-tuning preserves GenAI safety/security controls | Not applicable | **N/A** | No GenAI fine-tuning exists. |
| D.P.4 — data sanitization for training/retraining | Not applicable | **N/A** | No model training or retraining exists. |
| M.D.1 — model-drift monitoring | Not applicable | **N/A** | No ML/AI model exists. |
| M.D.2 — retraining/model-update process | Not applicable | **N/A** | No ML/AI model exists. |
| M.T.1 — protect model development/deployment infrastructure | Not applicable | **N/A** | No AI model development or deployment infrastructure exists. Conventional application access is protected with authenticated, role-based access controls. |
| M.T.2 — role segregation for model access/modification/deployment | Not applicable | **N/A** | No model exists. For application administration, the system implements database-backed role and screen permissions. |
| M.T.3 — protect model against redistribution/reverse engineering/misuse | Not applicable | **N/A** | No AI model artifact is distributed or served. |

## Evidence examined

- `docs/architecture.md` — describes the Python/NiceGUI/FastAPI/MySQL CMMI audit application, its local-testing deployment, storage and RBAC design.
- `docs/feature_parity_matrix.md` — expressly identifies the legacy AI chat assistant as retired.
- `app/services/audit_engine/evidence_scan.py` and `app/services/audit_engine/rule_engine.py` — document/rule extraction and deterministic evidence checking rather than AI inference.
- `app/services/auth/service.py`, `app/api/deps.py`, `app/core/middleware.py`, and `app/core/audit_log.py` — Argon2id passwords, expiring/revocable sessions, RBAC and selected audit logging.
- `app/services/evidence_ingestion.py`, `app/services/document_processing/file_security.py`, and `app/core/validators.py` — upload limits, filename/type validation, ZIP traversal/bomb checks and on-disk evidence storage.
- `docker-compose.yml`, `Dockerfile`, `docs/security.md`, and `requirements.txt` — deployment/security measures and their current boundaries.

## Verification

The repository test suite completed successfully: **196 passed** (`pytest -q`). This verifies the existing implementation; it does not turn unimplemented operational controls into implemented controls.
