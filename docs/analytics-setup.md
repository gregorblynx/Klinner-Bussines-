# Analytics Setup — Klinner Cleaning & Maintenance

Google Analytics 4 + Microsoft Clarity for <https://www.klinnercleaning.com>.

---

## 1. Important context: this is a static site, not Next.js

This repository is **plain static HTML** (no framework, no `package.json`, no
bundler). The `NEXT_PUBLIC_*` prefix is a **Next.js** convention where the
framework inlines env vars at build time. Nothing here does that automatically,
and a static file **cannot read Vercel environment variables at runtime**.

So the env-var names are kept, and a **tiny build step** does the inlining that
Next.js would normally do:

```
Vercel env vars  ──►  node scripts/inject-analytics.js  ──►  HTML served with real IDs
```

The committed HTML contains only **placeholder tokens**, never real IDs.

### A note on secrets

Nothing secret is involved. A GA4 Measurement ID and a Clarity Project ID are
**public identifiers** — visible in the page source of every site that uses them.
No API key or private credential is part of this setup, and none was added to the
repository. The env vars are used for clean configuration management, not secrecy.

---

## 2. What was installed

| File | Purpose |
| --- | --- |
| `analytics.js` | **New.** The whole tracking engine: loads GA4 + Clarity and fires all conversion events. Contains **no IDs**. |
| `scripts/inject-analytics.js` | **New.** Build step. Replaces the placeholder tokens in every `.html` with the IDs from the Vercel env vars. |
| `vercel.json` | **New.** Tells Vercel to run the build step (`buildCommand`) and keep serving the repo root (`outputDirectory: "."`). |
| `docs/analytics-setup.md` | **New.** This file. |
| `build-blog.js` | **Modified.** The shared `HEAD_COMMON` template now includes the analytics block, so future auto-generated blog posts are tracked automatically. |
| 11 × `.html` pages | **Modified.** Each got a 4-line analytics block before `</head>`. |

The block added to each page:

```html
<!-- klinner-analytics:start (IDs injected at build time from Vercel env vars — see docs/analytics-setup.md) -->
<script>window.KLINNER_ANALYTICS_CONFIG={gaId:"__NEXT_PUBLIC_GA_MEASUREMENT_ID__",clarityId:"__NEXT_PUBLIC_CLARITY_PROJECT_ID__"};</script>
<script src="/analytics.js" defer></script>
<!-- klinner-analytics:end -->
```

Pages covered: `index.html`, the 6 service pages, `privacy.html`, `terms.html`,
`blog/index.html`, and the blog post — plus every future blog post via the
template. (`auditoria-seo-klinnercleaning.html` is an internal audit doc and is
intentionally **not** tracked.)

### Performance

- `analytics.js` is `defer` → never blocks rendering or parsing.
- GA4 (`gtag.js`) and Clarity both load **async**, after the page.
- All click tracking uses **one delegated, passive listener** on `document`.
- If the IDs are missing, the script **no-ops immediately** — nothing loads.

### Safety contract

`scripts/inject-analytics.js` **can never break a deploy**. It always exits `0`,
even on an unexpected error; missing env vars are a warning, not an error. Worst
case the tokens stay unreplaced, `analytics.js` disables itself, and the site
ships exactly as it does today.

---

## 3. How to get your IDs (step by step)

Both are free. Both require signing in with your own account, so these steps have
to be done by you in the browser.

### 3a. Google Analytics 4 → `NEXT_PUBLIC_GA_MEASUREMENT_ID`

1. Go to <https://analytics.google.com> and sign in with the Google account you
   want to own the data. **Use the same Google account as Search Console** if you
   can — it makes linking them (section 7) one click.
2. If you have no account yet: **Start measuring**. Otherwise **Admin** (gear,
   bottom-left) → **Create** → **Property**.
3. **Account setup** (only if new): Account name → `Klinner Cleaning`. Leave the
   data-sharing defaults. **Next**.
4. **Property setup**:
   - Property name: `Klinner Cleaning`
   - Reporting time zone: **United States → (GMT-06:00) Central Time**
   - Currency: **US Dollar (USD)**
   - **Next**.
5. **Business details**: Industry → `Home & Garden` (or similar); Business size →
   smallest. **Next**.
6. **Business objectives**: tick **Generate leads**. **Create** → accept the Terms
   of Service.
7. **Start collecting data** → choose platform **Web**.
8. **Set up data stream**:
   - Website URL: `https://www.klinnercleaning.com`
   - Stream name: `Klinner Website`
   - Leave **Enhanced measurement** ON.
   - **Create stream**.
