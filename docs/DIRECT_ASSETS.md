# Direct Assets and Bridge private files

Bridge uses one private R2-backed file plane for bounded files that cross the
MCP/Direct boundary. D1 stores only ownership, identity, lifecycle and integrity
metadata; file bytes stay in private R2.

The canonical agent path is MCP-native. The older upload-ticket protocol remains
available for programmable compatibility clients that deliberately control raw
HTTP.

## Canonical ChatGPT / agent flow

### Caller -> Bridge -> Direct host

```text
ChatGPT generated/attached file
  -> bridge.run(mode="asset", file=<ChatGPT file param>)
  -> Bridge fetches the plugin-authorized temporary file URL server-side
  -> exact size + SHA-256
  -> durable WAITING_UPLOAD metadata keyed by source identity
  -> private R2
  -> atomic READY temporary assetId + expiresAt
  -> bridge.run(mode="direct", assets=[assetId], argv=[..., "{asset:0}"])
  -> runner-authenticated private download
  -> host re-verifies size + SHA-256
  -> exact {asset:N} argv substitution
```

`bridge.run` declares its top-level `file` input through
`_meta["openai/fileParams"]`. ChatGPT supplies:

```json
{
  "download_url": "https://...",
  "file_id": "file_...",
  "mime_type": "image/png",
  "file_name": "input.png"
}
```

The caller does not receive an R2 URL, upload token or second transport
requirement on this canonical path. Bridge validates the file parameter,
restricts the download to configured HTTPS file-delivery hosts, follows only
revalidated bounded redirects, consumes at most 25 MiB and stores the exact
bytes in private R2.

The same `file_id` for the same Bridge principal is deduplicated through
`source_kind/source_ref` rather than downloaded and stored repeatedly. Bridge
persists the source/object identity in D1 before the R2 write. A retry therefore
reuses the same object identity, while an interrupted write remains a bounded
`WAITING_UPLOAD` record that scheduled cleanup can remove instead of leaving an
untracked R2 object.

`bridge.run` returns the READY metadata receipt without a file resource link.
Use its `assetId` directly for host input. To read or materialize the stored file,
call `bridge.get_result` with the receipt's `runId`; only that result operation
adds principal-bound resource links. `bridge.get_run` remains metadata-only.
Clients previously consuming a resource link directly from an import response
must make this explicit result read instead.

### Direct host -> Bridge -> caller

A Direct Run may declare up to eight bounded output slots:

```json
{
  "mode": "direct",
  "argv": ["renderer", "--output", "{export:0}"],
  "exports": [
    {
      "fileName": "result.png",
      "mimeType": "image/png",
      "maxBytes": 8388608,
      "required": true
    }
  ]
}
```

The runner allocates a fresh Bridge-owned path for each slot and exposes it only
as the exact `{export:N}` argv replacement and `BRIDGE_EXPORT_N` environment
entry. The cloud caller never supplies an export path.

After successful execution the runner:

1. accepts only a regular, non-symlink file at the declared slot;
2. enforces the declared byte bound;
3. hashes the exact bytes;
4. uploads them only while the host/run lease remains current;
5. sends the run identity, lease owner, slot index, exact size and SHA-256;
6. receives a temporary principal-owned R2 asset receipt with expiresAt.

The Worker authorizes the upload against the current Direct Run request. A
caller cannot turn this mechanism into `C:\secret.txt`, `/etc/passwd` or any
other arbitrary host filesystem read.

The terminal `bridge.get_result` response includes the export receipts and MCP
`resource_link` content. The resource URI is:

```text
bridge-file:///access/<short-lived-capability>
```

Each returned MCP resource link contains a short-lived, HMAC-signed access capability (15 minutes by default, at most 1 hour). The capability is also bound to the authenticated Bridge principal. Reading it verifies signature, expiry and principal ownership, then reads the private R2 object and independently verifies size and SHA-256 before returning binary resource content. The file expiry still applies even if a resource capability would otherwise live longer. Before file expiry, an authorized result can mint a fresh link; reading is retryable and does not delete the object.

