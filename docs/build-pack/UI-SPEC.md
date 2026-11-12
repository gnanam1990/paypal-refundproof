# UI specification

## Design direction

Use a high-trust operations console: OLED dark surfaces, Fira Sans for interface text, Fira Code for identifiers, semantic green only for provider-confirmed completion, amber for unknown/reconciling, and red for blocked or failed policy checks. Never use color alone. Avoid decorative fintech gradients and animated balance theatrics.

## Information architecture

Screens: case queue, case/evidence review, proposal comparison, approval detail, operation timeline, reconciliation workspace, and system health. The case detail is the primary workspace: evidence on the left, exact proposed refund in the center, and authoritative state plus allowed actions on the right.

## Critical behavior

The approval screen repeats capture, merchant, exact outbound amount/currency semantics, reason, evidence digest, expiry, and whether `FULL` is intentionally requested. A changed revision removes the approval call to action. `OUTCOME_UNKNOWN`, EXHAUSTED, and mere lookup absence have no retry button; they show last provider evidence, next reconciliation time, and escalation. CONFIRMED appears only from backend state backed by a provider observation.

## Responsive and accessible behavior

At 375px, panels become a step sequence with a persistent state summary; at 768px and above, use split panes; at 1440px, cap text measure and preserve dense evidence tables. Provide keyboard navigation, skip links, visible focus, 44px targets, 4.5:1 text contrast, screen-reader live announcements for state changes, error summaries, reduced motion, and non-color icons from one SVG family.

## Honest states

Every screen defines loading, empty, partial evidence, stale provider snapshot, validation error, permission denied, offline, retry scheduled, exhausted, unsupported environment, and restored-after-restart states. Skeletons must reserve layout space. Destructive actions require a confirmation describing the exact bound revision.
