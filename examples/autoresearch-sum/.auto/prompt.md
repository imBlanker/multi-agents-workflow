Optimize sumTo in target.mjs only. It accepts safe integers n in 0..100000000,
returns the exact Number sum of integers 1..n, and throws RangeError for all
other inputs. The independent correctness checker is already supplied.

Call init_experiment once with metric_name median_ms, metric_unit ms, direction
lower. Run and log the unchanged baseline using run_experiment with
./.auto/measure.sh. Then make at most one implementation experiment in target.mjs,
run_experiment with the exact same measure command, and log_experiment keep only
when the metric improves and the independent checks pass; otherwise discard.
Stop after two total logged experiments. Do not manually commit or revert;
log_experiment performs its real keep/discard action in this dedicated worktree.

Do not modify benchmark.mjs, measurement inputs, .auto/measure.sh, checks.sh,
config.json, this prompt, or the external oracle. Do not create tests or alternate
measurement scripts. Do not skip or filter samples or correctness checks.