## Temporary transfers and existing legacy objects

New MCP-native imports and Direct exports are temporary relay files. By default,
`expiresAt` is 24 hours after successful READY finalization. An import may request
an explicit shorter lifetime (60–86400 seconds). Retries of a READY import retain
its original expiry; they do not renew storage. New `persistent=true` requests
are rejected. Download needed outputs before the returned `expiresAt` and save
lasting copies in the user's chosen application or local storage.

Reads are retryable. A resource read is not a delivery acknowledgement and does
not delete the file. Once public expiry is reached, new run bindings and ordinary
resource reads fail, even if bytes are retained briefly for an accepted run.
`bridge.get_result` reports an expired imported file explicitly; a metadata read
can still show its `expiresAt` until normal metadata retention removes it.
For an authorized Direct Run result, expired temporary exports retain their
historical receipts with `availability: "expired"` and no download link. Command
output and any still-available export links remain readable, even after expired
asset metadata is pruned. Other authorization errors still fail closed; legacy
permanent objects continue through the ordinary resource authorization checks.

Runs accepted before expiry retain their input bytes while queued within their
queue deadline (including a stale RUNNING lease that can still be reclaimed),
or while RUNNING with a live lease. This protection stops no later
than the queue deadline plus 3700 seconds (the maximum execution plus lease
allowance); repeated heartbeats cannot make it indefinite. Only that authorized
run may stage the retained input after public expiry. An expired source still in
use cannot replace its generation; retry after that run completes or its bounded
hold expires. Queue admission and expiry claiming use atomic database checks.

Physical R2 deletion is asynchronous after expiry and any bounded hold, and is
retried after storage failures. This is not a promise of deletion at the exact
24-hour instant. The change never deletes the user's original host files.

Previously created permanent (`persistent=1`) READY objects remain readable,
reusable and excluded from transient cleanup. No migration shortens their
lifetime. A repeated import of the same existing legacy source may reuse that
original object. Changing or deleting legacy permanent data needs separate owner
authorization; this release does not turn it into temporary data.

## Low-level compatibility upload ticket

Programmable clients may still request:

```json
{
  "mode": "asset",
  "fileName": "artwork.png",
  "mimeType": "image/png",
  "sizeBytes": 3145728,
  "sha256": "<64 lowercase hex>",
  "persistent": false
}
```

Bridge returns a one-time `WAITING_UPLOAD` ticket. Compatibility upload tickets are intentionally transient. `persistent=true` is rejected. This compatibility path preserves its original ticket deadline (one hour from ticket creation by default, or explicit `ttlSeconds` up to 24 hours). READY finalization does not reset that deadline. It differs from the canonical native import/export default of 24 hours after READY.

The compatibility client
performs:

```text
PUT <upload.url>
Authorization: Bearer <upload.token>
Content-Length: <exact size>

<raw bytes>
```

The Worker buffers at most 25 MiB, verifies exact byte size and SHA-256, writes
private R2, and atomically marks the metadata READY. D1 stores only the upload
token digest. READY finalization is idempotent for the same exact asset bytes:
a concurrent retry cannot delete an object already finalized by another request.
If finalization is interrupted before READY, the bounded WAITING metadata remains
the cleanup owner for the private object.

This protocol is not the canonical ChatGPT/Skill path.

## Direct Run input binding

A Direct Run can bind owned READY assets:

```json
{
  "mode": "direct",
  "assets": ["asset-..."],
  "argv": ["tool", "--input", "{asset:0}"]
}
```

The gateway resolves each asset ID to trusted metadata before queueing. The
runner downloads through its authenticated private endpoint and independently
re-verifies size and SHA-256. The download endpoint also verifies the current
Run ID, lease owner, unexpired RUNNING lease, host credential, principal owner,
and that the requested asset is declared by that Run. A valid host credential
alone is not sufficient to fetch another principal-owned or same-owner asset.

Only an argv element exactly equal to `{asset:N}` is replaced. Embedded
expansion is not supported. Staged paths are also exposed as
`BRIDGE_ASSET_0`, `BRIDGE_ASSET_1`, and so on.

