/**
 * Downloads a coach's TrainingPeaks account into a folder, as TrainingPeaks
 * answered it. Nothing is translated here: whatever reads the zip translates
 * it later, so a mistake in the translation is fixed there without asking the
 * coach to download again.
 *
 *   manifest.json                         what was asked for and what came back
 *   coach/user.json                       /users/v3/user, with the athlete list
 *   library/libraries.json                the coach's workout libraries
 *   library/<libraryId>/items.json        the workouts in each
 *   athletes/<id>/athlete.json            the athlete's entry from user.json
 *   athletes/<id>/settings.json           thresholds and zones per sport
 *   athletes/<id>/workouts/<from>_<to>.json   planned and completed workouts
 *   athletes/<id>/notes/<from>_<to>.json      calendar notes
 *   athletes/<id>/details/<workoutId>.json    samples, laps and zones of one
 *                                             completed workout
 *
 * GET only. A detail already in the folder is not downloaded again, so a
 * download that stopped carries on where it was.
 */

export const TP_API = "https://tpapi.trainingpeaks.com";
export const FORMAT = "trainingpeaks-export";
export const FORMAT_VERSION = 1;
const RANGE_DAYS = 31;

export class SignInNeeded extends Error {}
export class Cancelled extends Error {}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads TrainingPeaks with a bearer token. `token({ fresh })` hands one over;
 * on a 401 it is asked once for a fresh one before giving up.
 */
export function trainingPeaks({ token, fetchImpl = fetch, retryMs = 2000 }) {
  async function get(path, { missing = [] } = {}) {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(TP_API + path, {
        headers: { Authorization: `Bearer ${await token({ fresh: renewed })}`, Accept: "application/json" },
      });
      if (response.status === 401 || response.status === 403) {
        if (renewed) throw new SignInNeeded("TrainingPeaks signed you out. Sign in again to carry on.");
        renewed = true;
        continue;
      }
      if (missing.includes(response.status)) return null;
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await pause(retryMs * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`TrainingPeaks answered ${response.status} for ${path.split("?")[0]}`);
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  }
  return {
    user: () => get("/users/v3/user"),
    settings: (athleteId) => get(`/fitness/v1/athletes/${athleteId}/settings`, { missing: [403, 404] }),
    workouts: (athleteId, from, to) => get(`/fitness/v7/athletes/${athleteId}/workouts/${from}/${to}`),
    notes: (athleteId, from, to) =>
      get(`/fitness/v3/athletes/${athleteId}/calendarNote/${from}/${to}`, { missing: [404] }),
    // A workout entered by hand has no recording, and TrainingPeaks says so
    // with an empty 400 rather than an empty answer.
    detail: (athleteId, workoutId) =>
      get(`/fitness/v6/athletes/${athleteId}/workouts/${workoutId}/detaildata`, { missing: [400, 404] }),
    libraries: () => get("/exerciselibrary/v2/libraries", { missing: [404] }),
    libraryItems: (libraryId) => get(`/exerciselibrary/v2/libraries/${libraryId}/items`, { missing: [404] }),
  };
}

/** The coach's athletes from /users/v3/user, as id and name. */
export function athletesOf(user) {
  return (user?.user?.athletes ?? user?.athletes ?? [])
    .map((raw) => {
      const id = raw?.athleteId ?? raw?.personId ?? raw?.id;
      const name = raw?.fullName ?? raw?.name ?? [raw?.firstName, raw?.lastName].filter(Boolean).join(" ");
      return { id, name: String(name ?? "").trim() || `Athlete ${id}`, raw };
    })
    .filter((entry) => entry.id != null);
}

export function coachOf(user) {
  const me = user?.user ?? user ?? {};
  const name = me.fullName ?? [me.firstName, me.lastName].filter(Boolean).join(" ");
  return { personId: me.personId ?? me.userId ?? null, name: String(name ?? "").trim() };
}

/** A workout with a recording behind it, so worth asking for its detail. */
export function isDone(row) {
  return Boolean(row?.totalTime || row?.distance);
}

export function* ranges(from, to) {
  let start = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (start <= last) {
    const end = new Date(Math.min(start.getTime() + (RANGE_DAYS - 1) * 86_400_000, last.getTime()));
    yield [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
    start = new Date(end.getTime() + 86_400_000);
  }
}

/** Runs `work` over `items`, `limit` at a time, in order of start. */
async function pool(items, limit, work) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(lanes);
}

