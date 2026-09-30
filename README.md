# UPDATE NOTES - persistence

* Stay signed in until you press Logout (session token in localStorage, restored before the login page can show).
* Refresh or reopen the browser: you return to your room and seat automatically.
* Uploads (wallpaper, video, sounds, character images) are permanent and served from /media/<hash>.
* Built-in character pictures: put files in src/assets/characters/ (see README.txt there).
* Permanent storage needs SUPABASE_URL + SUPABASE_SERVICE_KEY on Render. See CHANGES.md.

---

# Character Auction — Team Multiplayer v9

This version adds:
- **Google Sign-In gate** — the entire site now sits behind "Sign in with Google." Nobody can create or join a room, bid, or do anything until they sign in with a Google account **you've specifically approved**. You manage the approved list yourself from the same owner-key panel used for the background/sounds. See "Setting up Google Sign-In" below — this needs a one-time setup on your end before it works.

  ⚠️ **Important limitation**: Google only allows `localhost` or a real registered domain as a sign-in origin — **not** a raw LAN IP address like `http://10.101.248.189:5173`. This means your existing LAN-party workflow (friends' phones connecting to your PC's IP) will stop working for sign-in until you deploy this to a real domain (Render, Railway, etc.). Testing on your own PC via `http://localhost:5173` still works fine.
- **Owner-only auction sound uploads** — the same gear icon / owner-key panel that sets the landing page background now also has 5 upload slots, each with its own "Custom set" / "Using default" status, a preview player, and a Remove button:
  - **Auction background music** — replaces the synthesized ambient hum
  - **Heartbeat sound** — replaces the synthesized thump in the last 5 seconds
  - **Hammer / SOLD sound** — replaces the synthesized bang when a character sells
  - **Queue sound** — plays when a character is unsold for the first time (previously silent — now has both a synthesized default and an upload slot)
  - **Trash / discard sound** — plays when a character is unsold a second time and permanently discarded (also newly added, default + upload slot)

  Nothing uploaded → the synthesized defaults keep working exactly as before. Upload a file → it takes over instantly for everyone, in every room, until removed. All gated behind the same owner key as the background.
- **Richer "Up Next This Round" cards** — each character waiting its turn now shows universe, rarity, power score, and its ability/power key note, not just the name and base value.
- **Sound** (all synthesized in the browser via Web Audio — no audio files, nothing to download):
  - A low ambient hum plays for as long as bidding is live on the auction screen
  - The last **5 seconds** of each character's timer get a soft heartbeat "lub-dub" thump, once per second
  - A hammer-bang sound fires the instant a character is sold, alongside the SOLD! animation
  - A mute/unmute speaker icon sits in the auction header (top right, next to the timer) for anyone who wants it off
  - Timer default changed from 15s to **20s** per character (still adjustable at room setup: 10/15/20/30)
- **Countdown popup** — in the last 5 seconds, a big pulsing red number appears center-screen each second, in sync with the heartbeat thump, so nobody misses it's about to close
- **Owner-only landing page background** — a small gear icon on the home page opens a panel where you (and only you) can upload a background image for the landing page, protected by an **owner key**. It's saved to disk on the server and stays exactly as set — surviving restarts and new rooms — until you upload a different one. **Change the owner key** before you share this with anyone: open `server/index.ts` and edit the `OWNER_KEY` constant near the top (or set an `AUCTION_OWNER_KEY` environment variable), otherwise anyone who guesses the default key could change it too. This is separate from the per-room background in the Character Manager's Theme tab, which only affects that one room's lobby/auction screens.
- **Interactive auction feedback** — the auction screen now reacts the instant something happens:
  - A character is **sold** → a hammer-slam "SOLD!" animation flashes over the screen.
  - A character goes **unsold for the first time** → an animation shows it being added to the re-auction queue.
  - A character goes **unsold a second time** → it's animated straight to the trash and is permanently discarded — it will never come up for auction again, so nobody has to wait on a character that clearly isn't selling.
- **Two game modes, chosen at room creation:**
  - **Team mode** — set up multiple teams (up to 6) with custom names, up to 5 friends per team, one shared wallet per team.
  - **Solo mode** — every player who joins automatically gets their own individual wallet. Perfect for going head-to-head against a friend or a free-for-all with the whole group.
