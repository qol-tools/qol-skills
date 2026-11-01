export const LENSES = [
  { name: "correctness", reviewer: "correctness-reviewer", core: true, routes: [] },
  { name: "errors", reviewer: "correctness-reviewer", core: false, routes: ["error-handling", "removed-validation"] },
  { name: "concurrency", reviewer: "correctness-reviewer", core: false, routes: ["concurrency"] },
  { name: "security", reviewer: "security-reviewer", core: true, routes: [] },
  { name: "data", reviewer: "correctness-reviewer", core: false, routes: ["migration", "serialization"] },
  { name: "contracts", reviewer: "ux-api-reviewer", core: true, routes: [] },
  { name: "release", reviewer: "release-ci-reviewer", core: false, routes: ["ci-config", "build-config", "dependency-manifest", "mode-change"] },
  { name: "tests", reviewer: "tests-qa-reviewer", core: true, routes: [] },
  { name: "performance", reviewer: "performance-reviewer", core: false, routes: ["perf"] },
  { name: "redundancy", reviewer: "redundancy-reviewer", core: false, routes: ["refactor", "new-file"], required: ["refactor"] },
  { name: "architecture", reviewer: "architecture-reviewer", core: false, routes: ["api-change", "api-removal", "refactor", "migration"] },
];

export const LENS_NAMES = LENSES.map((lens) => lens.name);
export const CORE_LENSES = LENSES.filter((lens) => lens.core).map((lens) => lens.name);

export function requiredLenses(signals) {
  const present = new Set(signals);
  return LENSES.filter((lens) => lens.core || lens.required?.some((signal) => present.has(signal))).map((lens) => lens.name);
}

export function routedLenses(signals) {
  const present = new Set(signals);
  return LENSES.filter((lens) => lens.core || lens.routes.some((signal) => present.has(signal))).map((lens) => lens.name);
}

export function reviewerOf(lens) {
  return LENSES.find((item) => item.name === lens)?.reviewer ?? "correctness-reviewer";
}
