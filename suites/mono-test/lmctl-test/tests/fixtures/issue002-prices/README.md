Issue 002 offline catalog slice

Copied without changing records or rates from the operator's lmprice cache,
generated 2026-10-03T08:54:13.494Z. Includes the eight gpt-6-luna source rows;
seven are chat offers and the perplexity row is mode responses. There is no
matching alias in that snapshot. The empty alias fixture preserves that absence.

Root cause: rowCandidateFields strips route path prefixes; resolveInternal's
exact-name pass then deliberately expands to the identity's offer group.
resolveModel therefore returns priced with seven offers. Before this change,
resolveOfferForCost already selected litellm:gpt-6-luna by source/provider sort.
The live assertion counted alternatives, rather than inspecting the selected
route. prohibitions.lms explicitly requires alternatives to remain visible.
The loader and price_record/price_alias tables faithfully preserve this data;
they do not resolve or invent ambiguity. Stored per-turn rates remain immutable.

price-direct.test.ts replays the observed Codex name against this slice through
the database loader and both resolver APIs, in both catalog orders. It also
checks the newly settled direct/reseller ambiguity and terminal alias rules.

live-expectation.patch records the matching changes made in lmctl-mono-test-work:
the live probe reports selected_route from resolveOfferForCost, while retaining
resolveModel's state shape. live.lms tests that selected route rather than the
number of alternatives. Apply from the mono-test-work root if integrating the
external test changes elsewhere.
