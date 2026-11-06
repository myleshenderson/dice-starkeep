# Rough edges

Notes from packaging Dice as a Starkeep app on 2026-11-06, against
`starkeep-core` main at that date, `@starkeep/app-client` 0.10.0 and
`@starkeep/admin-manifest` 0.8.0. Written for the Starkeep author; each is
something that cost time or would trip the next outside app author.

The install itself worked: Discover apps found Dice, Install and Start worked,
Open Dice loaded the game, and a game of Dice Poker against the bot started and
rolled. Everything below is friction, not a blocker.

1. **Browser storage is wiped on every restart.** admin-web starts an app on a
   fresh random port (`findOpenPort()` in `routes/exec-daemon.ts`), and the
   Open link is `http://localhost:<port>`. A browser keys `localStorage`,
   IndexedDB and cookies by origin, port included, so every Stop/Start gives
   the app a new, empty origin. Dice keeps its game history in `localStorage`,
   so a player's history disappears each time Dice restarts (seen: port 45041,
   then 33639 after a stop and start). A stable port per installed app would
   fix it, as would serving apps under one origin.

2. **Discover apps takes a parent folder, and says nothing when it finds
   nothing.** The dialog does explain that each subfolder holding a manifest is
   an app, but the authoring doc's "Installing it" section is the only other
   place that says so. Pointing it at the app folder itself, which is the
   natural first try, finds nothing and shows no message. `scanApps()` also
   skips a manifest that fails to parse without any message, so a JSON typo
   makes the app vanish rather than fail.

3. **The manifest validator ignores keys it does not know.** zod's default
   `object()` strips unknown keys, so `validateManifest` passes a misspelled
   optional field (`localrun`, `licence`) and the field is then ignored. Probe
   and Photos both set a top-level `description` that the schema does not
   declare (Probe also has `sizeClass` on a label key), yet admin-web shows
   `description` on the app card. Declaring `description` and using
   `.strict()` would catch this at validation.

4. **The worked examples break the "published versions only" rule the doc
   states.** The authoring doc says `package.json` declares published version
   ranges and never `workspace:*`. Photos depends on `workspace:*`
   (`@starkeep/photos-info`, `@starkeep/photos-ladder`) and `link:` paths
   (`@starkeep/e2e`), and Probe depends on `@starkeep/app-client` as
   `workspace:*`. Neither can be copied into a standalone repository. A
   minimal standalone example app (a manifest, a Hono server and a static
   folder) would be the most useful single addition for outside authors.

5. **There is no guidance for a pre-built static bundle.** The doc names Vite
   as the default for the browser half and puts content-hashed output under
   `/_immutable/`, which tools like Flutter do not produce. For the local
   surface, `createWebAppHandler` is not used, so each app writes its own file
   server (Photos has `client-serving.ts`; Dice has about 40 lines in
   `server/app.mjs`). A `serveStatic({ dir, shellPaths })` helper in
   `@starkeep/app-client/hono` for the local surface would close this. It is
   also unclear whether an app that never touches data still needs the
   runtime-config route and signing proxy that the doc's table marks
   **Required**; nothing checks for them. Dice includes both.

6. **Dependencies are the operator's job, and the doc does not say so.**
   admin-web runs the `localRun` command in the app folder but never installs
   the app's dependencies. The starkeep-core README mentions it for
   `starkeep-apps`; the authoring doc does not. Without `pnpm install`, Start
   fails on a missing module. (Dice's `serve.mjs` checks for this and prints
   the command to run.)

7. **The consent dialog contradicts itself for an app with no grants.** It
   reads "Dice asks for access to these files." followed by "No file-type
   grants requested."

8. **`pnpm install` in starkeep-core failed under a Corepack-shimmed pnpm.**
   The root `postinstall` runs turbo, which stopped with "Unable to find
   package manager binary: cannot find binary path" when pnpm came only from
   `corepack pnpm`. It worked once a real `pnpm@10.20.0` binary was on `PATH`.
   One line in the README's prerequisites would save the next person that.

9. **Small doc inconsistencies.** §4's code uses `sessionAuth()` while the
   text lists only the `{ auth: "session", verifySession }` form. "Installing
   it" says admin "reads and validates the manifest"; admin-web forwards the
   raw manifest to local-data-server and does no validation itself.
