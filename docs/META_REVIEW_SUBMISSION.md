# Meta App Review — Advanced Access submission reference

This doc is your side-by-side companion for the Meta Developer Dashboard submission flow.
Every field below is copy-paste-ready. Follow it top to bottom.

---

## 0. Accounts & URLs you will use

### Demo accounts on staging (created on the staging DB)

| Role | Email | Password |
|---|---|---|
| Media Buyer (primary) | `buyer@demo-review.rsoc.app` | `DemoReview2026!` |
| Company Admin | `admin@demo-review.rsoc.app` | `DemoReview2026!` |
| Company | `Demo Review Co` (slug `demo-review-co`) | — |

Login works end-to-end (verified via `/api/auth/login` → 200 with JWT).

### App URLs

- Dashboard login: `https://app.staging.rsoc.app/login`
- Privacy policy: `https://app.staging.rsoc.app/privacy`
- Terms of service: `https://app.staging.rsoc.app/terms`
- OAuth callback: `https://app.staging.rsoc.app/api/facebook/callback`
- App ID (DATA app on staging): see `deploy/.env.staging` → `FB_APP_ID`


### Facebook account to record with

You need **one** Facebook user that has ALL of these:
- Admin role on at least one Business Manager
- The BM owns at least one Facebook Page
- The BM owns at least one Ad Account with a valid payment method
- Added as a **Tester** on your FB app (Dashboard → Roles → Testers → add)

Do **not** use `L. M Marak` profile (its token is broken, see FB connections table).

---

## 1. Pre-submission checklist

Do everything on this list before clicking Submit — Meta rejects fast on missing pieces.

- [ ] **Business Verification** complete at business.facebook.com → Business Settings → Security Center → Business Verification (if not started, submit NOW — it takes 2-5 business days). Required for `business_management`, `ads_management`, `pages_manage_ads`.
- [ ] **Privacy Policy URL** reachable and lists each Facebook data category (ads data, pages data, business data) + encryption + retention + user-deletion right
- [ ] **Terms of Service URL** reachable
- [ ] **App icon** uploaded (1024×1024 PNG) in App Settings → Basic. **Must not contain Meta trademarks or logos** (Meta auto-rejects on this).
- [ ] **Contact email** set in App Settings → Basic
- [ ] **App Category + App Purpose** selected in App Settings → Basic (both fields; Meta rejects if blank)
- [ ] **App Domains** = `rsoc.app` (or your prod domain) in App Settings → Basic
- [ ] **OAuth redirect URI** registered: `https://app.staging.rsoc.app/api/facebook/callback`
- [ ] **API calls made within the last 30 days** on each requested permission. We already have 100K+ Dev-mode calls on `ads_management`, `ads_read`, etc. — auto-satisfied, do NOT delete connections before submitting.
- [ ] **FB user you'll record with** added as Tester on the app (App Dashboard → Roles → Testers → Add)
- [ ] **Demo buyer** verified logs in on staging (`buyer@demo-review.rsoc.app` / `DemoReview2026!`)
- [ ] **Monitor resolution set to ≤ 1440px wide** before recording (Meta's recommendation so UI isn't tiny for reviewers)
- [ ] **Screencast recorded** following the plan in §4 (1080p+, **no audio**, on-screen text/captions only), uploaded to unlisted YouTube or Loom
- [ ] **Submission text** below pasted into each permission's form — **do not copy and paste between permissions** (Meta explicitly flags this)

---

## 2. Permissions requested (all in one submission)

| Permission | Why we need it |
|---|---|
| `ads_management` | Create, pause, resume, edit the buyer's own Facebook ad campaigns |
| `ads_read` | Pull Insights to populate the buyer's own Analytics dashboard |
| `business_management` | Enumerate the buyer's Business Managers and ad accounts after they grant access |
| `pages_show_list` | Populate the Facebook Page dropdown in the campaign wizard |
| `pages_manage_ads` | Make `/act_<id>/promote_pages` return the FULL page list (Meta precondition) |
| `pages_read_engagement` | Required by Meta alongside `pages_show_list` to return the Pages list |

