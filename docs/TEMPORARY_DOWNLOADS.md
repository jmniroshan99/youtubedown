# Temporary downloads and local saving

## Analyze, choose, then download

A complete supported URL pasted into the main input starts analysis and obtains or reuses the verified guest/account identity. It does not create a processing job. The user chooses Video or Audio, selects an actual available format/quality and clicks Download to create one idempotent job. Changing a selection alone does not submit a job. Processing remains in the Celery worker, with real status and Cancel/Retry controls.

After an explicitly requested job finishes, the interface requests its normal browser download once. **Save file** remains available to reuse that same output when automatic downloading is blocked or requires a user gesture. Refreshing the page does not automatically submit a new job.

A 720p MP4 with audio is suggested when supported and within server limits, reducing transfer size compared with higher resolutions. The user can select other available qualities or Audio. No conversion starts until Download is clicked. There is no upscaling and no invented format availability.

## Where data lives

| Data | Location and lifetime |
|---|---|
| Accounts, profiles, provider registry | Existing Supabase services; preserved |
| New analysis, job metadata and events | Bounded Redis state; expires automatically |
| Queue and idempotency state | Redis with lifecycle-specific expiry |
| Quota/abuse counters | Expiring counters independent from deleting a job |
| Working media and request files | Isolated temporary worker directories; cleaned on exit and recovery |
| Prepared media for browser delivery | Temporary private Storage staging; removed by scheduled cleanup |
| Saved video | Device Downloads folder or browser-selected destination |
| Legacy history | Existing records preserved; no new permanent history writes |

No media bytes are written to database tables, browser localStorage, IndexedDB or application caches. The supplied Redis service disables AOF and snapshot writes for new state. Restarting Redis loses current jobs, queue messages, idempotency and quota counters. Existing volume identifiers and older volume files/backups are preserved; this is not a forensic-erasure operation. Avoid unnecessary metadata logging.

## Filename and browser limits

The final attachment response suggests `youtubedown - Original Video Title.mp4`, with the actual output extension. The server sanitizes unsafe path/control characters and filesystem names while retaining valid Unicode. Browsers can add a number for duplicate names or adjust the name for their operating system.

Browser settings control whether a file saves to Downloads automatically or opens a Save dialog. A website cannot silently select arbitrary folders. The normal download flow cannot reliably report that a local write completed, so the app distinguishes **Video ready** from **Download started**. It must not claim **Saved to device** without a confirmed supported file-write operation.

## Retention and recovery

Merge the current operating options from `backend/.env.example` and use identical values on API, worker and scheduler instances. `EPHEMERAL_JOB_TTL_SECONDS` defaults to 86,400 seconds; its effective minimum covers the job timeout, file retention and safety margin. `DOWNLOAD_TRANSFER_GRACE_SECONDS` defaults to 3,600 seconds after a signed URL is issued. Existing `FILE_RETENTION_HOURS`, `GUEST_FILE_RETENTION_MINUTES` and `SIGNED_URL_TTL_SECONDS` remain in force. The temporary object key namespace contains its expiry, and an opaque deletion ledger retains only object paths and cleanup times until deletion succeeds, not source URLs or titles. An independent bounded Storage sweep discovers expired objects in the dedicated opaque temporary namespace when Redis no longer has their cleanup records. Keep the scheduler running. Jobs and temporary files expire; cancellation, failure and crashed-worker recovery also trigger cleanup. Active worker locks and issued-link transfer grace prevent premature deletion.

Never delete an object immediately after returning its signed URL. The normal browser download manager cannot reliably acknowledge completion. Large files go directly from private Storage to the browser instead of passing through Netlify or being buffered entirely in frontend memory.

Existing downloaded files on a user's device are outside server cleanup. Existing legacy database records are not deleted automatically by this update. Any separate historical cleanup requires an explicit reviewed policy.
