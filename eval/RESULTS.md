# Council vs. single-reviewer eval — results
Detection rate of planted issues across **3 trial(s)** per fixture. Higher is better.
All three arms reviewed identical frozen evidence. "Checker" and "single reviewer" use the same
model (`gpt54-synth`); only the prompt differs.
| Fixture | Issues | Checker | Single reviewer | Council |
|---|---|---|---|---|
| version-flag | 4 | 2/12 (17%) | 6/12 (50%) | 9/12 (75%) |
| fastapi-rate-limit | 4 | 8/12 (67%) | 12/12 (100%) | 12/12 (100%) |
| csv-sum | 3 | 0/9 (0%) | 3/9 (33%) | 5/9 (56%) |
| debounce | 3 | 3/9 (33%) | 3/9 (33%) | 3/9 (33%) |
| jwt-auth | 4 | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) |
| **Overall** | | **42%** | **64%** | **74%** |
**Clean-control over-flagging** (`clean-control`, no planted issues — lower is better, avg "serious problem" signal hits): checker 0.0, single 1.0, council 1.0.
**Failed trials (excluded from rates):** 1 — jwt-auth-t2. Detection rates are computed only over successful trials.
## Methodology
- **Arms (identical evidence):** (A) production checker gate — one model + terse JSON checker prompt;
  (B) strong single reviewer — the same model + an exhaustive review prompt; (C) council — panel + judge + synthesizer.
- **Dataset:** `eval/fixtures.mjs` — realistic build reports that meet their acceptance criteria but hide
  known issues. Task themes overlap with Scott Logic's "Ponytail? YAGNI!" post (rate-limit, csv-sum, debounce, JWT).
- **Grading:** a planted issue counts as *detected* if any of its `match` synonyms appears in the arm's output.
  This is a deliberately coarse, deterministic proxy (no LLM grader). Raw outputs are published so anyone can audit.
- **Limitations:** keyword grading misses paraphrases and can over-credit; models are non-deterministic (hence trials);
  planted issues are not real PRs; results are specific to this model + harness (effectiveness = skill + model + harness).
Raw per-run outputs (committed): `eval/raw-results.json`. Re-run: `node eval/council-vs-checker.mjs --trials 3`.