## Security and integrity invariants

- private R2 only; no public development URL or custom public domain;
- authenticated Bridge principal owns every caller-visible asset;
- maximum 25 MiB per asset;
- maximum 8 input assets and 8 output slots per Direct Run;
- exact size + SHA-256 verification at ingress, host staging, export and
  principal resource read;
- native import URLs are HTTPS and host-allowlisted;
- input download authorization binds runner token + host + live lease + run +
  declared input asset;
- export authorization binds runner token + host + live lease + run + declared
  slot index;
- output slots accept regular non-symlink files only;
- no arbitrary host filesystem browsing/download;
- upload credentials remain internal for MCP-native paths;
- low-level ticket tokens are one-time and D1 stores only their digest;
- binary bytes do not travel through D1 or ordinary structured stdout.

## Cleanup

Expired objects without a bounded live-run reference are claimed atomically:

1. record an object-key/token retirement receipt and mark metadata `EXPIRED` in
   one D1 transaction, making new references impossible;
2. delete the private R2 bytes selected from the retirement journal;
3. acknowledge only the exact retirement token after deletion succeeds;
4. prune old expired metadata later.

A failed R2 delete leaves its durable receipt for retry. A late writer rotates the
retirement token, so an earlier cleanup ACK cannot lose the retry. Legacy permanent
READY objects are excluded; expired WAITING uploads remain cleanup-eligible.
No public arbitrary R2-key deletion or host-path download is added.

Runner-side input/output staging directories are caches. Their local cache
retention does not define the R2 object lifetime.

## Production resources

Create the bucket before deploy:

```bash
npx wrangler r2 bucket create bridge-direct-assets
```

Binding:

```text
DIRECT_ASSETS -> bridge-direct-assets
```

Apply D1 migrations before the new Worker so the `persistent`,
`source_kind`, and `source_ref` columns exist.

Optional configuration:

```text
BRIDGE_FILE_IMPORT_HOSTS=files.oaiusercontent.com,files.openai.com
```

Use this only to narrow or deliberately extend the trusted file-delivery host
set. Do not use it as a general URL-fetch allowlist.


### Buffered transfers and retired object generations

The 25 MiB per-file contract is unchanged. Buffered upload/import/export work
shares one fail-fast isolate slot (`DIRECT_ASSET_BUSY`; HTTP upload/export use
429). MCP resource reads retain this slot through base64/JSON serialization and
response-body consumption or cancellation. The 60-second transfer deadline
aborts supported IO; the slot is not released merely because the deadline fired.
Underlying reads/cancellation must settle first. R2/D1 operations without abort
support keep ownership until they settle, preventing overlapping large buffers.
This bounds concurrent buffered operations; it is not evidence that a 25 MiB
SDK response fits the Worker memory limit. Run the maximum-size MCP fixture in
the deployment runtime before claiming that platform memory boundary verified.

READY publication of an export checks the current host/token/run lease in the
same D1 statement. Expired source retries use a new R2 object generation;
finalization and cleanup are bound to that exact object key. The replacement
transaction records the old key in a retirement table. Cleanup deletes only
recorded retired keys and acknowledges them after successful, idempotent R2
deletion; failures preserve the retry record.

Each retirement registration has a fresh opaque token, including a registration
after an earlier record was deleted. Cleanup acknowledges only the key and token
it actually read, so a late writer cannot lose its retry record to an older
cleanup pass. Late ticket/import/export writes also retire a current generation
that expired while R2 was writing; live WAITING/READY generations are never
retired by that error path. Retrying an expired source replaces its key only after any bounded live-run reference ends.

Apply `0021_direct_asset_object_retirements.sql` before this code. This is a
main file-plane migration; the separate Billing branch owns numbers 0013–0020.
Do not copy those Billing files into a production migration set to fill a
numbering gap. Reconcile migration identities when branches are integrated.
Local regression fixture: `node --test test/direct-asset-hardening.test.mjs`
includes maximum-size reads, unread-response cancellation, Chinese content,
actual SQLite generation/authorization checks and interrupted cleanup.
