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
- Terms of service: `https://app.staging.rsoc.app/terms` (confirm reachable before submit)
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

- [ ] **Business Verification** complete at business.facebook.com → Business Settings → Security Center → Business Verification (if not started, submit NOW — it takes 2-5 business days)
- [ ] **Privacy Policy URL** reachable and lists each Facebook data category (ads data, pages data, business data) + encryption + retention + user-deletion right
- [ ] **Terms of Service URL** reachable
- [ ] **App icon** uploaded (1024×1024 PNG) in App Settings → Basic
- [ ] **Contact email** set in App Settings → Basic
- [ ] **App Domains** = `rsoc.app` (or your prod domain) in App Settings → Basic
- [ ] **OAuth redirect URI** registered: `https://app.staging.rsoc.app/api/facebook/callback`
- [ ] **FB user you'll record with** added as Tester on the app
- [ ] **Demo buyer** verified logs in on staging (`buyer@demo-review.rsoc.app` / `DemoReview2026!`)
- [ ] **Screencast recorded** following the script in §4, uploaded to unlisted YouTube or Loom
- [ ] **Submission text** below pasted into each permission's form

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

Each permission's form has roughly three fields: "How will your app use this permission?",
"Step-by-step instructions for testing", and the screencast upload. Use the text below.

### 3.1 `ads_management`

**How will your app use this permission?**

> Our media buyer users create and manage Facebook ad campaigns on their own ad accounts via our platform. The platform uses `ads_management` to create campaigns, ad sets, and ads at launch time; to pause and resume them; and to edit budgets. All writes act on the user's own ad accounts using the user's own token — no third-party ad accounts are ever touched. The user can revoke the token at any time from the dashboard.

**Step-by-step instructions:**

> 1. Open `https://app.staging.rsoc.app/login` in a private window.
> 2. Log in as `buyer@demo-review.rsoc.app` / `DemoReview2026!`.
> 3. Click the "Facebook" tab in the sidebar.
> 4. Click "Connect a profile" and complete the Facebook OAuth flow with the Tester account provided to Meta.
> 5. After redirect, click the "Campaigns" tab, then "Create campaign".
> 6. Fill the wizard with any objective, a $5 daily budget, India audience, a sample creative.
> 7. Click "Launch". The campaign is created on the connected FB ad account.
> 8. Open `https://adsmanager.facebook.com` as the same user — the campaign is visible there.

### 3.2 `ads_read`

**How will your app use this permission?**

> We populate a buyer-facing Analytics dashboard showing their own campaigns' spend, impressions, clicks, and conversions, synced hourly from the Facebook Marketing API Insights endpoints. The data shown is limited strictly to the ad accounts the buyer has personally connected. Data is scoped per-buyer and never aggregated across buyers or sold to third parties.

**Step-by-step instructions:**

> 1. Log in as the demo buyer (same credentials as above).
> 2. Ensure a Facebook ad account is connected (see `ads_management` steps).
> 3. Click the "Analytics" tab in the sidebar.
> 4. The table shows per-campaign spend, impressions, clicks, and conversions pulled from `/act_<id>/insights`.

### 3.3 `business_management`

**How will your app use this permission?**

> We call `/me/businesses` and `/<business_id>/owned_ad_accounts` to enumerate the user's own Business Manager(s) and the ad accounts under them after they grant access. This lets us show the buyer which ad accounts under their Business Manager they can run campaigns on. We do not modify Business Manager settings, user roles, or payment methods — read-only usage.

**Step-by-step instructions:**

> 1. Log in as the demo buyer.
> 2. Open "Facebook" tab → "Connect a profile" → complete OAuth.
> 3. After redirect, the page lists the user's Business Manager(s) and all ad accounts owned by each — this requires `business_management`.

### 3.4 `pages_show_list`

**How will your app use this permission?**

> When creating a campaign, buyers must choose a Facebook Page the ad will run under. We call `/me/accounts` and `/act_<id>/promote_pages` to populate a Page picker in the campaign wizard. Only the user's own Pages are shown to them. Pages are only read, never modified.

**Step-by-step instructions:**

> 1. Log in and connect FB (see above).
> 2. Open the campaign wizard: Campaigns → Create campaign.
> 3. Advance to the "Facebook Page" step.
> 4. The dropdown lists the user's Facebook Pages.

### 3.5 `pages_manage_ads`

**How will your app use this permission?**

> Meta documents that `/act_<id>/promote_pages` returns the **full** set of Pages an ad account can advertise with only when `pages_manage_ads` is granted alongside `pages_show_list`. Without it, Pages not already wired for ads are omitted and the dropdown is incomplete. We request `pages_manage_ads` solely to make the Pages list complete; we do not independently use it to modify a Page's ads.

**Step-by-step instructions:**

> 1. Follow the same steps as `pages_show_list`.
> 2. The dropdown is correctly populated only when BOTH `pages_show_list` AND `pages_manage_ads` are granted.

### 3.6 `pages_read_engagement`

**How will your app use this permission?**

> Required by Meta alongside `pages_show_list` for the Pages list to be returned. We do not read engagement data separately — the permission is granted only to satisfy the Pages API precondition.

**Step-by-step instructions:**

> 1. Follow the same steps as `pages_show_list`.
> 2. Without this permission, Meta's API fails to return the Pages list and the Page picker in the wizard is empty.