Submit all 6 in **one** review cycle. One screencast covers them all.

---

## 3. Per-permission submission text (copy-paste into Meta's form)

**Meta's actual form has 5 tabs**: Verification → App settings → **Allowed usage** → Data handling → Reviewer instructions.

For **each permission** on the Allowed usage tab, the form asks for THREE things only:

1. **Describe how your app uses this permission or feature** — the long text below.
2. **Upload screencast showing the end-to-end user experience** — one video (see §4).
3. **Agree that you will comply with allowed usage** — checkbox.

The **"Reviewer instructions" tab** is a single global step-by-step for the whole submission (see §4.5 at the end of this doc). Do NOT repeat the step-by-step inside each permission's Describe field.

**Dependencies Meta enforces at submit time** (your screenshot confirmed these):

| Permission | Requires |
|---|---|
| `ads_management` | `pages_read_engagement` ← auto-satisfied once it's in your submission |
| `pages_read_engagement` | `pages_show_list` ← **you must add `pages_show_list` to the submission** |
| `pages_manage_ads` | `pages_show_list` ← same |
| `ads_read` | — standalone |
| `business_management` | — standalone |
| `pages_show_list` | — standalone (but you need it as a dependency for 2 others) |

> **Meta explicitly says:** *"Do not copy and paste [between permissions]."* The Describe
> texts below are deliberately distinct — each answers Meta's four questions (how does this
> help users / why necessary / how data is used / what breaks without it) in its own words.

### 3.1 `ads_management`

**How will your app use this permission?**

> Our platform is a self-hosted advertising manager for authorized media buyers who want to launch and operate Facebook ad campaigns on ad accounts they themselves own. We call the Marketing API's write endpoints — `POST /act_<ID>/campaigns`, `POST /act_<ID>/adsets`, `POST /act_<ID>/ads`, and the corresponding `POST .../?status=PAUSED|ACTIVE` and `POST .../?daily_budget=…` edits — to create and operate those campaigns on the user's behalf. The buyer directly benefits: they get a wizard-driven launch flow (templated creatives, split-tested audiences, standardised naming), a one-click pause when a campaign under-performs, and the ability to adjust budgets from a single dashboard instead of logging into Ads Manager for every change. Every write is scoped to the user's own ad account via their own token — we never touch another user's data. Without this permission the launch, pause/resume and budget-edit features would be impossible and the dashboard would be read-only.

### 3.2 `ads_read`

**How will your app use this permission?**

> After a media buyer launches campaigns through our platform (via `ads_management`), they need a single place to see how those campaigns are performing without logging into Facebook Ads Manager for every account they own. We call `GET /act_<AD_ACCOUNT_ID>/insights` on an hourly worker job to pull `spend`, `impressions`, `clicks`, `cpm`, `ctr`, and `actions` per campaign and per day. These numbers populate our Analytics dashboard — the buyer sees unified ROI numbers side-by-side with revenue data from the downstream monetization layer we run for them. The data is scoped per-buyer: a buyer can only see insights for ad accounts they themselves connected, never anyone else's. Without `ads_read` the Analytics dashboard would be empty of Facebook-side metrics, and the buyer would be forced to manually cross-reference Ads Manager with our tool for every performance decision.

### 3.3 `business_management`

**How will your app use this permission?**

> Media buyers who work professionally almost always operate their ad accounts inside one or more Business Managers (BMs) rather than as loose personal ad accounts. On connect, we call `GET /me/businesses` to enumerate every BM the authenticated user has a role on, then `GET /<business_id>/owned_ad_accounts` and `GET /<business_id>/client_ad_accounts` to list the ad accounts under each. We render the result as a tree in our dashboard so the buyer can see, in one place, which BM each ad account belongs to and pick the correct one when launching a campaign — important because the same user often has access to several BMs. We never POST to this permission's endpoints: no role changes, no BM creation, no payment-method edits, no cross-BM asset shuffling. Without it, we would have to show a flat list of ad accounts stripped of their BM context, forcing buyers to disambiguate manually and increasing the risk of launching to the wrong account.

