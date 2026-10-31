# Copilot shutdown fixture

Synthetic, static native-event fixture following Copilot's session.start,
assistant.message, and session.shutdown modelMetrics wire shapes. Event/message
IDs, requests, reasoning and tokenDetails follow the measured shape in mono main
c5b11a8, lmctl-src/tests/providers/passive-readers/copilot.test.ts, shutdown(),
and durable-memory/passive-reader-opencode-copilot-evidence.md. It is not a
capture of a paid session and contains no user data. Two shutdown events are
snapshots: the legacy CLI cost reader uses the last, never adds them. This does
not certify that native shutdowns are full-session cumulatives: the newer passive
reader retains them with reported_scope_unknown. The deliberately conflicting
999 per-message output count must not override the final snapshot's 30.

Input 200 includes 60 cache reads and 40 cache writes, leaving 100 uncached.
At pinned rates 2/10/.2/3 USD per million for input/output/read/write, the bill is
(100*2 + 30*10 + 60*.2 + 40*3)/1,000,000 = .000632 USD.

copilot-native-shape.jsonl retains the measured shutdown ID/counters/tokenDetails
from that fixture, with a synthetic start and model label, and no message contents.
It is a shape-derived excerpt, not a copied complete paid session. Input229413
=16 uncached +199996 reads +29401 writes; output1053. The same hand-test rates give
(16*2 +199996*.2 +29401*3 +1053*10)/1e6 = .1387642 USD. These rates are an oracle,
not the original model's actual prices or proof of session completeness.
