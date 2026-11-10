# ADR 011: AI cites ids from a provided context and the server validates grounding

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §8 AI pipeline](../phase-0/03-architecture.md#8-ai-pipeline) · [API contracts §6 AI contract](../phase-0/06-api-contracts.md#6-ai-contract) · [Feasibility §5 AI (Grok)](../phase-0/02-feasibility.md#5-ai-grok) · [Risks R12, R14](../phase-0/04-risks-and-dependencies.md#1-risk-register) · [ADR 004](004-smc-engine-event-sourced-reducer.md) |

## Context

The platform asks Grok to explain significant events. Language models can invent levels and numbers (R14, impact high), and users may treat AI output as trading advice (R12). The platform also requires that every visual and every value comes from real backend data and real processing.

Grok's API guarantees that responses match a JSON Schema for a documented subset of features, such as string, number, integer, boolean, enum, array and object. That guarantee covers the shape of the response, not the truth of its content.

## Decision

The model only sees a **context built by the server** from the database. Every item in it has an `id` (for example `ind:1h:rsi`, `gold`), and prices are decimal strings copied from the database. The model's structured response must **cite those ids**. The server then **validates grounding** before anything is shown, in this order:

| Step | Check |
|---|---|
| V1 | The response parses against the zod schema, including lengths and item counts |
| V2 | Every cited id exists in the context |
| V3 | Numbers in the text match context values (percentages within 0.1 points; other numbers with 3 or more significant digits within 0.05%) |
| V4 | Policy lint: no guarantee or certainty language, no instructions to buy or sell |
| V5 | Gold rules: the text never says "XAUUSD", and when the gold market is closed an observation or risk cites `gold` |

V6 (stance contradicts every confirmed setup) is a warning only. Failure in V1–V5 allows **one repair attempt** that feeds the validator's errors back. If it still fails, the analysis is stored as `rejected` and the UI shows "analysis unavailable". Related rules from the same pipeline: **no free text reaches the model** (on-demand requests choose an instrument and a reason from a fixed list), AI text is rendered as plain text, and only the `jobs` service holds the Grok key.

## Consequences

**Positive**

- Invented levels and numbers are caught by code, not left to prompt wording.
- Rejected responses are stored with their validation result, so we can measure how often the model fails.
- Fixed-list requests and plain-text rendering reduce prompt-injection and XSS paths.

**Negative and costs**

- A strict validator rejects some good answers, for example numbers the model rounds in unexpected ways. Users then see "analysis unavailable" and the repair call costs tokens.
- The context builder must produce stable ids and stay within about 8k tokens, dropping the lowest-priority items first.
- The validation rules and thresholds (0.05%, 0.1 points) are starting values that may need tuning.

**What we must do because of it**

- Unit-test every validator rule with accepting and rejecting examples, and test that a response citing an unknown id is rejected.
- Generate the JSON Schema from the zod contract and check in CI that it stays inside Grok's guaranteed subset (no `not` or `if/then/else`, strings up to 2,048 characters, arrays up to 256 items, objects up to 64 properties).
- Store the context, response, validation result, usage and cost for each analysis.
- Run the policy lint as a checked rule, and keep the "Educational analysis — not financial advice" label on every setup (R12).

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Free-form analysis** | The model can invent levels (architecture §20). With no ids to check, nothing can verify its numbers. |
| Rely on structured output alone | The schema guarantee covers format only. It cannot tell whether a price in the text exists in our data. |