### 3.4 `pages_show_list`

**How will your app use this permission?**

> Our media buyers need to tell our platform which of their own Facebook Pages a new ad should run under. We call `GET /me/accounts` with this permission to fetch the list of Pages the authenticated user owns or administers, then render that list as a dropdown in step 3 of our campaign-creation wizard. The user picks one and we remember the Page ID so subsequent `ads_management` calls can attach the newly created ad to it. Without `pages_show_list` the dropdown would be empty, the buyer could not choose a Page, and the launch step would be blocked.

### 3.5 `pages_manage_ads`

**How will your app use this permission?**

> This permission is a precondition for `/act_<AD_ACCOUNT_ID>/promote_pages`, which we use to enumerate every Page an ad account is actually allowed to advertise under (including Pages the account can post ads for but has not yet linked for other purposes). Without `pages_manage_ads` granted alongside `pages_show_list`, Meta's response silently omits those Pages from the list, and our Page picker shows an incomplete set to the buyer — leading them to think a legitimate Page is missing. We never POST to this endpoint; the permission is read-only for us.

### 3.6 `pages_read_engagement`

**How will your app use this permission?**

> Meta's Page-reading endpoints we rely on for `pages_show_list` (specifically `GET /me/accounts` returning a usable Page record with `tasks` and `access_token` fields) require `pages_read_engagement` to be granted; without it, the Page objects come back stripped of the fields we need to drive the Page picker. We do not call engagement-reading endpoints such as `/<page_id>/insights` or read posts, comments, or reactions. The permission exists in our scope list purely to satisfy the Page-list precondition at Meta's API level.

---

## 4. Screencast — scene-by-scene plan (NO AUDIO)

Target length: **3-4 minutes.** Record in **1080p or better**. Set your monitor to **≤ 1440 px wide** before recording so the UI isn't tiny for reviewers. **Do NOT record audio** — Meta's docs explicitly say *"Omit audio; our reviewers will not listen to it."* Convey everything via on-screen text (title cards + caption boxes) or let the UI's own labels speak for themselves.

**Recording tools that make text overlays easy** (any of these):
- **ScreenStudio** (Mac) — timeline-based text + zoom
- **Loom** — drawing + text annotations during edit
- **QuickTime + iMovie** — record QT, drop titles in iMovie, export MP4
- **CleanShot** (Mac) — annotations + export MP4

Keep each scene a **single continuous take** — no mid-scene cuts. Make the cursor clearly visible.

### Scene 1 — Context (0:00 - 0:15)

**Show:** A plain title card for 5 seconds, then transition to the browser landing on `https://app.staging.rsoc.app` (logged out).

**On-screen text (title card):**
> KNN Syndicate — self-hosted platform for media buyers to launch and manage their own Facebook ad campaigns.
> This video demonstrates how the app uses each Facebook permission we are requesting.
> Starting state: logged out as a fresh buyer.

### Scene 2 — Buyer logs in (0:15 - 0:30)

**Show:** Click Login → enter `buyer@demo-review.rsoc.app` / `DemoReview2026!` → arrive at empty dashboard.

**On-screen text (caption, top-right):**
> Logging into our dashboard as a media buyer.
> The dashboard is empty — no Facebook account is connected yet.

### Scene 3 — Facebook connect flow — demonstrates `business_management`, `pages_show_list`, `pages_manage_ads`, `pages_read_engagement` (0:30 - 1:30)

**Show:** Navigate to `/dashboard/facebook` → click **Connect a profile** → Facebook consent dialog (visibly listing the requested scopes) → log in with the Tester account → grant → redirect back to our dashboard → the list of Business Managers, ad accounts, Pages, and pixels populates on screen.

**On-screen text (caption, top-right during the consent dialog):**
> This is Facebook Login for Business. The dialog lists every scope the app requests: ads_management, ads_read, business_management, pages_show_list, pages_manage_ads, pages_read_engagement.

