import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  exportAccount,
  trainingPeaks,
  ranges,
  athletesOf,
  SignInNeeded,
  Cancelled,
  PaymentRequired,
} from "./export.mjs";
import { folderStore, zipFolder } from "./store.mjs";

const user = {
  user: {
    personId: 5000,
    firstName: "Alex",
    lastName: "Rivera",
    athletes: [
      { athleteId: 11, firstName: "Sam", lastName: "Lee" },
      { athleteId: 12, firstName: "Robin", lastName: "Park" },
    ],
  },
};

function memoryStore() {
  const files = new Map<string, unknown>();
  return {
    files,
    has: async (path: string) => files.has(path),
    write: async (path: string, value: unknown) => void files.set(path, value),
  };
}

function fakeTp({ failDetail = new Set<number>() } = {}) {
  const asked: string[] = [];
  return {
    asked,
    user: async () => user,
    settings: async (id: number) => ({ athleteId: id, heartRateZones: [] }),
    workouts: async (id: number, from: string) => {
      asked.push(`workouts ${id} ${from}`);
      return from === "2026-09-01"
        ? [
            { workoutId: id * 100 + 1, workoutDay: "2026-09-02", totalTime: 1 },
            { workoutId: id * 100 + 2, workoutDay: "2026-09-03", totalTimePlanned: 1 },
          ]
        : [];
    },
    notes: async () => [{ id: 1, title: "Note" }],
    detail: async (_id: number, workoutId: number) => {
      asked.push(`detail ${workoutId}`);
      if (failDetail.has(workoutId)) throw new Error("TrainingPeaks answered 500");
      return { workoutId, flatSamples: { samples: [] } };
    },
    libraries: async () => [{ exerciseLibraryId: 500, libraryName: "My Library" }],
    libraryItems: async () => [{ exerciseLibraryItemId: 1 }, { exerciseLibraryItemId: 2 }],
  };
}

const response = (status: number, body?: unknown) =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status });

describe("ranges", () => {
  it("splits dates into 31-day pieces, end included", () => {
    expect([...ranges("2026-01-01", "2026-03-05")]).toEqual([
      ["2026-01-01", "2026-01-31"],
      ["2026-02-01", "2026-03-03"],
      ["2026-03-04", "2026-03-05"],
    ]);
  });
});

describe("athletesOf", () => {
  it("names athletes from the user answer", () => {
    expect(athletesOf(user).map(({ id, name }: { id: unknown; name: string }) => ({ id, name }))).toEqual([
      { id: 11, name: "Sam Lee" },
      { id: 12, name: "Robin Park" },
    ]);
  });
});

describe("trainingPeaks", () => {
  it("asks for a fresh token once on a 401, then gives up", async () => {
    const fresh: boolean[] = [];
    const statuses = [401, 200];
    const tp = trainingPeaks({
      token: async ({ fresh: f }: { fresh: boolean }) => (fresh.push(f), "t"),
      fetchImpl: async () => response(statuses.shift()!, { user: {} }),
    });
    await expect(tp.user()).resolves.toEqual({ user: {} });
    expect(fresh).toEqual([false, true]);

    const out = trainingPeaks({ token: async () => "t", fetchImpl: async () => response(401) });
    await expect(out.user()).rejects.toBeInstanceOf(SignInNeeded);
  });

  it("reads an empty 400 detail as no recording, and retries a 500", async () => {
    const statuses = [500, 400];
    const tp = trainingPeaks({ token: async () => "t", fetchImpl: async () => response(statuses.shift()!), retryMs: 0 });
    await expect(tp.detail(1, 2)).resolves.toBeNull();
    expect(statuses).toEqual([]);
  });

  it("stops at a 402 and keeps the reason TrainingPeaks gave", async () => {
    const tp = trainingPeaks({
      token: async () => "t",
      fetchImpl: async () => response(402, { message: "Premium required" }),
    });
    const refused = await tp.user().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PaymentRequired);
    expect(refused).toMatchObject({
      reason: "Premium required",
      message: "TrainingPeaks answered 402 Payment Required for /users/v3/user: Premium required",
    });

    const page = trainingPeaks({
      token: async () => "t",
      fetchImpl: async () => new Response("<html>Payment</html>", { status: 402 }),
    });
    await expect(page.user()).rejects.toMatchObject({ reason: "" });
  });
});

