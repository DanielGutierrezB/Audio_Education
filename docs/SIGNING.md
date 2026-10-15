# Signing and notarizing the macOS build

Everything in the repo is ready for this. What is missing is an Apple
Developer account, which costs USD 99/year.

**Daniel has decided against it for now**: the editors are a small known group
who can right-click → Open once, and USD 99/year is not worth removing that
single step. So this document describes what *would* happen, not what is
about to. The configuration stays a no-op until the credentials exist and
switches on by itself the moment they do, which is what makes the decision
cheap to revisit — a reason to revisit it is below under "Why bother".

## Why bother

Three recurring annoyances all come from the same cause, an app signed
ad-hoc with no team identity:

1. **"AudioPro can't be opened because Apple cannot check it for malicious
   software."** Every editor has to right-click → Open on the `.pkg` the
   first time, which is also the exact habit security training tells people
   not to have.
2. **The Keychain asks for permission over and over.** macOS ties "Always
   Allow" to the binary's signature, and every build has a different one, so
   each update looks like a new app. This is why the Adobe token moved out of
   the Keychain to a plain owner-only file (`src/adobe-auth.js`) — with a
   stable signature it could move back, and Electron's cookie encryption
   could be turned on at the same time.
3. **In-app updates are more fragile than they need to be.** Squirrel.Mac
   replaces the whole bundle; a stable signature is what lets macOS accept
   the replacement without complaint.

## What Daniel needs to do

1. Enrol in the [Apple Developer Program](https://developer.apple.com/programs/)
   (USD 99/year). An **Organization** account if this should belong to Platzi
   rather than to a person — note that takes longer, since Apple verifies the
   company.
2. In Xcode or the developer portal, create a **Developer ID Application**
   certificate. Not "Mac App Distribution": that one is only for the App
   Store.
3. Export it from Keychain Access as a `.p12` **with a password**, then
   base64 it:

   ```bash
   base64 -i DeveloperID.p12 | pbcopy
   ```

4. Create an **app-specific password** at
   [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security →
   App-Specific Passwords. Notarization will not accept the account password.
5. Add five repository secrets (Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `MACOS_CERTIFICATE` | the base64 `.p12` from step 3 |
   | `MACOS_CERTIFICATE_PASSWORD` | the password set when exporting it |
   | `APPLE_ID` | the Apple ID that owns the developer account |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the password from step 4 |
   | `APPLE_TEAM_ID` | the 10-character team ID, shown in the portal under Membership |

That is all. The next `v*.*.*` tag produces a signed, notarized and stapled
build; nothing in the workflow or `package.json` needs editing.

## What is already in place

- `build/entitlements.mac.plist` — the hardened runtime entitlements
  notarization requires. Only three, and each is explained in the file: two
  because V8 compiles JavaScript at runtime, one because the app spawns the
  ffmpeg and ffprobe binaries bundled in `Contents/Resources/bin`.
- `package.json` → `build.mac` — `hardenedRuntime: true`, the entitlements,
  and `binaries` listing the bundled ffmpeg/ffprobe so they are signed too.
  An unsigned helper binary inside a signed app fails notarization.
- `notarize: false` in `package.json`, turned on only in CI. A local
  `npm run build` should not sit waiting on Apple's servers for a build
  nobody ships.
- `.github/workflows/build-macos.yml` — detects whether the secrets exist and
  builds signed or unsigned accordingly, then **verifies** a signed build with
  `codesign --verify`, `spctl --assess` (what Gatekeeper itself runs) and
  `xcrun stapler validate`, rather than assuming the build step worked.

## After it is working

Once a release is signed and notarized, these become worth revisiting
together, since both were worked around *because* the app is unsigned:

- Move the Adobe token back to the Keychain (`src/adobe-auth.js`) and enable
  Electron's `EnableCookieEncryption` fuse, so the Adobe session cookies stop
  sitting on disk in the clear.
- Drop the right-click → Open instructions from the README and the release
  notes.

## Windows

Not covered here. Windows code signing needs an EV or OV certificate from a
commercial CA (roughly USD 200-400/year) and is a separate decision; the
NSIS installer is unsigned today and shows a SmartScreen warning on first
run.