**On-screen text (caption, top-right after redirect):**
> The app has called the Graph API:
> • GET /me/businesses → returned the user's Business Managers (business_management)
> • GET /<business_id>/owned_ad_accounts → ad accounts under each BM (business_management)
> • GET /me/accounts → the user's Facebook Pages (pages_show_list + pages_read_engagement)
> • GET /act_<id>/promote_pages → Pages this ad account can advertise (pages_manage_ads)
> Data is stored encrypted at rest and visible only to the buyer who connected.

### Scene 4 — Launching a campaign — demonstrates `ads_management` + the Pages dropdown (1:30 - 2:45)

**Show:** Campaigns tab → **Create campaign** → fill the wizard end-to-end (name, objective, $5 daily budget, India audience, one creative) → on the "Facebook Page" step, open the Page dropdown and let the list of Pages visibly expand → pick one → continue → Launch → the success screen appears → **open a new browser tab and navigate to the buyer's Facebook Ads Manager** → the campaign row we just created is visible there.

**On-screen text (caption at the Page dropdown):**
> The Page dropdown is populated by GET /me/accounts + GET /act_<id>/promote_pages.
> Pages shown here require all three Page scopes to be granted.

**On-screen text (caption when Launch is clicked):**
> On Launch, the app calls:
> • POST /act_<id>/campaigns
> • POST /act_<id>/adsets
> • POST /act_<id>/ads
> All writes use the user's own token, scoped to the user's own ad account (ads_management).

**On-screen text (caption after switching to Facebook Ads Manager):**
> Same user's Facebook Ads Manager. The campaign we just launched exists on Facebook.

### Scene 5 — Analytics — demonstrates `ads_read` (2:45 - 3:30)

**Show:** Analytics tab → the campaigns table with real spend, impressions, clicks, conversions → hover a few rows so the numbers are clearly readable.

**On-screen text (caption, top-right):**
> Spend / impressions / clicks / conversions are pulled hourly from GET /act_<id>/insights (ads_read).
> Shown only to the buyer who owns the ad account. Never aggregated across buyers. Never sold.

### Scene 6 — Deletion & revocation (3:30 - 3:50)

**Show:** Settings → **Disconnect Facebook** → the confirmation screen → the FB connection row disappears.

**On-screen text (caption, top-right):**
> Buyers can disconnect at any time. We call DELETE /me/permissions on Facebook's side and delete the stored (encrypted) token row in the same transaction.
> This satisfies Meta's user-deletion requirement.

### 4.5 Reviewer instructions tab — one global step-by-step (paste in that tab, not per-permission)

Meta's form has a dedicated **"Reviewer instructions"** tab. Paste this once there — it covers the whole submission and is what the reviewer follows while playing the screencast:

> **Setup**
> 1. In an incognito window, open `https://app.staging.rsoc.app/login`.
> 2. Sign in as `buyer@demo-review.rsoc.app` / `DemoReview2026!`.
>
> **Connect Facebook (exercises `business_management`, `pages_show_list`, `pages_manage_ads`, `pages_read_engagement`)**
> 3. Click the "Facebook" item in the sidebar.
> 4. Click "Connect a profile" and complete the Facebook Login for Business dialog, granting every scope requested.
> 5. After redirect, the Facebook tab displays the connected user's Business Managers, ad accounts and Pages — populated from the Graph API using the permissions above.
>
> **Launch a campaign (exercises `ads_management`)**
> 6. Click "Campaigns" in the sidebar, then "Create campaign".
> 7. Pick any objective, set a $5 daily budget, choose India as the audience, upload any image creative.
> 8. On the "Facebook Page" step, open the dropdown — your own Pages appear. Pick one.
> 9. Click "Launch". A success screen confirms the campaign was created.
> 10. In a new tab, open `https://adsmanager.facebook.com` as the same Facebook user — the campaign exists there.
>
> **View performance (exercises `ads_read`)**
> 11. Return to our dashboard. Click "Analytics" in the sidebar.
> 12. The table shows per-campaign spend, impressions, clicks and conversions pulled from `/act_<id>/insights`.
>
> **Revoke access**
> 13. Open the Facebook tab, click "Disconnect" on the connected profile. The stored token is deleted immediately and revoked on Facebook's side.
>
> **Credentials**
> - Dashboard login: `buyer@demo-review.rsoc.app` / `DemoReview2026!`
> - Facebook login: please use your own Tester-role Facebook account (we have added the Meta reviewer email as a Tester on the app).

