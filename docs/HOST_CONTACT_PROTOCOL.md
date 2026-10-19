# Host contact, pause and idle polling

Cloud execution permission, local process activity and recent network contact
are separate facts. Disabling a Host retains its pairing identity; it cancels
queued/running work and removes its leases. Re-enabling admits new work, never
revives canceled tasks. It does not start a locally stopped service.

## Authenticated pause protocol

Every runner request checks the logical Host, runner-token hash and existing
owner. Applications with account closure records additionally implement
`assertRunnerOwnerActive`; unknown, revoked or closed identity remains denied.

Only a task claim may record contact for a paused Host. It returns
`DIRECT_HOST_PAUSED` with HTTP 423, with no command or lease. A paused heartbeat
or completion returns the same code with HTTP 409 and cannot renew or complete
an old lease. Runner asset requests deny paused access with HTTP 403 and the
same explicit pause code after authentication. Successful
claim contact updates `last_seen_at` at most once per 60 seconds; denied tokens
and inactive owners do not update it.

New Hosts recognize only the exact pause code and corresponding status, cancel
any active execution, keep their identity/process, and claim again after 60
seconds. Other 401/403 responses remain fatal authentication failures, not an
infinite retry workaround. Published 0.4.0 clients also stop active work on 409;
their claim 423 follows the existing transient retry backoff (up to 30 seconds)
without the old repeated daemon-exit behavior. Published 0.4.0 can still exit
once if it first observes pause through a file's 403; the new Host distinguishes
that exact pause code and stays alive. No file access or completion is allowed
under revoked execution permission.

Running tasks retain the default 20-second heartbeat and 90-second lease.
The independent local watchdog stops execution approximately 80 seconds after
the last successful lease-request dispatch if contact cannot be established.
Cancellation cannot undo side effects already performed.

## Idle latency and requests

Activity-aware idle waits are 15 seconds for the first five minutes after
startup or the most recently completed task, 30 seconds for minutes five to ten,
and 60 seconds thereafter. Completed work immediately triggers another claim
and resets the five-minute hot window. Empty claims, network failures and owner
pause do not count as task completion or reset that clock. An explicit `pollMs`
remains the initial/minimum interval (allowed range 1–60 seconds); its idle delay
doubles for each five-minute inactive window, capped at 60 seconds. For example,
30 seconds becomes 60 after five idle minutes. Pause waits remain 60 seconds.
Network failures use a separate 1, 2, 4, …, 30-second retry backoff.

At steady idle or pause this is about 60 requests/hour/Host, excluding startup,
work, failures and network latency. This is polling, not a persistent push
connection: the first task after a long idle or resume can wait up to 60 seconds
plus network latency. Recent contact is evidence of a successful request, not
proof the machine is reachable at the instant the page is viewed.
