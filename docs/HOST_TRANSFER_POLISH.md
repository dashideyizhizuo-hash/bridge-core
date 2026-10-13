# Hosted Bridge installation and temporary transfer

Owner-approved scope, 2026-10-12. Baseline: main
`67a8590d4fbee9d48d4b4e5c764b9d5e68a15956`.

## Product contract

The ordinary customer installs a Host, authorizes it once in the browser, and
connects to the operated Bridge service. Customer-side Cloudflare provisioning is
not part of onboarding. The previously agreed self-hostable open-core distribution
boundary remains; commercial billing/payment must stay outside core main.

The Host must make automatic startup an explicit setting, separately observable
from whether the process is currently running. Windows means current-user login,
not an elevated pre-login service. Linux requires an available systemd user
manager; WSL must already be running. Preserve existing identities, owned-service
checks and legacy commands. Do not silently enable linger, start WSL, elevate,
publish an npm package, or modify the production Host for acceptance testing.

New file transfers are temporary relay objects rather than a permanent cloud
library. Native import and Host export default to a 24-hour window from READY.
The legacy ticket/PUT interface retains its creation-time deadline (one hour by
default, or the caller's bounded explicit TTL); READY does not extend it.
Describe expiry honestly to clients. Reads must remain retryable; first read is
not delivery acknowledgement.
Protect files needed by already accepted live runs without allowing unlimited
retention. Existing permanent objects and user-owned local originals must not be
deleted or silently assigned a new expiry by this change. Keep file contents
separate from the bounded execution journal needed to prevent duplicate effects.

## Performance boundary

Optimize demonstrated queue/cleanup queries with verified indexes. Reduce idle
Host polling with a bounded delay and reset after work, while preserving runner
authentication, lease/revocation heartbeats, cancellation and immediate draining
of available work. This is a limited polling optimization, not a claim that an
event notification transport has been implemented. Do not delay first contact.

No new long-connection infrastructure, billing integration, permanent file
library, OS privilege, or production data deletion is part of this change.

## Acceptance

- Deterministic tests cover idle delay/reset/error/cancel behavior and actual
  SQLite query plans for the affected cleanup paths.
- Service tests cover independent startup settings, identity/ownership checks,
  and truthful running/enabled state; native isolated Windows/Linux evidence is
  reported separately from untested reboot behavior.
- File tests cover default expiry, explicit unsupported permanent requests,
  legacy objects, retry/expiry races, and live-run references with real SQL.
- Run the integrated suite and core-distribution guard, then independently review
  standards and this product contract before merging. Public npm distribution
  and actual restart/login acceptance remain separate release gates.

## Verification record

Independent Standards and Spec review of implementation through `83e1c30` found
no remaining confirmed blocker after fixing two lifecycle regressions: an expired
lease could lose input bytes before legitimate reclaim, and an expired output
could hide the entire retained Run result. The latter now preserves execution
evidence, labels expired file receipts, and still propagates unexpected failures.

Real isolated Windows Task Scheduler and WSL systemd user-service acceptance
passed independent autostart changes and maintenance state preservation. Windows
also rejected a manually disabled login trigger instead of misreporting startup.
Both native fixtures verified cleanup; neither changed the production Host or
performed user logout/reboot. Evidence remains in ignored `dist/host-preview`.

A Windows full-suite run at `f19438f` was **not green**: 603 tests, 559 passed,
24 failed, 20 skipped. An isolated baseline archive reproduced 23 matching
failures; deterministic slow-child reproduction confirmed the remaining heartbeat
timing assumption on both baseline and candidate. Failures include POSIX/ACL
fixture assumptions, path separators and timing expectations. The investigation
also found a real pre-existing Windows JSON resource-path redaction defect;
`d963b65` fixes it with Windows/Linux regression evidence. Other test portability
gaps remain open; do not present targeted native acceptance as a full Windows pass.
Detailed classification is retained in `dist/recovery/windows-baseline-analysis.json`.

Published CI on the final PR is the exact-head Linux integration gate. Native
checks, focused tests, and CI each establish different properties; none alone
establish a finished public commercial product.