---

## 5. Data handling questionnaire answers

Meta will ask these during submission. Our answers (matched to the real code in `packages/fb/`).

| Question | Answer |
|---|---|
| How are user tokens stored? | AES-256-GCM encrypted at rest in Postgres (`fb_connections.access_token_enc`). The 32-byte key (`TOKEN_ENCRYPTION_KEY`, 64 hex) is kept in environment variables, never checked into source. Stored payload is `base64(iv‖tag‖ciphertext)`. |
| Who can access the stored tokens? | Only the application process, via the DB password. No employee has interactive production DB access without multi-factor-authenticated SSH. Tokens are never logged. |
| Can users delete their data? | Yes. Settings → Disconnect Facebook deletes the token row and revokes the token on Facebook's side via `/me/permissions` DELETE. |
| What is your retention policy? | Tokens are retained only while the connection is active. On disconnect, deleted in the same request. On token expiry (60-day long-lived tokens), the connection is marked broken and the user is prompted to reconnect. Ad performance data (aggregated daily counters) is retained for 24 months for reporting. |
| Do you share Facebook data with any third party? | No. Ad performance data is shown only to the buyer who owns the ad account. No third-party sharing. |
| How do you transmit data? | HTTPS/TLS 1.2+ for all Graph API calls and all user-facing endpoints. |
| Do you perform any cross-user aggregation? | No. All analytics are scoped per-buyer. We do not build cross-tenant aggregates or sell data. |

---

## 6. Day-of-submission final checklist

- [ ] **Verification tab** — Business Verification shows "Verified"
- [ ] **App settings tab** has: Privacy Policy URL, Terms URL, App Icon 1024×1024 (no Meta trademarks), Contact Email, App Category, App Purpose, App Domains
- [ ] App Mode can stay **Development** (reviewers test as Tester)
- [ ] The Meta reviewer FB user is added as **Tester** on the app (App Dashboard → Roles → Testers)
- [ ] **Screencast**: uploaded as an unlisted YouTube or Loom link; 1080p+, 3-4 min, **NO AUDIO**, on-screen text/captions only, English, single take per scene, no mid-scene cuts
- [ ] **Allowed usage tab** — for EACH of the 6 permissions (`ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_manage_ads`, `pages_read_engagement`):
  - [ ] Describe field pasted from §3 (distinct text per permission)
  - [ ] Screencast link attached
  - [ ] "Agree to allowed usage" checkbox ticked
- [ ] **Allowed usage tab** — all permission dependencies are green (`ads_management` ← `pages_read_engagement` ← `pages_show_list`, `pages_manage_ads` ← `pages_show_list`). If any shows the orange warning, add the missing permission to your submission.
- [ ] **Data handling tab** filled with §5 answers
- [ ] **Reviewer instructions tab** has the single global step-by-step from §4.5
- [ ] Submitted as **one** combined review (not one permission at a time)

Expected first response from Meta: **3-7 business days.**

If a specific permission comes back with a question, the usual root causes are:
- Screencast didn't visibly exercise that permission → re-record only the scene for it (Meta lets you edit + resubmit a single permission)
- Describe text was too similar to another permission's → rewrite distinctly, resubmit
- Privacy policy didn't mention a specific data category → amend policy, resubmit
- Business Verification still pending → wait for verification, resubmit

---

## 7. Shortcut for a quick staging test today (don't need to wait for approval)

If you want to confirm the OAuth flow actually works end-to-end on staging before the review completes:

1. Add the FB user you'll record with as a **Tester** on the DATA app (Dashboard → Roles → Testers → add).
2. Log in as `buyer@demo-review.rsoc.app` on staging.
3. Click Connect Facebook — OAuth will complete in Development mode because the user is a Tester.
4. This proves the whole code path works. Once Meta approves Advanced Access, the same flow will work for any non-Tester user.
