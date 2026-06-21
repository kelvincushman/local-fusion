# Council vs. single-reviewer eval — results
Detection rate of planted issues across **2 trial(s)** per fixture. Higher is better.
Grader: **llm**. "Checker" and "single reviewer" use the same model (`gpt54-synth`); only the prompt differs.
"Council (same-model)" forces every panel member onto that one model, isolating model diversity from extra perspectives (#3).
| Fixture | Issues | Checker | Single reviewer | Council (diverse) | Council (same-model) |
|---|---|---|---|---|---|
| version-flag | 4 | 1/8 (13%) | 2/8 (25%) | 7/8 (88%) | 7/8 (88%) |
| fastapi-rate-limit | 4 | 6/8 (75%) | 5/8 (63%) | 8/8 (100%) | 7/8 (88%) |
| csv-sum | 3 | 0/6 (0%) | 2/6 (33%) | 3/6 (50%) | 2/6 (33%) |
| debounce | 3 | 2/6 (33%) | 3/6 (50%) | 4/6 (67%) | 4/6 (67%) |
| jwt-auth | 4 | 6/8 (75%) | 6/8 (75%) | 7/8 (88%) | 6/8 (75%) |
| react-countdown | 3 | 6/6 (100%) | 6/6 (100%) | 6/6 (100%) | 6/6 (100%) |
| sql-user-lookup | 3 | 2/6 (33%) | 2/6 (33%) | 2/6 (33%) | 2/6 (33%) |
| **Overall** | | **48%** | **54%** | **77%** | **71%** |
**Clean-control over-flagging** (`clean-control`, no planted issues — lower is better, avg "serious problem" signal hits): Checker 0.0, Single reviewer 0.0, Council (diverse) 0.5, Council (same-model) 0.0.
## Checker confidence calibration (#4)

| Checker confidence | Runs | Avg planted-issue detection |
|---|---|---|
| conf <0.55 | 0 | — |
| 0.55–0.8 | 0 | — |
| 0.8–1.0 | 14 | 47% |

Mean checker confidence **1.00** vs mean actual detection **47%** — a gap this large means the checker is **overconfident**, which is the case for routing low-confidence work to the council automatically.
## Methodology
- **Arms (identical evidence):** checker (terse gate) · single reviewer (same model, exhaustive prompt) · council (diverse panel + judge + synthesizer) · council same-model (panel forced to one model).
- **Grading:** an **LLM judge** decides whether each planted issue is identified (conservative, JSON verdict). Raw outputs are committed so anyone can re-grade.
- **Dataset:** `eval/fixtures.mjs` — realistic build reports that meet their acceptance criteria but hide known
  issues. Themes overlap with Scott Logic's "Ponytail? YAGNI!" post (rate-limit, csv-sum, debounce, JWT, etc.).
- **Limitations:** small N with non-deterministic models (wide error bars); planted issues are not real PRs;
  results are specific to this model + harness (effectiveness = skill + model + harness).
Raw per-run outputs (committed): `eval/raw-results.json`. Re-run: `node eval/council-vs-checker.mjs --trials 2 --parallel --grader llm --diversity`.
