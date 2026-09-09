# Custom metric account scope

AO uses opaque account identifiers supplied by a trusted embedding gateway. It does not authenticate individual end users or resolve their organizations or roles. Keep the AO service credential private; it grants administrative access to APIs outside the scoped feature surface.

The gateway authenticates its user, checks permissions and authoritative agent ownership, replaces `X-Account-Id`, and calls AO using its Basic service credential. For an agent mapping route only, it can assert `X-Verified-Agent-Id` after verifying that exact agent. AO may then register that agent's account before its first ingested session; an already-owned agent cannot be reassigned by this header.

Set `REQUIRE_ACCOUNT_SCOPE=true` on both API and eval-worker processes for a multi-account deployment. Basic credentials must also be configured. Missing or blank account context returns 401 on judge CRUD/authoring/testing, agent-judge mappings, metric analytics/drill-down, and session listing. Other AO APIs remain privileged service/admin APIs: do not expose them through an end-user gateway without their own authorization contract. This setting does not change ingest authentication.

Scoped callers see shared read-only defaults and their own custom definitions. A custom definition's account is assigned at creation and cannot be patched. Tests and calibration authorize the entire session batch before reading transcripts or invoking a model. Account query parameters cannot override trusted scope. Background custom judging requires matching session, agent and custom-definition ownership; defaults remain shared.

With required scope disabled, absent context retains trusted administrative access. Unowned legacy custom metrics remain usable by the trusted workspace worker; requests that supply account context still cannot claim or read those definitions. This optional mode is unsuitable for an end-user gateway that can omit account context.

## Upgrade and legacy ownership

Apply migration `027_judge_account_ownership.sql` before starting the new application (or apply the equivalent migration through your external schema owner). The migration replaces global custom-name uniqueness with account/name uniqueness. Old application instances use the old default-name conflict target: pause feature traffic and stop old API/worker instances during the schema/application cutover.

The migration infers ownership only when every mapping points to an agent with the same known, nonblank account. Review unresolved definitions before enabling the feature:

```sql
SELECT j.id, j.name, aj.agent_id, a.account_id AS mapped_account_id
FROM ao_judges j
LEFT JOIN ao_agent_judges aj ON aj.judge_id = j.id
LEFT JOIN ao_agents a ON a.agent_id = aj.agent_id
WHERE j.type = 'custom' AND j.account_id IS NULL
ORDER BY j.id, aj.agent_id;
```

Use authoritative external customer/agent records to reconcile these rows. Knowing a judge UUID, its name, or the first requester is insufficient evidence. For a definition shared across accounts, create a separate owned definition for each legitimate account and remap only its verified agents; do not assign the shared row arbitrarily. Preserve original data until that reconciliation is reviewed.

Enable required scope only after compatible AO code and gateway assertions are ready. Validate an owned metric and new agent, foreign metric/session rejection, mixed calibration rejection, exact session filtering and permission denial before restoring feature traffic. A rollback to global name uniqueness is impossible once two accounts have created the same name without a separate reconciliation; prefer rolling forward.
