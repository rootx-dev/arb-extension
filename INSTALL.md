# Installing the Arb Betting Assistant

You'll receive your personal **access key** and the **server URL** from us. The
extension itself you get from a public download page on GitHub.

> **You do not need a GitHub account.** And the extension does nothing without
> your access key, so the public download is safe — it can't connect to anything
> without the key we give you.

Pick **one** of the two methods below. Method A needs no command line. Setup
takes about 2 minutes, once.

---

## Method A — Download from GitHub (no command line) ✅ easiest

### First-time install

1. Go to **https://github.com/rootx-dev/arb-extension**
2. Click the green **`< > Code`** button, then **Download ZIP**.
3. Find the downloaded `arb-extension-main.zip` and **double-click to unzip** it.
   You'll get a folder called `arb-extension-main`.
4. **Move that folder somewhere permanent** — e.g. your **Documents** folder.
   Don't leave it in Downloads.
5. Open Chrome, go to `chrome://extensions` (type it in the address bar).
6. Turn on **Developer mode** (toggle, top-right).
7. Click **Load unpacked** (top-left) and select the **`arb-extension-main`**
   folder (the one containing `manifest.json`). Click **Open**.
8. The "Arb Betting Assistant" tile appears. Pin it: click the puzzle-piece icon
   in the toolbar, then the pin next to it.

Then do **Step: Enter your access key** below.

### Updating (when we tell you there's a new version)

1. Go to **https://github.com/rootx-dev/arb-extension** again.
2. **`< > Code` → Download ZIP**, and unzip it as before.
3. On `chrome://extensions`, find the Arb Betting Assistant tile and click
   **Remove**. (Don't worry — your access key and settings are saved separately
   and will come back automatically.)
4. Click **Load unpacked** and select the **new** `arb-extension-main` folder.
5. Done. Your server URL and access key reappear automatically.

> Why remove + re-add? Chrome remembers the old folder. Pointing it at the fresh
> download is the cleanest way to update without the command line. Your settings
> survive because they're tied to the extension, not the folder.

---

## Method B — Git (one-line updates, needs Terminal)

If you're comfortable with Terminal, this makes updates a single command and
never loses the folder.

### First-time install

```bash
cd ~
git clone https://github.com/rootx-dev/arb-extension.git
```

This creates `~/arb-extension`. Load it via `chrome://extensions` → **Developer
mode** → **Load unpacked** → select the `arb-extension` folder. Pin it.

### Updating

```bash
cd ~/arb-extension
git pull
```

Then on `chrome://extensions`, click the **reload icon** (↻) on the tile. No
re-download, no re-add.

> Prefer buttons to Terminal? The free **GitHub Desktop** app can do the `git
> pull` step with a "Pull" button — clone once in the app, then click Pull to
> update, and reload in Chrome.

---

## Step: Enter your access key (first install, both methods)

1. Click the extension icon to open its popup.
2. Open **settings** and fill in:
   - **Server URL:** the exact URL we gave you (e.g. `https://arb-nc5y.onrender.com`)
   - **Bearer token:** your personal access key
3. Save. You're done.

---

## Notes

- **"Disable developer-mode extensions" popup on Chrome startup** — normal for
  non-store extensions. Click to keep it enabled; it doesn't affect anything.
- **Your settings are safe across updates.** The access key and server URL are
  stored with the extension's identity, not the folder, so they persist even
  when you re-download.

## Trouble?

- **Popup says unauthorized / 401** — your access key is wrong, expired, or has
  been turned off. Contact us.
- **Nothing happens on a bookmaker page** — make sure you're logged in to that
  bookmaker and on its sports/line page.
- **(Method B) `git pull` says "local changes would be overwritten"** — run
  `git reset --hard && git pull`, then reload in Chrome.