---

## 4. Screencast — scene-by-scene script

Target length: **3-4 minutes.** Record in 1080p+. Narrate every click. Use QuickTime (File → New Screen Recording → Options → enable Internal Microphone), Loom, or ScreenStudio.

### Scene 1 — Context (0:00 - 0:20)

Show: Browser landing on `https://app.staging.rsoc.app` (logged out).

Say:
> "This is KNN Syndicate, a self-hosted platform where media buyers manage and launch their own Facebook ad campaigns on ad accounts they own. In this video I'll show how our app uses each Facebook permission we're requesting. I'm starting from logged out, as a fresh buyer."

### Scene 2 — Buyer logs in (0:20 - 0:35)

Show: Click Login → enter `buyer@demo-review.rsoc.app` / `DemoReview2026!` → arrive at empty dashboard.

Say:
> "I've just logged into our dashboard as a media buyer. The dashboard is empty because I haven't connected a Facebook ad account yet. I'll do that next."

### Scene 3 — Facebook connect flow (0:35 - 1:30)

Show: Navigate to `/dashboard/facebook` → click **Connect a profile** → Facebook OAuth dialog → log in with the Tester account → consent screen listing all 6 permissions → grant → redirect back → ad accounts, pages, pixels list populates.

Say:
> "I'm clicking Connect, which starts the Facebook Login for Business OAuth flow. Our app requests all six permissions we're submitting today — `ads_management` so the buyer can launch and manage their own campaigns; `ads_read` to show them performance data; `pages_show_list`, `pages_manage_ads`, and `pages_read_engagement` so the buyer can pick which Facebook Page their ads run under; and `business_management` so we can enumerate the ad accounts in their Business Manager. I'm granting all of them."
>
> *(After redirect)*
>
> "Our app has now called the Graph API and populated this screen with the buyer's Business Managers, their ad accounts, and their Facebook Pages. This data comes from the `business_management` and `pages_show_list` permissions. We store this metadata encrypted at rest and only the buyer who connected can see it."

### Scene 4 — Launching a campaign (1:30 - 2:45)

Show: Campaigns → **Create campaign** → fill wizard (name, objective, $5 budget, India audience, 1 ad creative) → page picker dropdown opens → show the Page list → pick one → Launch → wait for success screen → open a new tab, go to Facebook Ads Manager as the same user, show the campaign exists.

Say:
> "Now I'll walk through creating a campaign. The buyer picks an objective, a daily budget, a target audience, uploads a creative. Here's the Page picker — notice it shows every Facebook Page the buyer can advertise with. This dropdown is the direct result of `pages_show_list` combined with `pages_manage_ads` and `pages_read_engagement`. Without the latter two, Meta's API only returns pages already wired for ads, so the picker would be incomplete."
>
> *(Clicking Launch)*
>
> "When the buyer clicks Launch, our app uses the `ads_management` permission to create the campaign, ad sets, and ads directly in the buyer's own Facebook ad account. All writes go through the buyer's own token, scoped to their own ad account — we never touch another user's data."
>
> *(Switch tabs to Facebook Ads Manager)*
>
> "You can see here in the buyer's own Facebook Ads Manager — the campaign we just launched now exists on Facebook, ready to deliver."

### Scene 5 — Analytics (2:45 - 3:30)

Show: Analytics tab → show the campaign with real spend/impression/click numbers → hover a few rows.

Say:
> "Finally, the Analytics page. These spend, impression, and click numbers are pulled every hour from the buyer's own Facebook Insights API using the `ads_read` permission. The buyer sees performance data only for ad accounts they've connected and granted us access to. We never aggregate across buyers or sell this data."

### Scene 6 — Close (3:30 - 3:50)

Show: Settings → Disconnect Facebook → confirmation message.

Say:
> "If the buyer wants to disconnect at any time, they revoke our access from this page. We also delete their stored tokens immediately. Thank you for reviewing."

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

- [ ] Business Verification shows "Verified"
- [ ] App Settings → Basic has: Privacy Policy URL, Terms URL, App Icon 1024×1024, Contact Email, App Domains
- [ ] App Mode can stay Development (reviewers test as Tester)
- [ ] The record-with FB user is added as Tester
- [ ] Screencast uploaded (unlisted YouTube or Loom link), 1080p+, 3-4 min, narrated, English, no cuts in the middle of a scene
- [ ] For each of the 6 permissions, filled: Usage description + Step-by-step + Screencast link
- [ ] Submitted as **one** combined review (not one at a time)

Expected first response from Meta: **3-7 business days.**

If a specific permission comes back with a question, the usual root causes are:
- Screencast didn't visibly exercise that permission → re-record scene for it
- Privacy policy didn't mention a specific data category → amend policy, resubmit
- Business Verification still pending → wait for verification, resubmit

---

## 7. Shortcut for a quick staging test today (don't need to wait for approval)

If you want to confirm the OAuth flow actually works end-to-end on staging before the review completes:

1. Add the FB user you'll record with as a **Tester** on the DATA app (Dashboard → Roles → Testers → add).
2. Log in as `buyer@demo-review.rsoc.app` on staging.
3. Click Connect Facebook — OAuth will complete in Development mode because the user is a Tester.
4. This proves the whole code path works. Once Meta approves Advanced Access, the same flow will work for any non-Tester user.
