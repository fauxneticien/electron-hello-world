# electron-hello-world

The smallest Electron app that can update itself from GitHub Releases (macOS, Apple Silicon).

## The files

| File | What it does |
|---|---|
| `main.js` | Main process. Opens the window and asks `electron-updater` to check GitHub. When an update has downloaded, it tells the page. |
| `preload.js` | The bridge. The page can't use Node or Electron APIs, so this exposes exactly two functions: `updater.onDownloaded()` and `updater.install()`. |
| `index.html` | The page. A heading and a hidden button that appears when an update is ready. |
| `package.json` | Dependencies plus the `build` section that tells `electron-builder` how to package and where to publish. |
| `.github/workflows/release.yml` | Builds and publishes a release whenever you push a `v*` tag. |

## How an update reaches the app

1. `electron-builder` reads `build.publish` and puts it inside the app as `Hello.app/Contents/Resources/app-update.yml`. That file is how the installed app knows which repo to check.
2. When it publishes a release, it uploads the `.dmg` (for people downloading the app), the `.zip` (what the updater downloads), and `latest-mac.yml` (the version number plus a sha512 of the zip).
3. When the app starts, `autoUpdater.checkForUpdates()` fetches `latest-mac.yml` from the **latest non-draft release** and compares its version with `app.getVersion()` (which comes from `package.json`'s `version`).
4. If the release is newer, it downloads the zip, checks the sha512, and emits `update-downloaded`, which makes the button appear.
5. When you click the button, `quitAndInstall()` hands the zip to **Squirrel.Mac**, which is macOS's update installer built into Electron. Squirrel checks that the new app is **signed by the same Developer ID** as the running app, swaps the bundle, and relaunches.

Step 5 is the only step that needs a certificate.

---

## Part 1: Run it locally

```sh
npm install
npm start            # dev mode: the updater skips itself ("application is not packed")
npm run dist -- --publish never   # builds dist/Hello-0.0.1-arm64.dmg without uploading
```

## Part 2: First release ("Hello", v0.0.1)

```sh
git add -A
git commit -m "Hello"
git push -u origin main
git tag v0.0.1
git push origin v0.0.1
```

Pushing the tag starts the workflow. Watch it in the repo's **Actions** tab (about 3–5 min). When it finishes, **Releases** shows `v0.0.1` with the dmg, zip, blockmaps, and `latest-mac.yml`.

> The tag must match `version` in package.json. electron-builder names the release `v<version>`.

### Install it like a user would

Download `Hello-0.0.1-arm64.dmg` from the release page in your browser, open it, and drag Hello to Applications.

- **Unsigned build:** macOS says *"Hello is damaged and can't be opened."* That's Gatekeeper rejecting a quarantined, unsigned download. To get past it, run `xattr -cr /Applications/Hello.app` and open the app again.
- **Signed and notarized build:** the app opens normally.

To see the updater's logs, start the app from a terminal:

```sh
/Applications/Hello.app/Contents/MacOS/Hello
```

## Part 3: Second release ("Hello world", v0.0.2)

Change `<h1>Hello</h1>` to `<h1>Hello world</h1>` in `index.html`, then:

```sh
git commit -am "Hello world"
npm version patch     # sets 0.0.2 in package.json, commits it, and creates tag v0.0.2
git push --follow-tags
```

Wait for the workflow to finish. Then quit and reopen the **installed v0.0.1** app (from a terminal, so you can watch the log):

```
Checking for update
Found version 0.0.2 (url: Hello-0.0.2-arm64-mac.zip)
Downloading update from Hello-0.0.2-arm64-mac.zip
New version 0.0.2 has been downloaded
```

The **"Update available — restart to install"** button appears.

- **Signed:** click it. The app quits, relaunches, and shows "Hello world".
- **Unsigned:** the click does nothing, and the log shows a Squirrel error like *"Code signature … did not pass validation"*. Everything before that worked. To finish without a certificate, download the new dmg by hand.

---

## Part 4: Certificates (needed for one-click install and a clean first launch)

macOS needs two things from Apple:

- **Code signing** proves who built the app. Squirrel.Mac uses it to check that the update comes from the same developer.
- **Notarization**: Apple scans the signed app and records it as OK. Gatekeeper checks this on first launch.

Both require the **Apple Developer Program** ($99/year): https://developer.apple.com/programs/

### 4a. Create a "Developer ID Application" certificate

1. Open **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…**. Enter your email, choose *Saved to disk*, and save the `.certSigningRequest` file.
2. Go to https://developer.apple.com/account/resources/certificates → **+** → **Developer ID Application**, and upload the CSR.
3. Download the `.cer` file and double-click it. It lands in your login keychain together with its private key.
4. Check that it's there: `security find-identity -v -p codesigning` should list `Developer ID Application: Your Name (TEAMID)`.

Locally, this alone is enough. `npm run dist` finds the certificate in your keychain and signs with it.

### 4b. Export it for CI

GitHub's Mac runner has no keychain of yours, so you give it the certificate as a secret:

1. In Keychain Access → *My Certificates*, right-click the Developer ID certificate → **Export** → `.p12`. Pick a strong password.
2. Base64-encode it: `base64 -i cert.p12 | pbcopy`

### 4c. App-specific password for notarization

1. Go to https://account.apple.com → Sign-In and Security → **App-Specific Passwords** → generate one (e.g. "electron-notarize").
2. Find your Team ID at https://developer.apple.com/account → Membership details. It's 10 characters.

### 4d. Add the GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `CSC_LINK` | the base64 text of the .p12 |
| `CSC_KEY_PASSWORD` | the .p12 export password |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | your Team ID |

electron-builder reads these environment variables by name. If `CSC_LINK` is set, it imports the certificate into a temporary keychain and signs. If the `APPLE_*` variables are set, it notarizes after signing (this adds a few minutes). If a secret is missing, that step is skipped and the build is unsigned. That's why the workflow unsets an empty `CSC_LINK`: electron-builder treats an empty string as "a certificate was given".

> Updates only install between two signed versions. If v0.0.1 was unsigned, sign v0.0.2 and v0.0.3, install v0.0.2 by hand, and test the update from there.

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
      - run: npx electron-builder --mac --publish always   # build, sign, notarize, and upload
        env:
          GH_TOKEN: ...       # electron-builder uploads with this; GitHub creates it per run, no setup needed
          CSC_* / APPLE_*     # your secrets from Part 4 (empty if you haven't added them)
```

`releaseType: "release"` in package.json makes the release public right away. The default is a **draft**, and the updater ignores drafts. A draft is safer for real apps, because you can check the release before users get it, but then you have to click "Publish" yourself.

## What's left out on purpose

- **Windows/Linux:** add `"win": {"target": "nsis"}`, add a matrix with `windows-latest`, and use `--win`. Windows uses a separate signing certificate (or Azure Trusted Signing). Without one, updates still install but SmartScreen shows warnings.
- **Intel Macs:** `"mac": {"target": [{"target": "zip", "arch": ["universal"]}, …]}`.
- **Progress, errors, periodic re-checks:** listen to `download-progress` and `error`, and call `checkForUpdates()` on a timer. VS Code checks about every hour.
- **Content-Security-Policy:** Electron prints a warning in dev mode without one. Add a `<meta http-equiv="Content-Security-Policy">` for a real app.