9. The **Measurement ID** appears top-right of the stream details: **`G-XXXXXXXXXX`**.
   Copy it. ← this is `NEXT_PUBLIC_GA_MEASUREMENT_ID`

> Ignore any "install the tag" instructions Google shows — that is already done in
> `analytics.js`. You only need the ID.
>
> To find it again later: **Admin → Data streams → click the stream**.

### 3b. Microsoft Clarity → `NEXT_PUBLIC_CLARITY_PROJECT_ID`

1. Go to <https://clarity.microsoft.com> → **Sign up** / **Get started**. You can
   sign in with a Microsoft, Google, or Facebook account.
2. Accept the terms → **New project** (if not prompted automatically).
3. Fill in:
   - Name: `Klinner Cleaning`
   - Website URL: `https://www.klinnercleaning.com`
   - Category: `Business & Industrial` (or similar)
   - **Add new project**.
4. Clarity shows install options — choose **Install manually / Install tracking
   code manually**. **Do not paste the code anywhere**; `analytics.js` already
   handles it.
5. Read the ID out of the snippet it shows. It is the value at the end of the
   Clarity URL:

   ```
   t.src="https://www.clarity.ms/tag/" + "abcd1234ef";
                                          ^^^^^^^^^^
                                          this is your Project ID
   ```

   It is a short lowercase alphanumeric string (~10 chars).
   ← this is `NEXT_PUBLIC_CLARITY_PROJECT_ID`

> To find it again later: **Settings → Overview → Project ID**, or read it from
> the browser URL while in the project: `clarity.microsoft.com/projects/view/<ID>/…`

---

## 4. Where to add the environment variables in Vercel

**Vercel Dashboard → your Klinner project → Settings → Environment Variables**

| Name | Value | Environments |
| --- | --- | --- |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | `G-XXXXXXXXXX` | Production, Preview, Development |
| `NEXT_PUBLIC_CLARITY_PROJECT_ID` | `xxxxxxxxxx` | Production, Preview, Development |

Add each with **Add Another** → **Save**.

Then **Deployments → ⋯ → Redeploy** (env vars are read at **build** time, so a
redeploy is required for any change to take effect).

### Build settings

`vercel.json` sets these for you, and **`vercel.json` overrides the dashboard**,
so there is normally nothing to configure:

```json
{
  "buildCommand": "node scripts/inject-analytics.js",
  "outputDirectory": "."
}
```

- **Framework Preset:** `Other`
- **Output Directory `.`** = keep serving the repo root, exactly like today.
- No `package.json`, no dependencies, no `npm install` → the build stays a
  sub-second file rewrite.

### Recommended safe rollout

This adds a build step to a project that currently deploys with none. Roll it out
on a **Preview** deployment first:

1. Push the branch (do **not** merge to `main` yet). Vercel builds a Preview URL.
2. Check the **Build Logs** for the line:
   `[analytics] GA=set  Clarity=set  -> updated 11/12 HTML file(s)`
   (11 of 12 is correct — the 12th is the untracked internal audit page. A `GA=OFF`
   or `Clarity=OFF` here means that env var is missing.)
3. Open the Preview URL and run the checks in sections 5 and 6.
4. Only then merge to `main` to go live.

If anything looks wrong, delete `vercel.json` and the project instantly reverts to
the current zero-config static deploy.

---

## 5. How to verify Google Analytics

1. Deploy, then open the site.
2. **View source** → confirm the block shows a real ID (`gaId:"G-..."`), not
   `__NEXT_PUBLIC_GA_MEASUREMENT_ID__`. If you still see the token, the build step
   did not run — check the Build Command above.
