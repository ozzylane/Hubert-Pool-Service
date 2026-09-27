# Huber Pools LLC

A phone-first web app for running a pool route: clients, daily schedule, service
checklist, water chemistry, before/after photos, and a photo report sent to the
customer by text or email.

It's a plain HTML/CSS/JavaScript app with no build step and no server. It runs on
GitHub Pages and installs to the phone's Home Screen like a normal app. It
also works offline.

## Features

- **Login**: the first time the app opens, it asks Hubert to create a username and password. After that it asks for them to open the app. "Keep me signed in for 30 days" means he doesn't have to type them at every stop. After 5 wrong tries, sign-in is paused for 30 seconds.
- **Today's route**: the clients due today, in the order you set, with progress, gate codes and one-tap directions. "Open remaining route" sends every remaining stop to Google Maps. Clients who are overdue are flagged.
- **Clients**: name, mobile number, email, address, service days, how often (weekly / every 2 weeks / monthly / on call), pool type (chlorine or salt), gallons, rate, gate code and notes.
- **Service visit**: before and after photos, a checklist you can edit, water test readings (chlorine, pH, alkalinity, CYA, calcium, salt, temperature) with target ranges and last visit's numbers, chemicals added and notes. Unfinished visits are saved automatically. If the phone closes the app while the camera is open, nothing is lost.
- **Send report**: builds a branded report image (photo, readings, checklist, chemicals, notes). **Text** and **Email** buttons open a message already addressed to the customer with the summary filled in, and copy the photo so it can be pasted in.
- **History**: every visit, with visits this week and this month, an estimate of what was billed this month, and a "report not sent" filter.
- **Backup / restore**: saves all data, including photos, to a single file.

## Where the data lives

Everything is stored **on the phone** (IndexedDB), not on GitHub. The GitHub
repository holds only the app code, so the repo can be public without exposing
any customer information. Because the data is on one device:

- Install the app to the Home Screen. On iPhone, Safari may clear data for websites that haven't been visited in a while, but installed apps are kept.
- Tap **Settings → Save backup file** every week or so, and keep the file in iCloud Drive / Google Drive. The app reminds you when a backup is more than 7 days old.
- To move to a new phone, restore that file there.

## Login and password storage

- The username and password are **not in the code**. The code is public on GitHub, so anything written into it could be read by anyone.
- They're stored on the phone, in the app's own storage. The password is kept only as a salted hash (PBKDF2-SHA256, 210,000 rounds), never as readable text. The phone's password manager (iCloud Keychain / Google Password Manager) can also offer to save the login.
- Change the username or password under **Settings → Account**.
- **Forgot password:** there's no server that could reset it. The sign-in screen offers **Forgot password? → Erase all data on this device**. After that, create a new login and restore the latest backup file. Backup files don't contain the login.
- The login keeps other people from opening the app on Hubert's phone. It isn't bank-grade security: someone with the unlocked phone and technical skills could still read the app's stored data. Keep a passcode on the phone as well.

## Publishing on GitHub Pages

1. Create a new repository on GitHub, for example `hubert-pool-service`.
2. Push this folder to it:
   ```bash
   git remote add origin https://github.com/<your-username>/hubert-pool-service.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save**.
4. After a minute the app is live at `https://<your-username>.github.io/hubert-pool-service/`.

## Installing on the phone

- **iPhone**: open the link in **Safari** → Share button → **Add to Home Screen**.
- **Android**: open the link in **Chrome** → ⋮ menu → **Install app** / **Add to Home screen**.

Then open **Settings** in the app and enter the business phone number and email so they appear on reports.

## Sending reports: how it works

A website can't send texts or emails in the background without a paid service
(for example Twilio or SendGrid), so the app uses the phone's own Messages and Mail apps:

1. On a finished visit, tap **Text [name]** or **Email [name]**. A new message opens already addressed to that customer's number or email from their client record, with the report summary filled in.
2. The report photo is copied at the same moment. In the message, **tap and hold** where you type, choose **Paste**, then send.

**Share menu** and **Save image** are still there as other ways to send. If a client has no mobile number or email saved, the app shows a link to add it.

## Development

Run it locally with any static server:

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. After changing files, bump `VERSION` in `sw.js`
so installed phones pick up the new version.

| File | Purpose |
| --- | --- |
| `index.html` | Page shell and tab bar |
| `app.js` | Screens, routing and app logic |
| `report.js` | Customer report text and image |
| `db.js` | IndexedDB storage |
| `auth.js` | Login, password hashing, sessions |
| `styles.css` | Mobile-first styles, light and dark mode |
| `sw.js` | Offline caching |
| `manifest.webmanifest`, `icons/` | Home Screen install |
