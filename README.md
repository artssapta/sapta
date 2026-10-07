# SAPTA Website & Admin

The SAPTA website ([saptaarts.org](https://saptaarts.org)), its online admin for events, photos, videos and registrations, and the Cloudinary media pipeline.

**Repository:** [artssapta/sapta](https://github.com/artssapta/sapta) (public) · **Publishing branch:** `main`

> **This repository is public.** Never commit `.env`, `.dev.vars`, tokens, passwords or API secrets. Secrets live in Cloudflare (production) and in the git-ignored `.env` (local).

---

## Quick reference

| I want to… | How |
|------------|-----|
| Edit events, photos, registrations | Open the admin URL (see [Hosted admin](#hosted-admin)) → **Login with Gmail** as `artssapta@gmail.com` |
| See the live site | [saptaarts.org](https://saptaarts.org) — updates ~2–3 minutes after each save |
| Check the admin's connections | Admin → **Status** tab |
| Work on the code | `npm ci`, then `npm run dev` (site, :4321) / `npm run admin` (admin, :4322) / `npm test` |
| Deploy admin code changes | Automatic on push to `main` (once set up), or `npm run admin:deploy` |

---

## How it fits together

```
Team member's browser
   │  Login with Gmail (only artssapta@gmail.com)
   ▼
SAPTA admin — Cloudflare Worker (admin/worker.mjs)
   │  ├─ signs each upload ──► browser uploads straight to Cloudinary
   │  │                         (sapta/events/<event>/, signed, retried, chunked)
   │  └─ Save = commit to "drafts" ──► Cloudflare Pages: preview site
   │     Publish = merge drafts → "main"
   ▼                                   │
                                       ▼  GitHub Actions: npm test → astro build
                              GitHub Pages: saptaarts.org (photos served by Cloudinary)
```

- **Website:** Astro builds static pages from `src/content/`; `.github/workflows/deploy.yml` tests, builds and publishes every push to `main`.
- **Admin:** runs on Cloudflare Workers (free plan: no server to maintain, no sleeping, HTTPS included). Nobody installs anything.
- **Media:** Cloudinary (`dkudoatww`) stores and serves photos and video clips.
- **Pages CMS** (`app.pagescms.org`) still works as an alternative editor; it saves to the same files.

---

## Using the admin

1. Open the admin URL and click **Login with Gmail**; choose `artssapta@gmail.com`. Other accounts see "This account does not have access."
2. **Add New Event** → type the title (the identifier, e.g. `navaratri-utsav-2026`, is filled in and also names the event's Cloudinary folder).
3. **Upload Photos** — select all photos at once. They are placed in file-name order (`IMG_2` before `IMG_10`; phones name photos in the order taken), uploaded three at a time, and each row shows progress. Failed rows have **Retry**; ✕ on a photo you just uploaded also deletes it from Cloudinary. Use ↑ / ↓ to reorder.
4. **Upload Flyer**, and **Upload Clips** for short videos (MOV is converted to MP4). Use **YouTube Link** for full concerts.
5. **Save Event** — this saves a **draft**. Nothing changes on the website yet.
6. The yellow bar lists every unpublished change. **Preview website** opens a copy of the site that includes your drafts (it updates about 1–2 minutes after each save). **Discard** throws one draft away; **Publish to website** makes all of them live (about 2–3 minutes).

If someone else saved the same event after you opened it, your save is stopped (nothing is overwritten): reload and make the change again.

### Folders

Every event has its own folder automatically, and anyone can make extra folders that are not tied to an event (for rehearsals, posters, press photos…):

```text
Cloudinary: sapta/
  events/                ← one per event, created with the event (🎵 in the admin)
    eka/
    go-rakshana/
    svasthya/
    unsorted/            ← uploads made without choosing a folder
  folders/               ← your own folders (📁 in the admin)
    Rehearsals 2026/
    …
```

In the **Media Library** tab:
- Pick a folder to see its files; uploading while a folder is selected puts the files there.
- **＋ New folder** creates a folder; select it to **Rename** it or **Delete folder** (only when empty). Event folders are named after their event and are managed with it.
- **Move to…** on any Cloudinary file files it in another folder.
- **Not in a folder** shows uploads that aren't filed anywhere; uploads that no event uses can be deleted.

Moving files or renaming folders never changes a file's web address, so nothing on the website breaks. Files used by an event cannot be deleted — remove them from the event and publish first. The event editor's **Pick from Library** can browse every folder.

Limits (Cloudinary free plan): photos 10 MB, videos 100 MB. Change `MAX_PHOTO_MB` / `MAX_VIDEO_MB` in `wrangler.jsonc` if the plan is upgraded.

---

## Hosted admin

### One-time setup

You need: the Cloudflare account that will host the admin (free, no card), the `artssapta` GitHub account, the Cloudinary account, and the Google Cloud project used for "Login with Gmail".

**1. Cloudinary API key.** Cloudinary Console → Settings → **API Keys** → *Generate New API Key*. Keep the key and secret for step 4. Then, under Settings → Upload → Upload presets, delete any **unsigned** preset (e.g. `sapta_preset`) — the admin only uses signed uploads.

**2. GitHub access token** (lets the admin save content). Signed in to GitHub **as `artssapta`**: Settings → Developer settings → **Fine-grained personal access tokens** → *Generate new token*:
- Resource owner: `artssapta`; Repository access: **Only select repositories → `artssapta/sapta`**
- Permissions → Repository → **Contents: Read and write** (Metadata: read-only is added automatically). "Read-only" is not enough: the admin then cannot save, and the Status tab says so.
- Expiration: up to 1 year. Put a calendar reminder to renew it (see [Maintenance](#maintenance)).

**3. Deploy the Worker** (from this repository, once):
```bash
npx wrangler login
```
```bash
npx wrangler deploy
```
Note the URL it prints, e.g. `https://sapta-admin.<your-subdomain>.workers.dev`.

**4. Add the secrets** (each command prompts for the value; nothing is stored in the repository):
```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```
```bash
npx wrangler secret put GITHUB_TOKEN
```
```bash
npx wrangler secret put CLOUDINARY_API_KEY
```
```bash
npx wrangler secret put CLOUDINARY_API_SECRET
```
```bash
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
```

**5. Allow the admin address in Google.** Google Cloud Console → Google Auth Platform → **Clients** → the SAPTA client → *Authorised redirect URIs* → add `https://sapta-admin.<your-subdomain>.workers.dev/auth/google/callback` (keep the localhost one for local use).

**6. Check.** Open the admin URL, log in, and open the **Status** tab: both *Saving* and *Cloudinary* should show ✓.

**7. Preview site for drafts.** Cloudflare dashboard → **Workers & Pages** → *Create* → **Pages** → *Connect to Git* → authorise GitHub as `artssapta` → select `artssapta/sapta`. Settings:
- Project name: `sapta-preview` (the address becomes `https://sapta-preview.pages.dev`; if the name is taken, Cloudflare shows the actual address)
- **Production branch: `drafts`**; Framework preset: Astro; Build command `npm run build`; Output directory `dist`
- Environment variable `NODE_VERSION` = `22`
- After the first build: Settings → Builds → *Branch control* → **None** for preview branches (only `drafts` is built)

Then set `"PREVIEW_URL": "https://sapta-preview.pages.dev"` in `wrangler.jsonc` and run `npm run admin:deploy`. The preview copy sends a `noindex` header (`public/_headers`), so search engines ignore it. Note: the repository is public, so draft content on the `drafts` branch is publicly readable on GitHub.

**8. (Optional) Automatic admin deploys.** In GitHub → artssapta/sapta → Settings → Secrets and variables → Actions, add `CLOUDFLARE_API_TOKEN` (Cloudflare → My Profile → API Tokens → template *Edit Cloudflare Workers*) and `CLOUDFLARE_ACCOUNT_ID`. `.github/workflows/deploy-admin.yml` then redeploys the admin whenever its code changes.

**Custom address (optional).** To use e.g. `admin.saptaarts.org`, add it as a Custom Domain on the Worker in Cloudflare (requires the domain's DNS to be on Cloudflare), set `"PUBLIC_URL": "https://admin.saptaarts.org"` in `wrangler.jsonc`, redeploy, and add the matching redirect URI in Google.

### Configuration reference

| Name | Where | Purpose |
|------|-------|---------|
| `GOOGLE_CLIENT_ID` | `wrangler.jsonc` | Google OAuth client (public) |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth client secret |
| `ADMIN_GOOGLE_EMAILS` | `wrangler.jsonc` | Who may log in (comma-separated). Default `artssapta@gmail.com` |
| `GITHUB_TOKEN` | secret | Fine-grained token, Contents read/write on `artssapta/sapta` |
| `GITHUB_REPO`, `GITHUB_BRANCH` | `wrangler.jsonc` | Where saves are committed (`artssapta/sapta`, `main`) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_FOLDER` | `wrangler.jsonc` | `dkudoatww`, uploads go to `<folder>/events/<event>` |
| `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | secret | Signs uploads; never sent to browsers |
| `SESSION_SECRET` | secret | 32+ random characters; signs login cookies. Changing it signs everyone out |
| `GITHUB_DRAFT_BRANCH` | `wrangler.jsonc` | Branch for drafts (`drafts`). Set to `""` to publish on every save |
| `PREVIEW_URL` | `wrangler.jsonc` | Cloudflare Pages site built from the drafts branch |
| `PUBLIC_URL` | `wrangler.jsonc` (optional) | Admin address if not the workers.dev one |
| `SITE_URL` | `wrangler.jsonc` | Public site, used to preview `/assets/...` images |
| `MAX_PHOTO_MB`, `MAX_VIDEO_MB` | `wrangler.jsonc` | Upload limits (default 10 / 100) |

### Maintenance

- **GitHub token expiry:** when it expires, saving fails and the Status tab says "GitHub access token is invalid or has expired". Create a new one (step 2) and run `npx wrangler secret put GITHUB_TOKEN`.
- **Add or remove an editor:** edit `ADMIN_GOOGLE_EMAILS` in `wrangler.jsonc` and deploy. Removal takes effect immediately, including for people already logged in.
- **A secret leaked:** regenerate it at its source (Google / GitHub / Cloudinary), `wrangler secret put` the new value. For `SESSION_SECRET`, set a new random value to sign everyone out.
- **Logs:** Cloudflare dashboard → Workers → `sapta-admin` → Logs (sign-ins, refusals and errors are logged; no secrets).
- **Undo a change:** before publishing, use **Discard**. After publishing, each publish is one merge commit on `main` ("Publish: …, Published by …"); revert it on GitHub.

---

## Security design

- **Login with Gmail only** — OpenID Connect authorization-code flow with PKCE, `state` and `nonce`; the ID token must come from Google for this client, be unexpired, and carry a **verified** email listed in `ADMIN_GOOGLE_EMAILS`. The artssapta Google account's 2-Step Verification therefore protects the admin — keep it on.
- **Sessions** — HMAC-signed `__Host-` cookie (`Secure; HttpOnly; SameSite=Strict`), 12 hours; the allowlist is re-checked on every request.
- **CSRF** — every change needs a per-session token header, a same-origin `Origin`, and `Sec-Fetch-Site: same-origin`.
- **Uploads** — the browser uploads directly to Cloudinary with a signature from the admin; folder, tags, allowed formats (photos/videos only, no SVG/HTML) and no-overwrite are inside the signature, which expires after an hour. The API secret never reaches the browser.
- **Saving** — validation mirrors `src/content.config.ts` (a save can't break the site build); identifiers are `[a-z0-9-]` only; media must be this Cloudinary account's URLs or existing `/assets/`, `/uploads/` files; saves name the version they started from, so concurrent edits are never silently overwritten; the GitHub token is limited to one repository's contents.
- **Browser hardening** — CSP `script-src 'self'`, no inline script, all content escaped; `frame-ancestors 'none'`, HSTS, `nosniff`; unknown Host headers refused.

---

## Local development

```bash
npm ci
```
```bash
cp .env.example .env
```

- `npm run dev` — website at http://localhost:4321
- `npm run admin` — the same admin at http://localhost:4322, saving to the **files in this checkout** (commit and push to publish). Set `CONTENT_STORE=github` and `GITHUB_TOKEN` in `.env` to save to GitHub instead. Needs `http://localhost:4322/auth/google/callback` as a redirect URI in Google.
- `npm run admin:dev` — the admin in Cloudflare's local runtime (`wrangler dev`, reads `.dev.vars`)
- `npm test` — unit and integration tests (Google, GitHub and Cloudinary are simulated; no network)
- `npm run build` / `npm run preview` — production build of the site

### Code layout

```text
admin/
  worker.mjs                 Cloudflare entry point
  core/app.mjs               routes, auth checks, security headers (runtime-independent)
  core/config.mjs            configuration and validation
  core/google.mjs            Login with Gmail (OIDC + PKCE)
  core/session.mjs           signed session cookies
  core/cloudinary.mjs        upload signing, media listing, health check
  core/content.mjs           event/registration validation and YAML
  core/stores/github.mjs     saves = commits via the GitHub API
  core/stores/fs.mjs         local files (development, tests)
  public/                    admin page: index.html, admin.js, shared/cloudinary-url.mjs
admin-server.mjs             local Node server for the same app
wrangler.jsonc               Worker configuration (no secrets)
tests/                       node:test suites
src/content/events/          one Markdown file per event
src/components/blocks/Events.astro   event layouts, gallery, lightbox
src/lib/media.mjs            video/registration URL helpers, Cloudinary delivery URLs
```

### Admin API

All `/api/*` routes except `/api/me` need a session; changes also need `X-CSRF-Token`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/auth/google/start`, `/auth/google/callback` | `GET` | Login with Gmail |
| `/auth/logout` | `POST` | Log out |
| `/api/me` | `GET` | Current user, CSRF token, limits |
| `/api/status` | `GET` | GitHub and Cloudinary connection checks |
| `/api/events` | `GET` / `POST` | List / create (`isNew`) or update (`version`) |
| `/api/events/:id?version=` | `DELETE` | Delete an event |
| `/api/registrations`, `/api/registrations/:id` | `GET` / `POST` | Registration settings |
| `/api/media` | `GET` | Media by event folder: used by events, in Cloudinary (tag `sapta`), and website files |
| `/api/media/delete` | `POST` | `{urls}` → deletes uploads no event uses (admin uploads only) |
| `/api/media/move` | `POST` | `{url, to}` (`event:<id>`, `custom:<name>` or `none`) → move a file to a folder |
| `/api/folders` | `POST` | `{name}` → create a folder |
| `/api/folders/rename`, `/api/folders/delete` | `POST` | `{from, to}` / `{name}` → rename, or delete if empty |
| `/api/drafts` | `GET` | Unpublished changes and preview status |
| `/api/drafts/publish` | `POST` | `{head}` → publish all drafts (refused if they changed since `head`) |
| `/api/drafts/discard` | `POST` | `{kind, id}` or `{all: true}` → restore the live version |
| `/api/uploads/sign` | `POST` | `{kind, event, filename, size}` → signed Cloudinary upload parameters |

---

## Content model

### Events (`src/content/events/<id>.md`)
```yaml
---
title: Svāsthya
order: 1                 # lower numbers appear first
status: upcoming         # upcoming | past
subtitle: Harmony in Sound, Healing in Purpose
date: August 29, 2026
time: 2 PM - 4 PM
location: Sri Karpaga Ganapathi Temple, San Ramon, CA
description: ...
flyerImage: https://res.cloudinary.com/dkudoatww/image/upload/v1/sapta/events/svasthya/flyer.jpg
gallery:                 # displayed in this order
  - src: https://res.cloudinary.com/dkudoatww/image/upload/v1/sapta/events/svasthya/IMG_0001.jpg
    alt: Opening invocation
videos:
  - title: Full concert
    source: youtube
    videoUrl: https://www.youtube.com/watch?v=...
  - title: Short clip
    source: upload
    file: https://res.cloudinary.com/dkudoatww/video/upload/v1/sapta/events/svasthya/clip.mp4
---
```
On the website, Cloudinary photos are delivered with `f_auto,q_auto,c_limit,w_1600` (modern format, automatic quality, ≤1600 px); the stored link stays the original.

### Registrations (`src/content/registrations/group.md`, `spotlight.md`)
```yaml
---
title: Group Registration
status: coming-soon      # coming-soon | open
message: Registration for the next season opens soon.
url: https://forms.gle/...   # required when open
---
```

---

# Handover notes (October 2026)

> Historical notes from the Pages CMS handover. The hosted admin described above is now the primary editor; Pages CMS remains available.

## 1. Current status


The website changes have been committed, pushed to GitHub, and successfully deployed to GitHub Pages. The deployment containing the new editor integration is [run 37483270627](https://github.com/artssapta/sapta/actions/runs/37483270627).

The implementation commit is [`b321e6a`](https://github.com/artssapta/sapta/commit/b321e6a5fb38a5437bf149a5783c42def421c19f), titled **Add team content editor and coming-soon registrations**.

Completed:

- Both registration pages now show **Coming soon**, with the old registration links removed from those pages.
- Events are stored as separate editable records.
- The online editor has forms for event details, photos, videos, and registration settings.
- New media entries are connected to the existing event layouts.
- The website includes a **Team editor** link in the footer.
- Pages CMS has been connected to the `artssapta/sapta` GitHub repository.
- The SAPTA project and its editing sections were visible in Pages CMS after connection.
- An invitation was sent to **artssapta@gmail.com**, and Pages CMS confirmed the invitation.

Still awaiting confirmation:

- Acceptance of the invitation by the recipient.
- A complete editing session as the invited account, including saving an upload and seeing it appear on the live website.

The owner connection and invitation are confirmed. Successful invitation delivery to the inbox, invitation acceptance, and a collaborator's first successful save have not been independently verified.

## 2. Useful links

- [Public website](https://saptaarts.org/)
- [Events](https://saptaarts.org/events/)
- [Group registration](https://saptaarts.org/registration/group/)
- [SAPTA Spotlight registration](https://saptaarts.org/registration/spotlight/)
- [Team editor entry page](https://saptaarts.org/admin/)
- [Pages CMS sign-in](https://app.pagescms.org/)
- [SAPTA project in Pages CMS](https://app.pagescms.org/artssapta/sapta/main)
- [Deployment history](https://github.com/artssapta/sapta/actions)
- [Short everyday editing guide](HOW_TO_ADD_NEW_EVENTS.md)

## 3. Website and design changes

### Navigation and Events access

The desktop navigation, mobile navigation, and homepage **View Events** link were updated to point to `/events/` consistently.

This documents the actual link changes. The earlier Events navigation problem was reported by the user; changing the link format alone does not establish the original cause of that problem.

The registration navigation now includes both **SAPTA Spotlight** and **Group Registration**. Its desktop control was changed from a text span into a button, with a click handler and expanded-state attributes. Keyboard focus can also expose the dropdown. Native button styling was reset to fit the navigation.

### Event layouts

Events without gallery photos or videos now use the available width for their information and flyer instead of leaving an empty media column. The layout becomes a single column on smaller screens.

Events that have photos or videos use the media layout even if their status is Upcoming. The displayed status and video heading follow the event's status.

The Go-Rakshana detail page now loads the actual Go-Rakshana event record instead of rendering without the intended event data.

### Registration design

Both registration pages now use a shared component with:

- A clear page title and status.
- A short message for visitors.
- A restrained cream, blue, and gold presentation consistent with the site.
- Links back to events and contact information.
- A registration button only when availability is Open and a valid HTTPS link exists.

The old embedded registration forms were removed from these two pages. When registration reopens, the new form opens in a separate tab through a clearly labeled button.

### Team editor entry page

The new `/admin/` page provides:

- A link to sign in to Pages CMS.
- An overview of the events and their photo/video counts.
- Instructions for uploading media into the correct event.
- An overview of registration availability.
- First-time setup guidance for the website owner.

It uses the site's visual style and is marked `noindex, nofollow`. That setting asks search engines not to index it; it is not an access-control mechanism.

### Scope of visual work

The work improved navigation, registration pages, editor guidance, and event layouts while keeping the existing website design. A complete replacement of the site's branding, typography system, imagery, or every page was not performed. The hero content schema was also extended to recognize the existing `showDonate` setting.

## 4. How the online editing system works

The website uses **Astro** to build static pages, **GitHub Pages** to host them, and **Pages CMS** as the authenticated online content editor.

The publishing sequence is:

1. An authorized person signs in to Pages CMS.
2. They select the SAPTA project on the `main` branch.
3. They edit an event or a registration entry and save it.
4. Pages CMS writes the changes to the GitHub repository.
5. The existing GitHub Actions workflow builds the website.
6. GitHub Pages publishes the successful build.
7. Visitors see the updated content after deployment and refresh.

Updates are not immediate. Allow a few minutes for publishing to finish.

There is no new custom application server or custom password database hosted on GitHub Pages. Pages CMS provides the authenticated editing service; GitHub stores the website content and media; the published website displays the generated pages.

## 5. Login, accounts, and access

### Owner connection

The GitHub account used for the confirmed connection and publishing work was **krishnabandhu1234-bot**. The website repository remains **artssapta/sapta**.

The user completed the Pages CMS GitHub connection. Afterward, the SAPTA project and its Events, Registration, Media, and Admin sections were visible in the editor.

### Team invitation

An invitation was sent to **artssapta@gmail.com** after explicit approval. Pages CMS displayed a confirmation that the address was invited to `artssapta/sapta`.

To begin using it:

1. Open the invitation email sent to that address.
2. Follow the invitation and sign-in instructions.
3. Open the SAPTA project.
4. Use the event or registration editing sections.

The sign-in page offers GitHub sign-in and email sign-in. Team collaborators can be invited by email without being given the owner's GitHub credentials.

### Password handling

Pages CMS uses its own sign-in (GitHub or email invitation). The SAPTA admin uses Login with Gmail and only admits `artssapta@gmail.com`; no password is stored anywhere in the repository.

### Access boundaries

- The public `/admin/` page contains guidance and a sign-in link.
- Editing requires access through Pages CMS.
- Invited collaborators can edit the content and media available to them.
- Configuration and collaborator administration remain restricted to eligible GitHub users.
- No GitHub token or website-editing password was added to the public site.

See [Pages CMS collaborator documentation](https://pagescms.org/docs/configuration/collaborators/) for the service's access model.

## 6. How to add photos

1. Open the [team editor](https://saptaarts.org/admin/) and sign in.
2. Select the SAPTA project and `main` branch.
3. Open **Events, photos & videos**.
4. Select the event receiving the photos.
5. Find **Event gallery — add photos here**.
6. Add a photo entry and upload or select its image.
7. Enter a short photo description for screen readers and identification in the editor.
8. Drag entries into the desired order.
9. Save the event and wait for publishing.

The image is placed in the selected event's existing gallery and lightbox. The editor does not infer the event from a filename: selecting the event determines the destination.

Uploading a file to the media library alone does not attach it to a page. It must also be selected in the event's gallery field, and the event must be saved.

Supported image extensions in the configuration are JPG, JPEG, PNG, WebP, and AVIF. New photo uploads are stored under `public/uploads/photos/`, with public paths beginning `/uploads/photos/`. Randomized upload names help avoid filename collisions.

## 7. How to add videos

Open the desired event and find **Event videos — add performances here**. Add a title and choose the source.

### YouTube

1. Select **YouTube link**.
2. Paste the video's HTTPS YouTube link.
3. Save the event.

The website's URL helper supports common watch, share, Shorts, live, and embed URL formats. It renders supported YouTube videos through `youtube-nocookie.com` embeds and loads the iframe lazily.

### Uploaded video

1. Select **Upload a short video**.
2. Select or upload an MP4 or WebM file.
3. Save the event.

Uploaded clips appear in a browser video player with controls. The player supports inline playback and loads metadata before playback. New files are stored under `public/uploads/videos/`.

Only the selected source is used, even if both the YouTube field and upload field contain values.

### Video limits

Use short uploads and YouTube links for long performances. The site does not compress, transcode, or stream video through a dedicated video service. Playback depends on a compatible browser codec; H.264 MP4 is a practical choice for uploaded clips.

Uploads are subject to Pages CMS and GitHub limits. GitHub Pages also has a published-site size limit; consult the [official limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) before adding large media collections. No separate paid media storage or transcoding service was configured.

## 8. How to manage registration links

Two independent editor entries are available:

- **Group registration**
- **SAPTA Spotlight registration**

Each has a title, availability, message for visitors, and registration form link.

### Keep registration closed

Set availability to **Coming soon** and save. Visitors see the message without a registration button. Both pages were published in this state.

### Open registration

1. Open the relevant registration entry.
2. Paste the new form URL, beginning with `https://`.
3. Update the message for visitors.
4. Set availability to **Open**.
5. Save and wait for deployment.

The public button opens the form in a new tab. HTTPS shortened Google Forms links can be used.

The build validates that an Open registration has a valid HTTPS URL. This validates URL structure, not whether the destination form is accepting responses. The team should check the destination itself before opening registration.

Switch availability back to **Coming soon** to hide the link again.

## 9. How to create and maintain events

Use **Add an entry** in **Events, photos & videos**. Enter:

- Event name.
- Display order: lower numbers appear first.
- Status: Upcoming or Past event.
- Date.
- Optional time, venue, subtitle, and description.
- Event flyer.
- Optional gallery photos and videos.

Save the entry to include it in the existing Events page. Status does not change automatically when a date passes; update it manually.

The migrated records are Svāsthya, Eka, and Go-Rakshana. Existing event details, 29 gallery photo references, and two recording references were preserved during migration. Svāsthya was set to Past as part of the earlier event update.

New event entries populate the Events page; a separate standalone URL for every new event is not automatically generated by this implementation. The existing Go-Rakshana standalone page remains available.

## 10. Main files and responsibilities

```text
.pages.yml                           Online editor forms and media destinations
src/content.config.ts                Content collections and validation
src/lib/media.mjs                    Video URL and registration URL helpers
src/content/events/                  One Markdown record per event
  svasthya.md
  eka.md
  go-rakshana.md
src/content/registrations/            Registration availability and links
  group.md
  spotlight.md
src/content/pages/events.md          Events page heading/block configuration
src/components/Registration.astro    Shared public registration presentation
src/components/blocks/Events.astro   Event details, photos, videos, and layouts
src/components/blocks/Hero.astro     Homepage hero and Events link
src/components/Layout.astro         Navigation, footer, and page metadata
src/pages/admin/index.astro          Public team editor entry page
src/pages/registration/              Public registration routes
src/pages/events/go-rakshana.astro   Existing standalone event route
public/uploads/photos/              New image uploads
public/uploads/videos/              New video uploads
.github/workflows/deploy.yml         Automatic build and GitHub Pages deployment
tests/media.test.mjs                 Focused URL-helper tests
HOW_TO_ADD_NEW_EVENTS.md             Short operational guide
```

The old `src/content/pages/reg-group.md` and `reg-spotlight.md` records were removed and replaced by the registrations collection. The previously nested event data in `src/content/pages/events.md` was moved into separate event records.

Other pre-existing pages and content, such as the homepage, team profiles, and feedback form, remain in the project. The current CMS configuration exposes event and registration editing; it does not provide an editing form for every page or team profile.

## 11. Local development

The project uses Astro, declared in `package.json` as `^6.3.3`. The deployment workflow uses Node.js 22.

Install dependencies and start the local website:

```sh
npm ci
npm run dev
```

The normal local address is `http://localhost:4321/`; use the address printed by Astro if that port is occupied.

Create a production build and preview it:

```sh
npm run build
npm run preview
```

The `admin` and `dev:all` scripts run the local admin server described at the top of this README. It only runs on the maintainer's computer; team members without a local setup should use Pages CMS.

## 12. Publishing and recovery

The existing workflow runs on pushes to `main`, installs dependencies, builds the site, uploads the generated `dist` artifact, and deploys it to GitHub Pages.

A save on another branch does not trigger this production workflow. Always check the selected branch before editing.

If a change does not appear:

1. Confirm that the event or registration entry was saved.
2. Confirm that the save was made on `main`.
3. Inspect the latest run in GitHub Actions.
4. If it is still running, wait for completion.
5. If it failed, inspect the error, correct the content, and save again.
6. Refresh the public page after deployment succeeds.

An invalid content record can stop a new build; the previously successful published site normally remains available.

To recover an unwanted edit, a maintainer can revert its Git commit and publish the corrected version. Removing a photo entry from an event does not necessarily delete the underlying uploaded file. Be careful when deleting files that another entry may reference.

## 13. Checks performed and their limits

Completed during implementation:

- A local production build succeeded and generated seven routes.
- Four focused URL-helper tests passed, covering supported video formats and rejection of unsafe or unsupported URLs.
- A migration comparison confirmed preservation of existing event details, 29 gallery photos, and two recording references.
- The local registration page was inspected and showed Coming soon without the old embedded form.
- The local team editor entry page was inspected.
- GitHub Actions successfully built and deployed commit `b321e6a`.
- Pages CMS displayed the connected SAPTA project and its editing sections.
- Pages CMS confirmed the collaborator invitation.

An additional isolated integration build was attempted in a temporary directory. It failed because of an Astro/Vite temporary-path compilation issue, so its simulated upload and registration-change assertions did not complete. That attempt is not evidence of successful end-to-end editing. The normal local build and actual deployment subsequently succeeded.

A real collaborator upload, public video playback across browsers, and invitation acceptance have not been verified. No claim is made that every device, browser, or media file has been tested.

## 14. Remaining work and maintenance notes

- Accept the invitation and complete the first team sign-in.
- Make a small real content update to confirm the full collaborator-to-live-site workflow.
- Keep registrations in Coming soon until the new forms are ready.
- Maintain event dates and statuses manually.
- Monitor media size and use YouTube for long recordings.
- Review deployment failures when content validation rejects an edit.

The publishing commit intentionally excluded unrelated generated files, dependency caches, and unrelated local files. The local checkout may still contain those pre-existing changes; they were not cleaned up as part of this work.

This README is a handover snapshot. The editor content, invitations, and deployment history may change after the date above. This documentation update itself is separate from the earlier published implementation commit.

## 15. References

- [Pages CMS quick start](https://pagescms.org/docs/quick-start/)
- [Pages CMS configuration](https://pagescms.org/docs/configuration/)
- [Pages CMS media configuration](https://pagescms.org/docs/configuration/media/)
- [Pages CMS collaborator access](https://pagescms.org/docs/configuration/collaborators/)
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
