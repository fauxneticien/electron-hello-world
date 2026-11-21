# electron-hello-world

The smallest Electron app that can update itself from GitHub Releases (macOS, Apple Silicon).

## The files

| File | What it does |
|---|---|
| `main.js` | Main process. Opens the window and asks `electron-updater` to check GitHub. When an update has downloaded, it tells the page. |
| `preload.js` | The bridge. The page can't use Node or Electron APIs, so this exposes exactly two functions: `updater.onDownloaded()` and `updater.install()`. |
| `index.html` | The page. A heading and a hidden button that appears when an update is ready. |
| `package.json` | Dependencies, the app's `version`, and the `build` section that tells `electron-builder` how to package and where to publish. |
| `.github/workflows/release.yml` | Builds, signs, and publishes a release whenever you push a `v*` tag. |

## How an update reaches the app

`"provider": "github"` in `build.publish` is built into both `electron-builder` (which uploads) and `electron-updater` (which downloads). No plugin is needed.

1. `electron-builder` copies `build.publish` into the app as `Hello.app/Contents/Resources/app-update.yml`. That file is how the installed app knows which repo to check.
2. When it publishes, it uploads to the release for `v<version>`: the `.dmg` (for people downloading the app), the `.zip` (what the updater downloads), `.blockmap` files (for partial downloads), and `latest-mac.yml` (the version number plus a sha512 of the zip).
3. When the app starts, `autoUpdater.checkForUpdates()` fetches `latest-mac.yml` from the **latest non-draft release** and compares its version with `app.getVersion()`.
4. If the release is newer, it downloads the zip, checks the sha512, and emits `update-downloaded`, which makes the button appear.
5. When you click the button, `quitAndInstall()` hands the zip to **Squirrel.Mac**, the macOS update installer built into Electron. Its helper, ShipIt, checks that the new app is **signed with the same certificate** as the running app, replaces the bundle, and relaunches.

Step 5 is the only step that needs a certificate. Apple doesn't take part in it, so a self-signed certificate is enough to test updates on your own Mac.

> **Version numbers come from `package.json`, never from the git tag.** The tag only starts the workflow. If you push `v0.0.2` while package.json still says `0.0.1`, electron-builder publishes to the **v0.0.1** release and overwrites its files. Always bump the version with `npm version`, which updates package.json and package-lock.json, commits, and creates a matching tag in one step. Don't edit `"version"` by hand.

> The app checks only once, at launch (`main.js`). After publishing a release, quit the installed app (⌘Q) and open it again.

---

## Part 1: Run it locally

```sh
npm install
npm start            # dev mode: the updater skips itself ("application is not packed")
npm run dist -- --publish never   # builds dist/Hello-<version>-arm64.dmg and .zip without uploading
```

## Part 2: Signing

Squirrel.Mac only installs an update if **both** the installed app and the update are signed with the same certificate. An unsigned build can find and download updates, but clicking the button does nothing. So set up signing **before** the release you plan to install and update from.

There are two options:

| | Self-signed (2a) | Apple Developer ID (2b) |
|---|---|---|
| Cost | Free | $99/year Apple Developer Program |
| Updates install | Yes | Yes |
| First launch | Blocked until you click "Open Anyway" | Opens normally (once notarized) |
| Works for other people | No | Yes |

### 2a. Self-signed certificate (free, for testing on your own Mac)

1. In **Keychain Access → Certificate Assistant → Create a Certificate…**, set:
   - Name: `Hello Self-Signed` (the workflow uses this exact name)
   - Identity Type: Self-Signed Root
   - Certificate Type: **Code Signing**
2. Double-click the certificate → **Trust** → set **Code Signing** to **Always Trust**.

   > **Close the window to save.** The trust setting is only saved when you close the certificate window and enter your password. Until you do, macOS doesn't treat the certificate as trusted.

3. Check it:
   ```sh
   security find-identity -v -p codesigning
   ```
   You should see `1 valid identities found` with "Hello Self-Signed". If it says `0 valid identities found`, run it again without `-v`. A certificate listed there as `CSSMERR_TP_NOT_TRUSTED` means the trust setting from step 2 wasn't saved.

To sign a local build: `CSC_NAME="Hello Self-Signed" npm run dist -- --publish never`. `CSC_NAME` tells electron-builder which keychain identity to use. By default it only looks for "Developer ID Application" certificates.

#### For CI: export the certificate as two GitHub secrets

1. **`.p12` (certificate + private key):** Keychain Access → **My Certificates** tab → right-click "Hello Self-Signed" → Export → `.p12`. Pick a password.

   > **If `.p12` is greyed out,** you're exporting the certificate on its own, from the "All Items" or "Certificates" tab. A `.p12` needs the private key too. The "My Certificates" tab includes it.

