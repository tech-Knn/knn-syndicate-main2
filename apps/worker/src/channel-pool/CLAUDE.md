# channel-pool — AdSense channel assignment (D7/D11)

Assigns a pooled AdSense AFS channel (the `ch` value) 1:1 to a campaign, so AFS revenue attributes
per channel = per campaign. Lives in the worker (the single writer); the API enqueues
`CHANNEL_MAINTENANCE` jobs (`{action: 'assign'|'release'|'rollover'|'process-queue', campaignId?}`).

## Invariants / footguns

- **Zero double-assignment is the whole point.** `assignChannel` claims a channel with
  `SELECT … FROM channels WHERE status='AVAILABLE' … FOR UPDATE SKIP LOCKED LIMIT 1` inside the txn —
  concurrent claims skip each other's locked rows, so 100 simultaneous approvals take 100 distinct
  channels. **Never** replace this with a plain `findFirst` + update (that races). Guarded by the
  100-concurrent stress test in `channel.test.ts`.
- **Channels are a GLOBAL pool** (no `org_id`, no RLS — like `platform_settings`); all ops run under
  `withSystem`. The attribution span (`channel_assignments`) and the wait queue (`campaign_queue`)
  are org-scoped (RLS).
- **Pool exhausted → enqueue + `QUEUED_NO_CHANNEL`.** `processQueue` drains the FIFO queue
  (`enqueuedAt` order) into freed channels; `releaseChannelForCampaign` frees a channel then
  re-drives the queue (resume logic). Releases happen for non-holding states (PAUSED/ARCHIVED/etc.).
- **IST day (D4).** `rolloverChannels` runs at 00:05 IST: release channels from ended campaigns,
  renew still-active locks (close the prior `channel_assignment` span, open today's for per-day
  attribution in Phase 9), then drain the queue.
- **`campaign.channelId` holds the Channel row id (uuid)**, not the AdSense channel string — join to
  `channels.channel_id` for the `ch` value the redirect passes. `assignChannel` is idempotent (a
  campaign that already holds a channel is returned unchanged).
- **Pool provisioning:** `packages/db/scripts/seed-channels.ts` (placeholder ids today; real AdSense
  custom-channel ids are the operational input — OPEN_QUESTIONS #4).
