# Pigga Calendar - setup guide

Everything in this folder goes on GitHub. The secret keys are in a SEPARATE file
(pigga-vercel-keys.txt) that must NOT go on GitHub.

## What's in this folder
| File | What it does |
|---|---|
| index.html | the whole website |
| api/calendar.js | saves events and birthdays for everyone, spam limits, owner remove |
| api/push.js | turns notifications on/off for each phone |
| api/cron.js | sends the daily notifications (morning + evening) |
| lib/store.js, lib/push.js | helpers used by the api files |
| sw.js | lets phones receive notifications when the site is closed |
| manifest.webmanifest, icon-192.png, icon-512.png | app icon + "Add to Home Screen" |
| package.json | tells Vercel which add-ons to install |
| vercel.json | security settings + the 2 daily timers |

## Step 1 - GitHub
1. Go to your repo (or make a new one: github.com -> + -> New repository).
2. Click **Add file -> Upload files**.
3. Drag in EVERYTHING from this folder, including the `api` and `lib` folders (drag the folders themselves so they stay folders).
   If your repo already has an old index.html, the new one replaces it.
4. Click **Commit changes**.
5. Check the repo shows `api/calendar.js`, `api/push.js`, `api/cron.js`, `lib/store.js`, `lib/push.js` in those folders.

## Step 2 - Vercel project
- Already have the project on Vercel from before? It redeploys by itself after the GitHub upload. Go to Step 3.
- New? vercel.com -> Continue with GitHub -> **Add New... -> Project** -> **Import** the repo -> Framework: **Other** -> **Deploy**.

## Step 3 - Storage (where events are saved)
1. Vercel -> your project -> **Storage** -> **Create** -> **Blob** -> give it any name -> **Create**.
2. Connect it to your project (all environments). Skip if you already did this before.

## Step 4 - Secret keys
1. Vercel -> your project -> **Settings -> Environment Variables**.
2. Add each NAME + VALUE from `pigga-vercel-keys.txt`:
   OWNER_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CRON_SECRET, VAPID_SUBJECT.
3. Change VAPID_SUBJECT to your real site link.

## Step 5 - Redeploy
Vercel -> **Deployments** -> top one -> **...** -> **Redeploy**. (New keys only work after a redeploy.)

## Step 6 - Check it works
1. **Settings -> Cron Jobs** shows 2 jobs: /api/cron?slot=morning and /api/cron?slot=evening.
2. Open the site -> ENTER -> EDIT -> add an event. Open the site on another phone: the event is there.
3. Notifications: say yes to the popup (iPhone: Share -> Add to Home Screen first, open it from the icon, then Settings -> notifications).
   Turn on "new events", add an event from another phone: you should get a ping within seconds.
4. Owner mode: open your-site.vercel.app/#owner, type your OWNER_KEY, tap a day -> "remove" shows on every entry.

## Rules built in
- Add an event: 1 per hour AND 2 per day (day resets at midnight India time). Checked on the phone and on the server (per internet connection).
- Add your birthday: once ever per device, max 3 per internet connection. Joke entries: remove them in owner mode.
- Pigga Day (3 Oct) and Dilip Day (1 Oct) are built in and can't be removed.
- Notifications: morning ping ~8:00 IST, evening "tomorrow" ping ~19:00 IST. Vercel's free plan can run these up to an hour late.

## If something breaks
- "can't reach the server" when adding: the Blob store isn't connected, or you opened the file from your computer instead of the Vercel link.
- Owner mode says "OWNER_KEY is not set on vercel": add it in Step 4, then redeploy.
- Notifications say "aren't set up on the server yet": the VAPID keys are missing; add them and redeploy.
- No daily pings: check CRON_SECRET is set and the 2 cron jobs are listed.
