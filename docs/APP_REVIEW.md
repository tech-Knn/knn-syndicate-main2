# Facebook App Review & Tester Onboarding

How buyers get permission to use our two Facebook apps, and how we eventually remove that friction
by taking the apps **Live** (Advanced Access via App Review).

> Two apps (see `DECISIONS.md` D12–D14, and `CLAUDE.md`): a **DATA** app (long-lived/exchanged
> token — sync + CAPI) and a **LAUNCH** app (un-exchanged login token — publishes ads past
> Facebook's `368 / 3858385` security checkpoint). A buyer must be able to use **both**.

---

## Today: apps are in **Development mode** → every buyer must be a Tester

While an app is in Development mode, only people with a **role** on the app (Admin / Developer /
**Tester**) can log in and grant it permissions. New buyers therefore can't connect until we add
them as a Tester on **both** apps.

**There is no Graph API to add a real person as a Tester.** We confirmed this directly:
`POST /{app_id}/roles` → `400 "Unsupported post request"`. Roles are managed only in the App
Dashboard (`GET /{app_id}/roles` *reads* the roster, but cannot write). Username → ID resolution is
also blocked by Facebook privacy. So onboarding is **Dashboard-assisted**, not fully automated.

### The in-product flow (replaces "DM us your FB ID")

Implemented on the **Facebook** dashboard page (`apps/web/app/dashboard/facebook/page.tsx`),
backed by `apps/api/src/modules/facebook/facebook.service.ts` + `/api/facebook/access*` routes and
the `users.fb_access_status` / `users.fb_handle` columns (migration
`20260602132604_fb_access_onboarding`).

**Buyer's view** — a 3-step checklist, shown until they've connected a profile:

1. **Share your Facebook profile** — buyer pastes their profile URL/username → status `REQUESTED`.
2. **We add you as a tester** — pending until a super-admin adds them; a **Re-check** button
   re-polls their status.
3. **Approve the invites, then connect** — once `INVITED`, the buyer gets:
   - **Approve invites on Facebook ↗** → `https://developers.facebook.com/settings/developer/requests/`
   - **Connect main** / **Connect launch app** buttons.

**Super-admin's view** — an **Access requests** queue on the same page:

- Lists every buyer with status `REQUESTED` / `INVITED` (name, email, org, pasted FB handle).
- **Add on main app ↗** / **Add on launch app ↗** deep-link straight to each app's Roles page
  (`https://developers.facebook.com/apps/{app_id}/roles/roles/`).
- **Mark invited** flips the buyer to `INVITED` (their checklist advances to step 3).

State machine: `NONE → REQUESTED` (buyer submits) `→ INVITED` (super-admin adds + marks)
`→ connected` (buyer approves on FB + connects; derived from `FbConnection` count, not stored).

### Super-admin runbook (per new buyer)

1. Open **Dashboard → Facebook → Access requests**.
2. For the buyer, click **Add on main app ↗**. On the FB Roles page: **Add People → Testers**,
   paste/select their profile, send. Repeat with **Add on launch app ↗**.
3. Back in the dashboard, click **Mark invited** on that buyer.
4. Tell the buyer to approve both invites at the link in their checklist, then connect.

> Tester invites occasionally don't surface under *Requests*; if so, the buyer should check
> `https://developers.facebook.com/apps/` (the app will appear once they're a tester) or accept via
> the notification. Account-level (not just app-level) — the person must accept with the **same**
> Facebook account they log into our tool with.

---

## The fix: take both apps **Live** (App Review → Advanced Access)

Once an app is **Live** with **Advanced Access** to the permissions below, *any* Facebook user can
grant them — **no Tester role required**, and the whole onboarding checklist above becomes
unnecessary. This is the real solution; the Tester flow is the bridge until we get there.

### Permissions we request (per app)

| Permission | DATA app | LAUNCH app | Why |
|---|:--:|:--:|---|
| `ads_management` | ✅ | ✅ | Read ad accounts; create/update/pause campaigns, ad sets, ads. |
| `ads_read` | ✅ | — | Insights / results polling. |
| `business_management` | ✅ | ✅ | Resolve assets owned via Business Manager. |
| `pages_show_list` | ✅ | ✅ | List Pages to attach to ads. |
| `pages_read_engagement` | ✅ | — | Page metadata used in the launcher. |
| `public_profile`, `email` | ✅ | ✅ | Identify the connected profile. |

> Reconcile this table with the actual scopes requested in `getAuthUrl` before submitting —
> request **only** what we use; unused permissions get rejected and slow review.

### Submission checklist

- [ ] **Business Verification** complete for the owning Business (legal name, address, docs).
- [ ] App has a **Privacy Policy URL** and a **Data Deletion** URL/callback (public, reachable).
- [ ] **App icon**, category, and a real **App Domain** + valid OAuth redirect URIs set.
- [ ] App is **not** in Development mode (toggle to Live) before requesting Advanced Access — or
      request Advanced Access in the same submission.
- [ ] For each permission above: written **use-case** description + a **screencast** showing the
      exact in-product flow (login → grant → the feature working) with a **test user / test ad
      account** Facebook reviewers can use.
- [ ] Screencast shows the **two-app** model honestly: main connection for sync/results, launch
      connection for publishing.
- [ ] **App Review → Permissions and Features**: each permission shows **Advanced Access**
      (not just Standard/Development) after approval.
- [ ] Repeat the **entire** submission for **both** apps (review is per-app).

### After approval

- [ ] Both apps switched to **Live**.
- [ ] New buyers connect directly — the in-product **Tester** checklist no longer appears for them
      (it self-hides once they connect, and step 1–2 become moot once apps are Live).
- [ ] Keep the **Access requests** queue + Dashboard runbook as a fallback for any app that is
      ever reverted to Development for testing.

---

## References

- DATA app id `906408948523489` ("Seedhe Maut") · LAUNCH app id `795279507000746` ("RSOC APP").
- Roles page (add testers): `https://developers.facebook.com/apps/{app_id}/roles/roles/`
- Buyer approves invites: `https://developers.facebook.com/settings/developer/requests/`
- Why two apps: `DECISIONS.md` (D12–D14) and the token model in `CLAUDE.md`.
