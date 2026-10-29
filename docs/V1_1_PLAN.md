# v1.0.1 plan: model and reasoning-effort authorization

The next release will replace direct unit-price-based selection control with a
dynamically maintained CSV policy. Each row identifies an agent application,
provider, model and reasoning effort. Users explicitly check the combinations
they allow and specify applicable and excluded scenarios.

Discovery refresh must preserve user selections and leave newly discovered
combinations unapproved. Planning and execution admission must use the same
policy snapshot; excluded scenarios take precedence. The CSV schema, scenario
matching, editing interface and migration from existing thresholds require a
separate design before implementation. Availability and authorization are not
proof of quota, billing coverage or payment.

This is a v1.0.1 plan only. Version 1.0.0 retains its existing price/billing gates.
