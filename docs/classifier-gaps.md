# Provisional classifier gaps

`AutobiographicalStrategy` accepts `compressionClassifierGapCategories`, an exact,
case-sensitive allowlist of provider refusal categories. Absent or empty means
o gaps. Existing canonical requests and quarantine identities are unchanged.

After the L1 attempt family is exhausted, one durable L1 coverage entry may be written only when every physical attempt in the exhausted identical-request group is a refusal with the same request hash and the same nonempty allowlisted category. Non-refusals,
provider errors, successes, quarantine skips, and synthetic exhaustion outcomes
do not qualify. The split-stitch rung is unchanged; synthetic split outcomes do
not qualify for this feature.

`SummaryEntry.classifierGap` records the category, original source hash and range,
canonical and attempted request hashes, typed per-attempt refusal evidence, quarantine key, and provisional/revisitable
markers. `sourceIds` retains exact coverage. The source archive and refusal ledger
remain intact. The stored content is fixed Context Manager text; provider refusal
text and reasoning are never copied. Live and mint recall use Context Manager as
the participant. A legacy combined recall selection containing a gap uses individual
pairs to preserve attribution. Gaps cannot merge, block merges across their source
ranges, and do not consume the speculative L1 cap. The exhausted refusal and alert history remains append-only, but accepting the authorized gap appends a `clear` event with reason `classifier-gap-authorized`; active quarantine debt and its repeating health alarm clear because the source range now has durable labeled coverage.

## Supersession is unresolved

The revisitable marker describes intent, not an implemented remint command.
Clearing quarantine alone does **not** remint a gap: compressed chunk scheduling
skips it, and `findExactL1` adopts it before provider inference. Overlap guards also
consider its source IDs covered. This behavior is tested explicitly.

Safe supersession needs an explicit branch-scoped remint operation that bypasses
those guards for one exact gap span while leaving its coverage active during the
attempt. After an accepted result, it must atomically redirect the chunk's summary
reference and the active coverage projection to the replacement, retain the gap
and its refusal receipt as historical records, and record the supersession link.
Current SummaryEntry storage has no separate historical-versus-active supersession
projection: keeping both entries active creates duplicate coverage, while deleting
the gap loses its receipt. Implementing that lifecycle is deferred; no parent/merge
link is fabricated to simulate supersession. Do not enable this option expecting
automatic later recovery.
