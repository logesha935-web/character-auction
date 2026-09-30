# Change log (this update)

| File | What was wrong | What changed |
|---|---|---|
| server/index.ts | Login lived only in memory: refresh / server sleep = login again | Server issues its own 1-year session token after Google verifies you once (only a SHA-256 hash is stored, in permanent storage). New events: resumeSession, logout. Removing an account signs it out everywhere. |
| src/App.tsx | Login page flashed on refresh; no Logout button | Token kept in localStorage, restored on start behind a "Signing you in..." screen (login page never flashes). Logout button clears it. Free-server wake-ups retry automatically. |
| server/index.ts + src/App.tsx | Refresh threw you out of your room / auction | Your seat is re-bound to your account on resume (host stays host, bids and teams kept). |
| server/index.ts | Rooms lost whenever the free server restarted | Rooms saved to permanent storage and restored on boot (paused until someone signs back in). Rooms idle for 12 h are cleaned up. |
| server/index.ts + src/App.tsx | Settings (name, budget, timer, teams, limits) reset every visit | Saved per Google account on the server + cached in the browser. Owner key remembered on the device until Logout. |
| server/index.ts | Images/sounds/video were giant base64 strings, re-sent to every player every second inside the game state | Every upload is stored once by content hash and served from /media/<hash> (1-year cache, Range support for iOS video). State carries short links only. Old saved data is upgraded automatically on first start. Blob URLs are rejected. |
| src/App.tsx, src/assets/characters/ | Built-in characters had no bundled pictures | Put images in src/assets/characters/ (c1.png ... or iron-man.png); bundled at build time. Owner uploads override them. |
| server/index.ts | A Supabase hiccup at start-up looked like an "empty list" and could overwrite approved accounts / library | List files are read with error detection, retried every 5 s, merged, never overwritten until really read. |
| server/index.ts | "Play Again" returned to the lobby with only the last re-auction round's characters | Full original list restored. |
| server/index.ts | sanitizeLimits: min value became NaN when missing | Fixed. |
| server/index.ts | Owner could remove their own account (lock-out) | Blocked. |
| server/index.ts | Any unexpected error could crash the server and all open rooms; port fixed to 3001 | Crash guards added; uses Render's PORT; /health shows storage status. |
| package.json, .gitignore | No start script; local data folder not ignored | Added npm start; ignored server/data/. |