- **Host-controlled Sold / Unsold buttons** — no more waiting for the timer to run out. The host can mark a character SOLD to the current highest bidder, or UNSOLD/Skip, the instant they want to move on.
- **Automatic re-auction of unsold characters** — once every character has had a turn, anything nobody bought is bundled into a fresh round and auctioned again (up to 5 rounds), so nothing is wasted just because it didn't sell the first time.
- **Customizable background** — the host can upload any image (a poster wall, artwork, anything) as the lobby/auction background from the new "Theme" tab; it's dimmed automatically so text stays readable, or can be removed to fall back to the default theme.
- **Full Character Manager (host tools, in the lobby):**
  - Add any character one at a time — name, universe/category, a short **ability / power key note**, a **power score**, and a **base value**, plus an image upload for that character
  - **Configurable limits**: set the max number of characters allowed, the min/max base value range, and the max power score — all editable any time before the auction starts
  - Edit or delete any character already in the pool
  - Bulk image upload still available for quickly adding many characters at once (edit their stats afterwards in the roster list)
  - Live counter showing how many characters are in the pool vs. the configured limit
- Ability key note and power score shown on the auction card while bidding
- Round number and "queued for re-auction" count shown live in the header
- Professional red-and-black auction-house visual theme throughout
- Custom starting budget, bid increment and timer
- Same live auction state on every device
- LAN access: Vite and Socket.IO listen on all network interfaces

## Setting up Google Sign-In (required — the site won't let anyone do anything until this is done)

1. Go to https://console.cloud.google.com/ and sign in with your own Google account.
2. Create a new project (top-left project dropdown → New Project → give it any name, e.g. "Character Auction").
3. In the left sidebar go to **APIs & Services → OAuth consent screen**. Choose **External**, fill in an app name (anything), your email for support/contact, and save through the steps. You don't need to submit for verification for personal/friend use — add your friends' Google accounts as "Test users" on that same screen if prompted (that lets them sign in while the app is in "Testing" mode).
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Name: anything
   - **Authorized JavaScript origins**: add `http://localhost:5173` for local testing, and later your real deployed URL (e.g. `https://your-app.onrender.com`) once you deploy. Raw IP addresses (like your LAN IP) are **not** accepted here.
5. Click **Create**. Copy the **Client ID** shown (a long string ending in `.apps.googleusercontent.com`).
6. Paste that Client ID in **two places** in this project:
   - `src/App.tsx` — find `const GOOGLE_CLIENT_ID = "PASTE-YOUR-GOOGLE-CLIENT-ID-HERE...`
   - `server/index.ts` — find `const GOOGLE_CLIENT_ID = process.env.AUCTION_GOOGLE_CLIENT_ID || "PASTE-YOUR-GOOGLE-CLIENT-ID-HERE...` (replace the placeholder string, or set an `AUCTION_GOOGLE_CLIENT_ID` environment variable instead)
7. In `server/index.ts`, also set `OWNER_EMAIL` (or the `AUCTION_OWNER_EMAIL` env var) to **your own** Gmail address, so you're automatically approved and never locked out of your own site.
8. Restart the server (`npm run dev` again). Open the site — you'll see a "Sign in with Google" gate. Sign in with your own (owner) account first.
9. To approve a friend: click the gear icon on the landing page → enter your owner key → scroll to **Approved Google Accounts** → type their Gmail address → **Add**. They can now sign in too. Remove access the same way, any time.

## Run on the host PC

```bash
npm.cmd install
npm.cmd run dev
```

Open on the host:
http://localhost:5173

## Let phones join on the same Wi-Fi

On the host PC, run:

```powershell
ipconfig
```

Find the Wi-Fi adapter's `IPv4 Address`, for example:

`192.168.1.5`

Then phones on the SAME Wi-Fi open:

`http://192.168.1.5:5173`

If Windows Firewall asks whether Node.js should communicate on the network, allow it on Private networks.

## Remote friends on different Wi-Fi/mobile networks

The LAN address will NOT work across the internet. Deploy the app to a public host or VPS and use HTTPS/WSS. For a production version, move room state and uploaded images to a database/object storage.

## Character manager

In the host lobby, scroll to **Character manager**:

- **Add tab** — upload one image, type the name, universe, an ability/power key note, set the power score and base value (both are clamped to your configured limits), pick a rarity, then "Add to auction pool". A "Bulk-upload multiple images" box below it is still there for quickly adding many characters at once (edit their stats afterwards).
- **Limits tab** — set the max number of characters allowed in the pool, the max power score, and the min/max base value range. Saving instantly re-clamps every character already in the pool to the new range and trims the roster if it's now over the max count.
- **Roster tab** — see every character as a card (image, ability note, power, value) with edit and delete buttons.

Images are stored in the current room's memory as data URLs and shared with all connected players.

For a large production game, replace this with cloud object storage so rooms survive restarts and images don't make the Socket.IO payload too large.
