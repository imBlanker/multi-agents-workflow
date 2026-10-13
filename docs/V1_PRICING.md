# Model, pricing and usage contracts

`models --json` exposes only model/provider identifiers, adapter, billing mode,
configuration status and capability evidence. Selected Claude/Codex native config
model names are configuration evidence; they do not prove the actual backend,
authentication, subscription coverage or an actual executed model. Project
`settings.models` may declare providerId/modelId/adapter/billingMode explicitly.

## Price identity and sources

Price records use USD/1M tokens and explicit numeric
`inputPerMillion/outputPerMillion/cacheReadPerMillion/cacheWritePerMillion`.
Missing fields stay null. Snake-case legacy fields are views of the same record.
Resolution uses project overrides, selected local provider data, selected remote
snapshots, bundled estimates, then unknown. Remote provider/model pairs match
exactly. Generic upstream seeds/bundled estimates have providerId=null and disclose
unverified supplier applicability; they never become verified supplier prices.

Project overrides normally use `pricing.overrides["provider/model"]`. Aliases are
explicit per-provider `pricing.aliases[provider][model]`. Cost multipliers are
applied once; a conflicting pre-multiplied record is rejected. Service modes are
separate applicability scopes. Context tiers retain their actual thresholds,
including 272000 instead of guessing 200000 from a compatibility field.

The pinned cc-switch export has 222 records from blob
`939d4594e64ce23bf250f42b6cec9f22c4caa913`, SHA256
`443c986a99b8973e6a46adf707b10e47fce6d6fcb0885372cb691ee1972bd273`.
The retrieved source is **152743 UTF-8 bytes / 141863 Unicode characters**;
earlier research called the character count bytes. The hash is unchanged.
`export-cc-switch-pricing.py` verifies this exact hash and the restricted tuple
array before producing JSON. Runtime executes no downloaded Rust/SQL. Upstream
zero cache values are conservatively null when support/free applicability was
not established. Input/output explicit zero remains valid.

`pricing refresh pricing.models-dev` is explicit and requires that integration
selected. HTTP response size, timeout and schema are bounded. Only a valid full
snapshot replaces `.mawf/cache/pricing/pricing.models-dev.json`; failure changes
only its `.status.json` sidecar. The response hash identifies the actual API
payload; the reference schema's Git commit is not falsely used as the API
version. The pinned cc-switch refresh caches its shipped, verified export.

## Commands and example

```sh
mawf config settings --project PROJECT --set '{"pricing":{"overrides":{"A/M":{"inputPerMillion":2,"outputPerMillion":8,"cacheReadPerMillion":0.2,"cacheWritePerMillion":2.5}}}}' --json
mawf pricing resolve --project PROJECT --provider A --model M --json
mawf pricing estimate --project PROJECT --provider A --model M --multiplier 1.5 --input-tokens 1000000 --output-tokens 250000 --cache-read-tokens 500000 --cache-write-tokens 100000 --json
mawf pricing project --project PROJECT --provider A --model M --multiplier 1.5 --input-per-minute 12000 --output-per-minute 2000 --json
mawf pricing gate --project PROJECT --provider A --model M --role implementer --billing api --json
mawf integrations enable pricing.cc-switch-upstream --project PROJECT --json
mawf pricing resolve --project PROJECT --provider anthropic --model claude-sonnet-4-6 --json
mawf pricing status --project PROJECT --json
```

Estimates return `estimate.amountUsd`; projections return
`projection.ratePerMin`. Missing token-channel observations produce null with a
missing-field list. Projection requires explicit input and output throughput;
its stated assumption is no cache traffic. Explicit zero observations differ
from missing observations. Neither token arithmetic nor projection is measured
payment.

## Gates and approvals

Unknown price/provider/billing defaults to pause. A preconfigured bounded risk
policy requires positive maxConcurrency and maxDurationMs or maxIterations;
limits are not inferred from missing values. Input >2 or output >10 USD/1M
retains the expensive-price gate. `approve-model --provider P --model M --role R
--billing api --yes` records a persistent exact identity and price-version
approval; `--scope run --run-id ID` limits it to that run. Unknown supplier or
price cannot receive durable approval. Changing provider/model/role/billing/
price invalidates matching. The old same-role `approved:true` is not authority.

Billing modes are validated. A subscription or local-free label is not proof of
billing coverage. No current adapter in this slice supplies a verified live
payment/subscription/quota observation, so those claims are not exempted and
`strict_measured` refuses new paid work with MEASURED_COVERAGE_REQUIRED.

`usage summarize --input FILE` accepts a JSON event array, `{events:[]}` or
JSONL. Records are allowlisted and correlated/deduplicated by request/event ID.
Imported trusted receipts can retain their reported/measured historical basis,
but always have `kind: historical_import`; JSON self-verification does not turn
them into current target telemetry. The opaque normalization-origin, freshness,
target and provider checks remain required for live policy. cc-switch amounts
are always token-price-derived estimates, even when mislabeled by an importer.
A successful host login is not a same-job billing observation.

Best-effort coverage is limited to registered work and selected telemetry. It
does not enforce all machine sessions, strict cumulative dollars, or backend
cancellation. Runtime leases and adapter observations are separate work packages.


Explicit `pricing.unknownCoveragePolicy: "bounded"` is separate from the default
`pause`. It can admit a native subscription with a real adapter account/provider
observation but unknown quota/payment, only within recorded concurrency and
duration limits. It reports basis unknown, amount null and quota unknown. It
does not relabel OAuth as API or treat unit-price tables as subscription charges.
strict_measured still refuses absent current payment coverage. Native children
must inherit an observed, registered parent model/provider/billing and its
process deadline. See V1_EXECUTION.md for the exact optional choice; no validation
project is automatically opted in.