/**
 * Downloads the chosen athletes and dates into `store`, which has
 * `has(path)` and `write(path, value)`. `progress` is told what is happening
 * as it happens. Throws Cancelled when `signal` is aborted and SignInNeeded
 * when TrainingPeaks stops taking the token; what is in the store stays, so
 * the same call again carries on.
 */
export async function exportAccount({
  tp,
  store,
  user,
  athleteIds,
  from,
  to,
  library = true,
  concurrency = 4,
  signal = /** @type {AbortSignal | undefined} */ (undefined),
  progress = () => {},
  now = () => new Date(),
  appVersion = null,
}) {
  const check = () => {
    if (signal?.aborted) throw new Cancelled("Stopped.");
  };
  const coach = coachOf(user);
  const chosen = athletesOf(user).filter((entry) => athleteIds.map(String).includes(String(entry.id)));
  const manifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    app: appVersion,
    startedAt: now().toISOString(),
    finishedAt: null,
    source: TP_API,
    from,
    to,
    coach,
    library: null,
    athletes: [],
    problems: [],
  };
  const problem = (where, error) => manifest.problems.push({ where, message: String(error?.message ?? error) });
  const keep = async (path, read) => {
    check();
    const value = await read();
    await store.write(path, value);
    return value;
  };

  await store.write("coach/user.json", user);

  if (library) {
    progress({ step: "library" });
    try {
      const libraries = (await keep("library/libraries.json", () => tp.libraries())) ?? [];
      let items = 0;
      for (const lib of Array.isArray(libraries) ? libraries : []) {
        const id = lib?.exerciseLibraryId ?? lib?.libraryId ?? lib?.id;
        if (id == null) continue;
        try {
          const list = await keep(`library/${id}/items.json`, () => tp.libraryItems(id));
          items += Array.isArray(list) ? list.length : 0;
        } catch (error) {
          if (error instanceof SignInNeeded || error instanceof Cancelled) throw error;
          problem(`library ${id}`, error);
        }
      }
      manifest.library = { libraries: Array.isArray(libraries) ? libraries.length : 0, items };
    } catch (error) {
      if (error instanceof SignInNeeded || error instanceof Cancelled) throw error;
      problem("library", error);
    }
  }

  for (const [index, athlete] of chosen.entries()) {
    const base = `athletes/${athlete.id}`;
    const entry = { id: athlete.id, name: athlete.name, workouts: 0, completed: 0, details: 0, notes: 0 };
    const tell = (step, extra = {}) =>
      progress({ step, athlete: athlete.name, index, of: chosen.length, ...extra });
    tell("calendar");
    await store.write(`${base}/athlete.json`, athlete.raw);
    try {
      await keep(`${base}/settings.json`, () => tp.settings(athlete.id));
    } catch (error) {
      if (error instanceof SignInNeeded || error instanceof Cancelled) throw error;
      problem(`${athlete.name} settings`, error);
    }

    const done = [];
    for (const [start, end] of ranges(from, to)) {
      const rows = (await keep(`${base}/workouts/${start}_${end}.json`, () => tp.workouts(athlete.id, start, end))) ?? [];
      entry.workouts += rows.length;
      for (const row of rows) if (isDone(row) && row.workoutId != null) done.push(row.workoutId);
      try {
        const notes = await keep(`${base}/notes/${start}_${end}.json`, () => tp.notes(athlete.id, start, end));
        entry.notes += Array.isArray(notes) ? notes.length : 0;
      } catch (error) {
        if (error instanceof SignInNeeded || error instanceof Cancelled) throw error;
        problem(`${athlete.name} notes ${start}`, error);
      }
      tell("calendar", { workouts: entry.workouts });
    }
    entry.completed = done.length;

    let fetched = 0;
    tell("details", { done: 0, total: done.length });
    await pool(done, concurrency, async (workoutId) => {
      const path = `${base}/details/${workoutId}.json`;
      try {
        if (!(await store.has(path))) await keep(path, () => tp.detail(athlete.id, workoutId));
        entry.details++;
      } catch (error) {
        if (error instanceof SignInNeeded || error instanceof Cancelled) throw error;
        problem(`${athlete.name} workout ${workoutId}`, error);
      }
      tell("details", { done: ++fetched, total: done.length });
    });
    manifest.athletes.push(entry);
  }

  manifest.finishedAt = now().toISOString();
  await store.write("manifest.json", manifest);
  progress({ step: "finished" });
  return manifest;
}