3. **GA4 → Reports → Realtime**: your visit should appear within ~30 seconds.
4. **GA4 → Admin → DebugView** (best for events): install the
   [Google Analytics Debugger](https://chrome.google.com/webstore/detail/google-analytics-debugger/jnkmfdileelhofjcijamephohjechhna)
   extension, then click a phone link and watch `phone_click` arrive live.
5. DevTools → **Network** → filter `collect` → expect requests to
   `google-analytics.com/g/collect` on each event.

> New GA4 properties can take 24–48 h to populate the standard reports.
> Realtime and DebugView are immediate — use those to verify.

## 6. How to verify Microsoft Clarity

1. View source → confirm `clarityId:"..."` holds a real value.
2. DevTools → **Network** → filter `clarity` → expect `clarity.ms/tag/<id>` → 200.
3. **Clarity dashboard → Settings → Setup** shows a "Tracking code detected" status.
4. **Clarity → Recordings**: sessions appear within ~5–10 minutes (not instant).
5. **Clarity → Heatmaps**: needs a bit of traffic before it renders.

---

## 7. Conversion events being tracked

All events fire to **both** GA4 and Clarity (Clarity receives them as custom events).

| Event name | Fires when | Key parameters |
| --- | --- | --- |
| `phone_click` | Any `tel:` link is clicked (25 across the site) | `link_url`, `method` |
| `email_click` | Any `mailto:` link is clicked (14 across the site) | `link_url`, `method` |
| `quote_click` | Any "Request a Quote" CTA — any link to `#quote` (50 across the site), or any element with `data-analytics="quote"` | `link_url`, `link_text` |
| `generate_lead` | The contact/quote form is **successfully** submitted | `form_id`, `source` |
| `service_page_view` | A service page is opened (Airbnb, deep, move-in, move-out, recurring, handyman) | `page_path`, `service` |
| `outbound_click` | Any link to an external domain — covers booking/external contact links | `link_url`, `link_domain`, `link_text` |

Notes:

- **`generate_lead` counts real leads only.** It listens for the `#formSuccess`
  element becoming visible, which only happens after Web3Forms confirms success —
  so failed validation does **not** inflate your conversions. It is also guarded
  against double-counting.
- **`service_page_view`** is *in addition to* the automatic GA4 `page_view`.
- **`outbound_click`** automatically covers any booking tool you add later
  (Calendly, Housecall Pro, WhatsApp, etc.) with no code change.

### Marking these as conversions in GA4

Events are not conversions until you say so:
**GA4 → Admin → Events →** toggle **"Mark as key event"** for `phone_click`,
`quote_click`, and `generate_lead`. The event must have fired at least once before
it appears in that list.

### Adding a new quote button later

Either link it to `#quote`, or add the attribute:

```html
<a href="/wherever" data-analytics="quote">Book Now</a>
```

---

## 8. How to connect Google Search Console

The site is **already verified** — `index.html` carries the verification meta tag:

```html
<meta name="google-site-verification" content="LNGcATtK0ks47JyDxgGTv0sealLAEy-oJYMKUWl-znw" />
```

To finish the setup:

1. Go to <https://search.google.com/search-console>.
2. Add a property. Prefer **Domain** (`klinnercleaning.com`) — it covers `www`,
   non-`www`, http and https in one property. It requires a **DNS TXT record**
   added wherever the domain's nameservers live (Vercel DNS or your registrar).
   The simpler **URL prefix** option (`https://www.klinnercleaning.com`) can reuse
   the existing meta tag above.
3. **Submit the sitemap:** Search Console → **Sitemaps** → enter `sitemap.xml` →
   Submit. (`robots.txt` and `sitemap.xml` already exist at the site root.)
4. **Link GA4 to Search Console:** GA4 → **Admin → Product links → Search Console
   links → Link**. Then in Reports, enable the *Search Console* report collection
   (Reports → Library → publish the "Search Console" collection) to see queries and
   landing pages inside GA4.

---

## 9. How to update or remove tracking later

### Change an ID

Update the value in **Vercel → Settings → Environment Variables**, then
**Redeploy**. No code change needed.

### Turn analytics off (fastest)

Delete (or blank) the two env vars in Vercel and redeploy. The tokens resolve to
empty strings, `analytics.js` no-ops, and **no** GA/Clarity code loads. The site is
unaffected.

### Turn off just one provider

Remove only that provider's env var. The other keeps working.

### Add or change a tracked event

Edit `analytics.js` only — it is the single source of truth for all events.

### Remove analytics completely

1. Delete `analytics.js`, `scripts/inject-analytics.js`, and `vercel.json`.
   (Deleting `vercel.json` reverts Vercel to the original no-build static deploy.)
2. Remove the `klinner-analytics:start … :end` block from the 11 HTML pages and
   from `HEAD_COMMON` in `build-blog.js`.
3. Delete the env vars in Vercel and redeploy.

### Local development

Analytics is **off by default locally** — the tokens are never replaced, so
`analytics.js` no-ops. That is intentional: it keeps your own visits out of the
reports. Do **not** run `node scripts/inject-analytics.js` by hand unless you
intend to bake IDs into your working-tree HTML (Vercel runs it for you on every
deploy).
