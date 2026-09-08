# Custom metric tenant isolation

Approved design: the embedding gateway authenticates end users, resolves account identity, checks roles and authoritative agent ownership. AO treats that account identifier as opaque and enforces ownership when accessing stored metrics and calls. Scorers have no organization dependency.

## Contract

- Existing service authentication protects the gateway-to-AO hop. Account headers are assertions by this trusted caller, never end-user credentials.
- A shared request-scope module handles X-Account-Id. Scoped CRUD can read global immutable defaults and its own custom definitions only. Custom ownership is assigned on create and cannot be patched.
- Mapping updates validate both the agent owner and all custom judge owners before writing. Unknown agents are denied unless a trusted gateway explicitly verifies that exact agent; the verified ownership is recorded without overwriting another owner.
- Test and calibration authorize every requested session before accessing transcripts or calling an LLM. Mixed-account batches are rejected. Session list uses exact account identity for trusted scope, preserving administrative text-search filters separately.
- Metric analytics use the same trusted scope; the browser cannot override it with query parameters. Registry metadata joins include ownership so identical names in different accounts cannot cross-contaminate results.
- Worker custom-judge selection uses session account ownership. Defaults remain global. Required-scope mode excludes unowned legacy customs; optional trusted-workspace mode preserves their existing execution. OSS callers can keep trusted administrative access without an account header; required-scope deployments explicitly reject missing context on the gateway-facing feature endpoints.
- New custom names are unique within their account; default names remain globally unique.
- Add an additive ownership migration. Backfill only custom judges whose mappings all have one known account owner. Unmapped/ambiguous legacy definitions remain unowned and inaccessible to scoped callers until operator reconciliation. Do not guess an owner from a requesting caller. Scoped mapping replacement must preserve hidden unresolved mappings until operator reconciliation.
- Reuse gateway flow, logs and report permissions. Account-wide responses require organization-level access; team/self grants must not expand into account-wide access. Transcript-bearing routes also require unredacted-call access. No customer request can reach AO if identity, permission, or authoritative flow checks fail.

## Validation interfaces

Exercise HTTP judge and analytics handlers with two synthetic accounts against real PostgreSQL, the session-list scope builder, worker custom-judge loading, and the embedding gateway proxy with injected identity/permission/flow repositories and an HTTP test upstream. Assert foreign objects are inaccessible, no partial writes or LLM use occur for mixed batches, shared defaults are immutable, valid new flows work, and identity lookup failures stop forwarding. Test upgrades from the existing registry schema and existing feature regressions.

## Release scope

Development rollout first. Database schema before application code; required-scope setting after compatible code; gateway after AO supports verified new-agent ownership. Do not expose the gateway routes during the schema/application cutover. Live deployment and customer-data reconciliation are separate operational steps.
