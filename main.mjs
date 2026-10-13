/**
 * The desktop app: the coach signs in to TrainingPeaks in a window of its
 * own, picks athletes and dates, and gets a zip of what TrainingPeaks has.
 * Nothing leaves the computer. The sign-in stays in the app's own browser
 * profile, so the token can be renewed for as long as the download takes.
 */

import { app, BrowserWindow, Menu, ipcMain, nativeTheme, session, dialog, shell } from "electron";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportAccount, trainingPeaks, athletesOf, coachOf, SignInNeeded, Cancelled, PaymentRequired, TP_API } from "./export.mjs";
import { folderStore, zipFolder, removeFolder } from "./store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PARTITION = "persist:trainingpeaks";
const SIGN_IN_URL = "https://home.trainingpeaks.com/login";
const AUTH_COOKIE = "Production_tpAuth";
const TOKEN_MS = 45 * 60_000;
const BAR_HEIGHT = 38;
const BAR = "#ffffff";

let window = null;
let signInWindow = null;
let token = null;
let user = null;
let running = null;

const tpSession = () => session.fromPartition(PARTITION);

/** Swaps TrainingPeaks' sign-in cookie for an hour's bearer token, or null. */
async function exchange() {
  const cookies = await tpSession().cookies.get({ name: AUTH_COOKIE });
  const cookie = cookies.find((entry) => entry.value)?.value;
  if (!cookie) return null;
  try {
    const response = await fetch(`${TP_API}/users/v3/token`, {
      headers: { Cookie: `${AUTH_COOKIE}=${cookie}`, Accept: "application/json" },
    });
    if (!response.ok) return null;
    const value = (await response.json())?.token?.access_token;
    return value ? { value, at: Date.now() } : null;
  } catch {
    return null;
  }
}

async function bearer({ fresh = false } = {}) {
  if (fresh || !token || Date.now() - token.at > TOKEN_MS) token = await exchange();
  if (!token) throw new SignInNeeded("TrainingPeaks signed you out. Sign in again to carry on.");
  return token.value;
}

const tp = trainingPeaks({ token: bearer });

/** Who is signed in and their athletes, or signedIn false. */
async function state() {
  try {
    user = await tp.user();
  } catch (error) {
    if (error instanceof PaymentRequired) {
      // The sign-in itself works, so keeping it would sign the same account
      // straight back in. Dropping it lets the coach sign in as someone else.
      await signOut();
      return { signedIn: false, paymentRequired: true, reason: error.reason };
    }
    if (!(error instanceof SignInNeeded)) return { signedIn: false, error: error.message };
    user = null;
    return { signedIn: false };
  }
  return {
    signedIn: true,
    coach: coachOf(user),
    athletes: athletesOf(user).map(({ id, name }) => ({ id, name })),
  };
}

function signIn() {
  if (signInWindow) {
    signInWindow.focus();
    return new Promise((resolve) => signInWindow.once("closed", () => resolve(state())));
  }
  return new Promise((resolve) => {
    let finished = false;
    signInWindow = new BrowserWindow({
      parent: window,
      width: 520,
      height: 760,
      title: "Sign in to TrainingPeaks",
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
    });
    signInWindow.loadURL(SIGN_IN_URL);
    // Signed in once the cookie trades for a token; TrainingPeaks then moves
    // on to its app, which this window has no need to show.
    const poll = setInterval(async () => {
      token = await exchange();
      if (!token || finished) return;
      finished = true;
      clearInterval(poll);
      const now = await state();
      signInWindow?.close();
      resolve(now);
    }, 1500);
    signInWindow.on("closed", async () => {
      clearInterval(poll);
      signInWindow = null;
      if (!finished) {
        finished = true;
        resolve(await state());
      }
    });
  });
}

async function signOut() {
  await tpSession().clearStorageData();
  token = null;
  user = null;
  return { signedIn: false };
}

const today = () => new Date().toISOString().slice(0, 10);
const safe = (text) => String(text ?? "").replace(/[^\p{L}\p{N} _.-]+/gu, "").trim();

async function download(_event, { athleteIds, from, to, library }) {
  if (running) return { error: "A download is already running." };
  if (!user) return { error: "signin" };
  const coach = coachOf(user);
  const name = `TrainingPeaks ${safe(coach.name) || "export"} ${today()}`;
  const choice = await dialog.showSaveDialog(window, {
    title: "Save the TrainingPeaks download",
    defaultPath: join(app.getPath("downloads"), `${name}.zip`),
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (choice.canceled || !choice.filePath) return { cancelled: true };

  // The same coach, athletes and dates download into the same folder, so
  // pressing Download again after a stop carries on.
  const key = createHash("sha256")
    .update(JSON.stringify([coach.personId, [...athleteIds].map(String).sort(), from, to, Boolean(library)]))
    .digest("hex")
    .slice(0, 16);
  const folder = join(app.getPath("userData"), "downloads", key);
  running = new AbortController();
  try {
    const manifest = await exportAccount({
      tp,
      store: folderStore(folder),
      user,
      athleteIds,
      from,
      to,
      library,
      signal: running.signal,
      appVersion: app.getVersion(),
      progress: (event) => window?.webContents.send("progress", event),
    });
    window?.webContents.send("progress", { step: "zipping" });
    await zipFolder(folder, choice.filePath, name);
    await removeFolder(folder);
    return {
      path: choice.filePath,
      athletes: manifest.athletes,
      library: manifest.library,
      problems: manifest.problems,
    };
  } catch (error) {
    if (error instanceof Cancelled) return { cancelled: true };
    if (error instanceof SignInNeeded) return { error: "signin" };
    return { error: error.message };
  } finally {
    running = null;
  }
}

if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

app.whenReady().then(() => {
  // A Mac needs the Edit menu for copy and paste in the sign-in page; the
  // other systems have no use for a menu bar.
  Menu.setApplicationMenu(
    process.platform === "darwin"
      ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
      : null,
  );
  ipcMain.handle("state", state);
  ipcMain.handle("sign-in", signIn);
  ipcMain.handle("sign-out", signOut);
  ipcMain.handle("download", download);
  ipcMain.handle("stop", () => running?.abort());
  ipcMain.handle("show", (_event, path) => shell.showItemInFolder(path));

  // The app draws its own title bar, always light. A Mac keeps its traffic
  // lights; Windows and Linux keep their buttons, drawn over the bar's right end.
  nativeTheme.themeSource = "light";
  const mac = process.platform === "darwin";
  window = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 460,
    minHeight: 560,
    title: "TrainingPeaks Export",
    icon: join(here, "ui", "icon.png"),
    backgroundColor: BAR,
    titleBarStyle: "hidden",
    ...(mac
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : // One pixel short of the bar, so its bottom line runs under the buttons too.
        { titleBarOverlay: { color: BAR, symbolColor: "#1c1e2b", height: BAR_HEIGHT - 1 } }),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.loadFile(join(here, "ui", "index.html"));
  window.on("closed", () => {
    running?.abort();
    window = null;
  });
});

app.on("window-all-closed", () => app.quit());