2. **`.cer` (public certificate only):** right-click the same certificate → Export → Certificate (`.cer`).
3. Base64-encode each file and add it under the repo's **Settings → Secrets and variables → Actions**:

   | Secret | Value |
   |---|---|
   | `CSC_LINK` | `base64 -i cert.p12 \| pbcopy` |
   | `CSC_KEY_PASSWORD` | the `.p12` export password |
   | `SELF_SIGNED_CERT` | `base64 -i cert.cer \| pbcopy` |

4. Delete the exported files. The `.p12` contains your private key.

Why `SELF_SIGNED_CERT` is needed: electron-builder imports `CSC_LINK` into a temporary keychain on the runner, but on a fresh runner nobody has clicked "Always Trust". The certificate isn't a valid identity, so electron-builder prints `skipped macOS application code signing ... 0 valid identities found` and builds an **unsigned** app without failing. The workflow's *Trust self-signed certificate* step fixes that by running `security add-trusted-cert` with the `.cer`. If signing worked, the build log shows `signing ... identityName=Hello Self-Signed`.

You can't notarize a self-signed app, so leave the `APPLE_*` secrets unset. The log will say `skipped macOS notarization`, which is expected.

### 2b. Apple Developer ID (for apps other people install)

Both of these require the **Apple Developer Program** ($99/year): https://developer.apple.com/programs/

- **Code signing** proves who built the app. Squirrel.Mac uses it to check that the update comes from the same developer.
- **Notarization**: Apple scans the signed app and records it as OK. Gatekeeper checks this on first launch.

1. **Create a "Developer ID Application" certificate:** Xcode → Settings → Accounts → Manage Certificates → **+** → Developer ID Application. Or upload a CSR at https://developer.apple.com/account/resources/certificates. Then check that `security find-identity -v -p codesigning` lists `Developer ID Application: Your Name (TEAMID)`. Locally, this alone is enough: `npm run dist` finds the certificate in your keychain.
2. **Export it for CI:** Keychain Access → **My Certificates** → right-click it → Export → `.p12`.
3. **Create an app-specific password for notarization:** https://account.apple.com → Sign-In and Security → App-Specific Passwords.
4. **Find your Team ID:** https://developer.apple.com/account → Membership details. It's 10 characters.
5. **Add the secrets:**

   | Secret | Value |
   |---|---|
   | `CSC_LINK` | `base64 -i cert.p12 \| pbcopy` |
   | `CSC_KEY_PASSWORD` | the `.p12` export password |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
   | `APPLE_TEAM_ID` | your Team ID |

   **Delete `SELF_SIGNED_CERT` if you set it.** The workflow uses that secret to decide whether to trust a self-signed certificate and set `CSC_NAME`. CI already trusts Apple-issued certificates.

If the `APPLE_*` variables are set, electron-builder notarizes after signing, which adds a few minutes. No config is needed in package.json for this.

> Switching certificates breaks the update chain. An app signed with the self-signed certificate won't accept an update signed with your Developer ID, so install the first Developer ID build by hand.

---

## Part 3: First release ("Hello")

```sh
git push -u origin main
npm version 0.0.1 -m "Release %s"   # skip if package.json already says 0.0.1; then: git tag v0.0.1
git push origin main --follow-tags
```

Pushing the tag starts the workflow. Watch it in the repo's **Actions** tab. A few minutes is normal; macOS runners sometimes queue. When it finishes, **Releases** shows **one** release with the dmg, the zip, two blockmaps, and `latest-mac.yml`.

> **Pushing commits doesn't release.** The workflow runs only for `v*` tags.

> **Redoing a release.** Deleting a release on GitHub leaves its tag in place. Delete the tag too, or `gh release create` in the workflow fails on the next push of that tag:
> ```sh
> git tag -d v0.0.2
> git push origin :refs/tags/v0.0.2
> ```

### Install it like a user would

Download `Hello-<version>-arm64.dmg` from the release page in your browser, open it, and **drag Hello into Applications**.

> **Run it from Applications, not Downloads.** A downloaded app is quarantined. If you open a quarantined app from Downloads, macOS uses *App Translocation*: it runs the app from a hidden, read-only copy at a random path. The updater can still find and download updates, but ShipIt can't replace a read-only app, so clicking the button does nothing. Moving the app with Finder turns off translocation.

The first launch is blocked:

- **Self-signed or unsigned:** macOS shows *"Hello" Not Opened: Apple could not verify "Hello" is free of malware.* Right-click → Open no longer gets past this dialog on current macOS. Click **Done**, then go to **System Settings → Privacy & Security** → **Open Anyway**. Alternatively, remove the quarantine flag: `xattr -dr com.apple.quarantine /Applications/Hello.app`.
- **Developer ID, notarized:** the app opens normally.

The app shows "Hello" and no button: it checked GitHub and found nothing newer.

To see the updater's logs, start the app from a terminal:

```sh
/Applications/Hello.app/Contents/MacOS/Hello
```

## Part 4: Second release ("Hello world") and the update

Change `<h1>Hello</h1>` to `<h1>Hello world</h1>` in `index.html`. That's the only source change. The updater code and config stay the same, so the new version can in turn find the next one. Then:

```sh
git commit -am "Say hello world"
npm version patch -m "Release %s"   # 0.0.1 → 0.0.2 in package.json + lock, commits, tags v0.0.2
git push origin main --follow-tags
```

Wait for the workflow to finish. Then quit and reopen the **installed** app:

```
Checking for update
Found version 0.0.2 (url: Hello-0.0.2-arm64-mac.zip)
Downloading update from Hello-0.0.2-arm64-mac.zip
New version 0.0.2 has been downloaded
```

After the download (about 110 MB), the **"Update available — restart to install"** button appears. Click it. The app quits, ShipIt swaps the bundle, and the app relaunches showing "Hello world". The update itself doesn't trigger Gatekeeper again, because electron-updater downloads it without the browser's quarantine flag.

If the click does nothing, check:

```sh
cat ~/Library/Caches/com.fauxneticien.electron-hello-world.ShipIt/ShipIt_stderr.log
```

- **No log file at all:** ShipIt never ran. Usually the app was run from Downloads (see App Translocation above).
- **"Code signature … did not pass validation":** the two versions weren't signed with the same certificate, or one of them was unsigned.
- **Success** ends with `Successfully launched application at file:///Applications/Hello.app/`.

The downloaded update waits in `~/Library/Caches/electron-hello-world-updater/pending/`.

---

## Part 5: The GitHub Actions workflow, line by line

```yaml
on:
  push:
    tags: ['v*']              # runs only when a tag like v0.0.2 is pushed, not on every commit
permissions:
  contents: write             # lets the built-in GITHUB_TOKEN create releases and upload files
jobs:
  release:
    runs-on: macos-latest     # a Mac build needs a Mac (Apple Silicon runner, so the build is arm64)
    steps:
      - uses: actions/checkout@v5          # clone the repo at the tag
      - uses: actions/setup-node@v5        # install Node
      - run: npm ci                        # install exact versions from package-lock.json

      # Create the release before electron-builder runs (see the note below).
      - run: gh release create "$GITHUB_REF_NAME" --title "${GITHUB_REF_NAME#v}" --notes ""

      # Only when SELF_SIGNED_CERT is set: make the runner trust the certificate,
      # like clicking "Always Trust" in Keychain Access.
      - name: Trust self-signed certificate

      - name: Build and publish
        run: |
          if [ -z "$CSC_LINK" ]; then unset CSC_LINK; fi                          # no secret → unsigned build, not an error
          if [ -n "$SELF_SIGNED_CERT" ]; then export CSC_NAME="Hello Self-Signed"; fi
          npx electron-builder --mac --publish always                            # build, sign, (notarize), upload
        env:
          GH_TOKEN: ...       # electron-builder uploads with this; GitHub creates it per run, no setup needed
          CSC_* / APPLE_*     # your secrets from Part 2 (empty if you haven't added them)
```

- **Why create the release first?** electron-builder uploads the dmg and the zip in parallel. If no release exists yet, each upload sees that, and each creates its own. You end up with **two releases with the same tag**, with the files split between them. The page shows one release, which may be missing the zip or `latest-mac.yml`, and the job still reports success. With the release already in place, both uploads go into it.
- **Why unset an empty `CSC_LINK`?** A missing secret arrives as an empty string, and electron-builder treats an empty `CSC_LINK` as "a certificate was given".
- **Why does the step say "Run if [ -z …"?** A step with no `name:` is labelled with the first line of its script. The `if` runs inside the step, so the step itself isn't conditional.
- **`GH_TOKEN` is only for uploading.** Anyone can download from a public repo's releases, so the installed app needs no token.

`releaseType: "release"` in package.json makes the release public right away. electron-builder's default is a **draft**, which the updater ignores. A draft is safer for real apps, because you can check the release before users get it, but then you have to click "Publish" yourself.

## What's left out on purpose

- **Caching** Electron and electron-builder downloads in CI (`actions/cache` on `~/Library/Caches/electron` and `~/Library/Caches/electron-builder`, plus `cache: npm` on setup-node). It saves perhaps 10–30 s per run.
- **A tag/version guard** in the workflow: `test "${GITHUB_REF_NAME#v}" = "$(node -p "require('./package.json').version")"` would fail the run instead of overwriting another release.
- **Moving to Applications automatically:** check `app.isInApplicationsFolder()` and call `app.moveToApplicationsFolder()`.
- **Windows/Linux:** add `"win": {"target": "nsis"}`, add a matrix with `windows-latest`, and use `--win`. Windows uses a separate signing certificate (or Azure Trusted Signing). Without one, updates still install but SmartScreen shows warnings.
- **Intel Macs:** `"mac": {"target": [{"target": "zip", "arch": ["universal"]}, …]}`.
- **Progress, errors, periodic re-checks:** listen to `download-progress` and `error`, and call `checkForUpdates()` on a timer. VS Code checks about every hour.
- **Content-Security-Policy:** Electron prints a warning in dev mode without one. Add a `<meta http-equiv="Content-Security-Policy">` for a real app.
