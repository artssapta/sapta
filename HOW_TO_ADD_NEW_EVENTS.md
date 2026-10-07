# SAPTA Team Editor & CMS

SAPTA provides two easy ways to edit events, upload photos, and update registration links:

1. **SAPTA Admin (recommended — nothing to install)**:
   - Open the admin address (see README → "Hosted admin") and click **Login with Gmail**, choosing the **artssapta@gmail.com** account.
   - **+ Add New Event** → type the title → **Upload Photos** (select all photos at once) → **Upload Flyer** → **Save Event**. Photos go to Cloudinary in a folder for that event and are shown in file-name order; use ↑ / ↓ to reorder.
   - The website updates by itself about 2–3 minutes after saving.

2. **Cloud Editor (Pages CMS at app.pagescms.org)**:
   - For team members editing without a local development environment, open [https://app.pagescms.org](https://app.pagescms.org) or visit `/admin/` on the live website.
   - It reads `.pages.yml` and directly commits updates to `artssapta/sapta` on GitHub.

## Photos

1. Open **Events, photos & videos** in the editor.
2. Select the event, such as **Eka** or **Go-Rakshana**.
3. Under **Event gallery**, add a photo entry and upload an image. Add a short description of the people or moment shown.
4. Drag entries into the desired order and save the event.

Saving adds the photo to that event's existing gallery and lightbox after the automatic website deployment finishes. Uploading a file to the media library alone does not attach it to an event: select it in the event's gallery field and save.

## Videos

In the selected event, add an entry under **Event videos**, enter a title, and choose a source:

- **YouTube link:** paste a YouTube watch, share, Shorts or live link. Use this for full concerts.
- **Upload a short video:** choose an MP4 encoded with H.264 or a WebM file. Keep clips small; the editor and GitHub impose upload limits, and GitHub Pages has a 1 GB site limit. This site does not transcode videos.

Only the selected source is used, even if both fields contain values. Save the event to place the video in its existing video section. Uploaded media works for both upcoming and past events.

## Registration

1. Choose **Group registration** or **SAPTA Spotlight registration**.
2. Paste the new HTTPS form link into **Registration form link**.
3. Update **Message for visitors**.
4. Set **Registration availability** to **Open**, then save.

Choose **Coming soon** to hide the form link again. Both pages currently start in Coming soon mode with the previous links removed. Open forms use a clearly labeled button that opens the form in a new tab, including shortened Google Forms links.

## New events

Choose **New** in the Events collection. Fill in the name, date, status, flyer and display order. Lower display-order numbers appear first. Add any photos or videos, then save. Keep event status and date up to date manually.

## Publishing

Save changes on the **main** branch to update the live website. The existing GitHub Actions deployment runs automatically; changes are not instant. Allow a few minutes and refresh the website. Saves on another branch do not publish to the live site. If an update does not appear, ask the website owner to inspect the latest deployment; invalid links or missing required fields can stop a build while the last good site stays online.

## One-time activation — website owner

The local implementation is prepared, but online editing is not active until these steps are completed:

1. Publish the updated source files and `.pages.yml` to the `artssapta/sapta` repository on `main`. Keep the migrated `src/content/events` and `src/content/registrations` files with the matching page code.
2. Open https://app.pagescms.org and sign in with the GitHub account that administers the repository.
3. Install/connect the Pages CMS GitHub App with access to **only `artssapta/sapta`**. This grants the service permission to save content and uploaded files to that repository.
4. Select `artssapta/sapta`, then `main`. The editor reads `.pages.yml` automatically.
5. Invite the intended staff through Pages CMS's collaborator settings. Do not share the owner's GitHub credentials.
6. Save a small photo to a selected event and confirm that the deployment succeeds and the image appears in that event's gallery. Switch a registration to Open with a valid form link and confirm the button opens the correct form; switch it back to Coming soon if registration is not ready.

`/admin/` is a public sign-in and instructions page, not a public write API. Editing requires authentication in Pages CMS. No passwords or access tokens are embedded in the website. The CMS handles authentication and file writes; GitHub Pages serves the rebuilt site.

## Maintainer notes

- Each event now lives in `src/content/events/<name>.md`; `src/content/pages/events.md` controls the page heading only.
- Registration settings live in `src/content/registrations/group.md` and `spotlight.md`.
- Uploaded files are stored in `public/uploads/photos` and `public/uploads/videos`. The CMS writes their public `/uploads/...` paths into the selected event.
- Existing photo URLs, galleries, titles and event order were preserved during migration.
- `.pages.yml` defines the editing forms. Astro's content schemas validate saved content before publishing.
- Roll back an unwanted edit with the repository's history and republish. Removing a gallery entry removes it from that event, but does not delete a file that other entries may still use.

References: [Pages CMS setup](https://pagescms.org/docs/quick-start/), [collaborator access](https://pagescms.org/docs/configuration/collaborators/), [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
