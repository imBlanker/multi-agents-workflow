This is a deliberately slow product demonstration for bounded optimization.
`node benchmark.mjs` measures a frozen workload. Before using it, an independent
Hacker supplies `.auto/checks.sh` calling an external, hashed correctness oracle.
The implementer does not supply correctness tests. Run in a dedicated new Git
worktree, never in the product source or another worker's checkout.
