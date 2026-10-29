// Pure selection policy; authentication discovery lives in the optional adapter.
/** ChatGPT plan types that make codex usage flat-rate (subscription-covered). */
export const PRO_COVERED_PLANS = Object.freeze(["pro", "prolite"]);

/**
 * Machine-level reviewer defaults when a Pro / Pro-Lite ChatGPT login is
 * active. `gpt-5.6-sol` @ `low` mirrors the local ~/.codex/config.toml
 * default on this machine.
 */
export const PLAN_REVIEWER_DEFAULTS = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
});

/**
 * The reviewer-role model override for the current codex login state.
 * Non-null ONLY when a Pro / Pro-Lite ChatGPT login is active.
 * @param {ReturnType<typeof readCodexPlan> | null | undefined} codexPlan
 * @returns {{ model: string, reasoningEffort: string, providerLabel: string, planType: string, planLabel: string } | null}
 */
export function reviewerPlanOverride(codexPlan) {
  if (!codexPlan?.proCovered) return null;
  return {
    model: PLAN_REVIEWER_DEFAULTS.model,
    reasoningEffort: PLAN_REVIEWER_DEFAULTS.reasoningEffort,
    providerLabel: `ChatGPT ${codexPlan.planLabel} login (local codex)`,
    planType: /** @type {string} */ (codexPlan.planType),
    planLabel: /** @type {string} */ (codexPlan.planLabel),
  };
}