describe("exportAccount", () => {
  const choice = { user, athleteIds: ["11"], from: "2026-09-01", to: "2026-10-10" };

  it("keeps what TrainingPeaks answered, and a manifest", async () => {
    const store = memoryStore();
    const tp = fakeTp();
    const manifest = await exportAccount({ tp, store, ...choice, now: () => new Date("2026-10-13T10:00:00Z") });

    expect([...store.files.keys()].sort()).toEqual([
      "athletes/11/athlete.json",
      "athletes/11/details/1101.json",
      "athletes/11/notes/2026-09-01_2026-10-01.json",
      "athletes/11/notes/2026-10-02_2026-10-10.json",
      "athletes/11/settings.json",
      "athletes/11/workouts/2026-09-01_2026-10-01.json",
      "athletes/11/workouts/2026-10-02_2026-10-10.json",
      "coach/user.json",
      "library/500/items.json",
      "library/libraries.json",
      "manifest.json",
    ]);
    expect(store.files.get("athletes/11/athlete.json")).toEqual(user.user.athletes[0]);
    // Only the completed workout has a recording to ask for.
    expect(tp.asked.filter((line) => line.startsWith("detail"))).toEqual(["detail 1101"]);
    expect(manifest).toMatchObject({
      format: "trainingpeaks-export",
      version: 1,
      from: "2026-09-01",
      to: "2026-10-10",
      coach: { personId: 5000, name: "Alex Rivera" },
      library: { libraries: 1, items: 2 },
      athletes: [{ id: 11, name: "Sam Lee", workouts: 2, completed: 1, details: 1, notes: 2 }],
      problems: [],
      finishedAt: "2026-10-13T10:00:00.000Z",
    });
    expect(store.files.get("manifest.json")).toEqual(manifest);
  });

  it("carries on without the details it already has", async () => {
    const store = memoryStore();
    await exportAccount({ tp: fakeTp(), store, ...choice });
    const again = fakeTp();
    await exportAccount({ tp: again, store, ...choice });
    expect(again.asked.filter((line) => line.startsWith("detail"))).toEqual([]);
  });

  it("lists a workout it couldn't read and goes on", async () => {
    const store = memoryStore();
    const manifest = await exportAccount({
      tp: fakeTp({ failDetail: new Set([1101]) }),
      store,
      ...choice,
      athleteIds: ["11", "12"],
      library: false,
    });
    expect(manifest.problems).toEqual([{ where: "Sam Lee workout 1101", message: "TrainingPeaks answered 500" }]);
    expect(manifest.athletes.map((a: { details: number }) => a.details)).toEqual([0, 1]);
    expect(store.files.has("library/libraries.json")).toBe(false);
  });

  it("stops when asked, and when TrainingPeaks signs the coach out", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(exportAccount({ tp: fakeTp(), store: memoryStore(), ...choice, signal: controller.signal })).rejects.toBeInstanceOf(
      Cancelled,
    );
    const tp = { ...fakeTp(), detail: async () => Promise.reject(new SignInNeeded("out")) };
    const store = memoryStore();
    await expect(exportAccount({ tp, store, ...choice })).rejects.toBeInstanceOf(SignInNeeded);
    expect(store.files.has("manifest.json")).toBe(false);
  });
});

describe("zipFolder", () => {
  it("zips the folder under one top folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "tp-desktop-"));
    const store = folderStore(join(root, "work"));
    await store.write("athletes/11/details/1.json", { a: 1 });
    await store.write("manifest.json", { format: "trainingpeaks-export" });
    const target = join(root, "out.zip");
    await zipFolder(join(root, "work"), target, "TrainingPeaks Alex 2026-10-13");
    const listing = execFileSync("unzip", ["-Z1", target], { encoding: "utf8" }).trim().split("\n").sort();
    expect(listing).toEqual([
      "TrainingPeaks Alex 2026-10-13/athletes/11/details/1.json",
      "TrainingPeaks Alex 2026-10-13/manifest.json",
    ]);
    const manifest = execFileSync("unzip", ["-p", target, "TrainingPeaks Alex 2026-10-13/manifest.json"], { encoding: "utf8" });
    expect(JSON.parse(manifest)).toEqual({ format: "trainingpeaks-export" });
    expect(readFileSync(target).length).toBeGreaterThan(0);
  });
});
