# TrainingPeaks Export

A small desktop app. A coach signs in to TrainingPeaks inside it, picks
athletes and dates, and gets one zip on their computer with what
TrainingPeaks has: workouts planned and done, recordings (samples, laps,
zones), comments, calendar notes, each athlete's settings, and the coach's
workout libraries. Nothing leaves the computer.

The zip holds TrainingPeaks' answers as they came, untranslated, so whatever
imports it can be fixed and rerun without the coach downloading again.

## Install

Download the file for your computer from the
[Releases page](https://github.com/pnovak468/trainingpeaks-export/releases).
The app isn't signed by Apple or Microsoft yet, so each system asks once
whether to trust it.

### Mac

1. Download `TrainingPeaks-Export-<version>-mac-universal.dmg`. It runs on
   both Apple Silicon and Intel Macs.
2. Open it and drag **TrainingPeaks Export** into **Applications**.
3. Open the app from Applications. The Mac says it can't check the app
   for malicious software. Click **Done** (or **OK**).
4. Open **System Settings → Privacy & Security**, scroll down to the
   message about TrainingPeaks Export, and click **Open Anyway**. Confirm
   with your password.

From then on it opens like any other app.

### Windows

1. Download `TrainingPeaks-Export-<version>-win-x64.exe`.
2. Run it. If Windows says **Windows protected your PC**, click
   **More info**, then **Run anyway**.
3. It installs for your user only, with no questions, and opens. It's in
   the Start menu as **TrainingPeaks Export**.

To remove it: **Settings → Apps → Installed apps → TrainingPeaks Export →
Uninstall**.

### Linux (Ubuntu, Debian and their relatives)

1. Download `TrainingPeaks-Export-<version>-linux-amd64.deb`.
2. Install it:
   ```sh
   sudo apt install ./TrainingPeaks-Export-<version>-linux-amd64.deb
   ```
3. Open **TrainingPeaks Export** from your apps.

To remove it: `sudo apt remove trainingpeaks-export`.

On other Linux systems, run it from source (below).

## Run from source

Needs [Node.js](https://nodejs.org) 22 or later and git.

```sh
git clone https://github.com/pnovak468/trainingpeaks-export.git
cd trainingpeaks-export
npm install
npm start
```

On Linux, Electron's sandbox helper must belong to root before `npm start`
works, once per `npm install`:

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Build the installers

Each one is built on its own system; the files land in `dist/`.

```sh
npm run dist:mac     # on a Mac: TrainingPeaks-Export-<version>-mac-universal.dmg
npm run dist:win     # on Windows: TrainingPeaks-Export-<version>-win-x64.exe
npm run dist:linux   # on Linux: TrainingPeaks-Export-<version>-linux-amd64.deb
```

The Mac build is signed ad hoc, not with an Apple Developer ID. Without
that signature an Apple Silicon Mac calls the app damaged and offers no way
to open it. With it, the Mac offers **Open Anyway** as above. Signing with
a Developer ID and notarising with Apple removes the warning altogether;
signing the Windows installer removes the SmartScreen one.

## How it reads TrainingPeaks

The sign-in window keeps TrainingPeaks' `Production_tpAuth` cookie in the
app's own browser profile. The app trades it at `/users/v3/token` for an
hour's bearer token, and again whenever that runs out, so a long download
doesn't stop for the token. Reads are GET only, on TrainingPeaks' internal
web API (`tpapi.trainingpeaks.com`), the same addresses its web app uses.
They can change without notice.

A download is kept in the app's data folder until it is zipped. Pressing
Download again with the same coach, athletes and dates carries on there,
without asking again for recordings it already has.

## The zip

```
<name>/
  manifest.json                          format, version, dates, coach, counts, problems
  coach/user.json                        /users/v3/user, with the athlete list
  library/libraries.json                 /exerciselibrary/v2/libraries
  library/<libraryId>/items.json         /exerciselibrary/v2/libraries/<id>/items
  athletes/<id>/athlete.json             the athlete's entry in user.json
  athletes/<id>/settings.json            /fitness/v1/athletes/<id>/settings
  athletes/<id>/workouts/<from>_<to>.json  /fitness/v7/athletes/<id>/workouts/<from>/<to>
  athletes/<id>/notes/<from>_<to>.json     /fitness/v3/athletes/<id>/calendarNote/<from>/<to>
  athletes/<id>/details/<workoutId>.json   /fitness/v6/athletes/<id>/workouts/<workoutId>/detaildata
```

Workouts and notes come in 31-day pieces. A detail is asked for only for a
workout with a time or distance; one entered by hand comes back `null`.
`manifest.json` is written last, so a zip without one is not finished.

Not in it yet: strength workouts from TrainingPeaks' strength service, the
original device files, and training plans.

## Tests

`npm test`.
