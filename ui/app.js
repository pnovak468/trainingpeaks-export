const $ = (id) => document.getElementById(id);
const screens = ["loading", "signed-out", "choose", "running", "done"];
let athletes = [];
let picked = new Set();
let savedPath = null;
let steps = [];

document.body.classList.add(window.tp.platform);

function show(name) {
  for (const screen of screens) $(screen).hidden = screen !== name;
  $("account").hidden = name === "loading" || name === "signed-out";
}

function say(id, text) {
  $(id).querySelector("span").textContent = text ?? "";
  $(id).hidden = !text;
}

const isoDay = (date) => date.toISOString().slice(0, 10);
const monthsAgo = (months) => {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return isoDay(date);
};
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const dayLabel = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------------------------------------------------------------- choose

function signedOutError(state) {
  if (state.paymentRequired) {
    const said = state.reason ? ` TrainingPeaks said "${state.reason}".` : "";
    return `TrainingPeaks wants a paid subscription on this account before it shares the data.${said} Sign in with your coach account, or check the subscription on trainingpeaks.com.`;
  }
  return state.error ? `Couldn't reach TrainingPeaks: ${state.error}` : "";
}

function render(state) {
  if (!state.signedIn) {
    say("signed-out-error", signedOutError(state));
    show("signed-out");
    return;
  }
  const name = state.coach.name || "Signed in";
  $("coach").textContent = name;
  $("avatar").textContent = initials(name) || "?";
  athletes = state.athletes;
  picked = new Set(athletes.map((athlete) => String(athlete.id)));
  $("search").value = "";
  $("search-box").hidden = athletes.length <= 8;
  if (!$("from").value) $("from").value = monthsAgo(3);
  if (!$("to").value) $("to").value = monthsAgo(0);
  drawAthletes();
  say("choose-error", "");
  show("choose");
}

function drawAthletes() {
  const query = $("search").value.trim().toLowerCase();
  const shown = athletes.filter((athlete) => athlete.name.toLowerCase().includes(query));
  const list = $("athletes");
  if (!athletes.length) {
    list.replaceChildren(element("p", "empty", "No athletes on this TrainingPeaks account."));
  } else if (!shown.length) {
    list.replaceChildren(element("p", "empty", "No athlete by that name."));
  } else {
    list.replaceChildren(
      ...shown.map((athlete) => {
        const label = element("label");
        const box = element("input", "check");
        box.type = "checkbox";
        box.checked = picked.has(String(athlete.id));
        box.addEventListener("change", () => {
          if (box.checked) picked.add(String(athlete.id));
          else picked.delete(String(athlete.id));
          sum();
        });
        label.append(box, element("span", "name", athlete.name));
        return label;
      }),
    );
  }
  sum();
}

function sum() {
  $("athlete-count").textContent = athletes.length ? `${picked.size} of ${athletes.length}` : "";
  $("toggle-all").textContent = picked.size === athletes.length ? "Select none" : "Select all";
  $("toggle-all").hidden = !athletes.length;
  const from = $("from").value;
  const to = $("to").value;
  const parts = [plural(picked.size, "athlete")];
  if (from && to) parts.push(`${dayLabel(from)} – ${dayLabel(to)}`);
  if ($("library").checked) parts.push("library");
  $("choice-summary").textContent = parts.join(" · ");
  $("download").disabled = picked.size === 0 && !$("library").checked;
}

$("search").addEventListener("input", drawAthletes);
$("toggle-all").addEventListener("click", () => {
  picked = picked.size === athletes.length ? new Set() : new Set(athletes.map((athlete) => String(athlete.id)));
  drawAthletes();
});
for (const id of ["from", "to", "library"]) $(id).addEventListener("change", sum);

$("sign-in").addEventListener("click", async () => {
  $("sign-in").disabled = true;
  $("sign-in").textContent = "Waiting for TrainingPeaks…";
  try {
    render(await window.tp.signIn());
  } finally {
    $("sign-in").disabled = false;
    $("sign-in").textContent = "Sign in to TrainingPeaks";
  }
});

$("sign-out").addEventListener("click", async () => render(await window.tp.signOut()));

// ---------------------------------------------------------------- running

function drawSteps(library, chosen) {
  steps = [
    ...(library ? [{ key: "library", name: "Workout library" }] : []),
    ...chosen.map((athlete, index) => ({ key: index, name: athlete.name })),
  ].map((step) => {
    const row = element("div", "step");
    const dot = element("span", "dot");
    const state = element("span", "state", "Waiting");
    row.append(dot, element("span", "name", step.name), state);
    return { ...step, row, dot, state };
  });
  $("steps").replaceChildren(...steps.map((step) => step.row));
}

function mark(key, text) {
  let reached = false;
  for (const step of steps) {
    if (step.key === key) {
      reached = true;
      if (!step.row.classList.contains("active")) step.row.scrollIntoView({ block: "nearest" });
      step.row.className = "step active";
      step.state.textContent = text;
    } else if (!reached && !step.row.classList.contains("done")) {
      finish(step);
    }
  }
}

function finish(step) {
  step.row.className = "step done";
  step.state.textContent = "Done";
  step.dot.replaceChildren(icon("check"));
}

function percent(value) {
  const rounded = Math.max(0, Math.min(100, Math.round(value * 100)));
  $("meter").style.width = `${rounded}%`;
  $("percent").textContent = `${rounded}%`;
}

window.tp.onProgress((event) => {
  if (event.step === "library") {
    mark("library", "Downloading");
    $("status").textContent = "Workout library";
  }
  if (event.step === "calendar" || event.step === "details") {
    const part = event.step === "details" && event.total ? event.done / event.total : 0;
    percent((event.index + 0.08 + 0.92 * part) / event.of);
    const text =
      event.step === "calendar"
        ? event.workouts
          ? plural(event.workouts, "workout")
          : "Calendar"
        : `${event.done} / ${event.total}`;
    mark(event.index, text);
    $("status").textContent = `Athlete ${event.index + 1} of ${event.of}`;
  }
  if (event.step === "finished" || event.step === "zipping") {
    for (const step of steps) if (!step.row.classList.contains("done")) finish(step);
    percent(1);
    $("status").textContent = "Putting the zip together…";
  }
});

$("download").addEventListener("click", async () => {
  const from = $("from").value;
  const to = $("to").value;
  if (!from || !to || to < from) {
    say("choose-error", "Pick a From date before the To date.");
    return;
  }
  say("choose-error", "");
  const chosen = athletes.filter((athlete) => picked.has(String(athlete.id)));
  const library = $("library").checked;
  drawSteps(library, chosen);
  percent(0);
  $("status").textContent = "Starting…";
  $("stop").disabled = false;
  show("running");
  const result = await window.tp.download({ athleteIds: chosen.map((athlete) => athlete.id), from, to, library });
  if (result.cancelled) return show("choose");
  if (result.error === "signin") {
    render({ signedIn: false });
    say("signed-out-error", "TrainingPeaks signed you out. Sign in, then press Download with the same choices: it carries on where it stopped.");
    return;
  }
  if (result.error) {
    show("choose");
    say("choose-error", `The download stopped: ${result.error}. Press Download again to carry on where it was.`);
    return;
  }
  drawDone(result);
});

$("stop").addEventListener("click", () => {
  $("stop").disabled = true;
  $("status").textContent = "Stopping…";
  window.tp.stop();
});

// ---------------------------------------------------------------- done

function drawDone(result) {
  savedPath = result.path;
  const cut = Math.max(result.path.lastIndexOf("/"), result.path.lastIndexOf("\\"));
  $("file-name").textContent = result.path.slice(cut + 1);
  $("file-folder").textContent = result.path.slice(0, cut) || result.path;
  const total = (key) => result.athletes.reduce((sum, athlete) => sum + (athlete[key] ?? 0), 0);
  const stats = [
    [result.athletes.length, "Athletes"],
    [total("workouts"), "Workouts"],
    [total("details"), "Recordings"],
    ...(result.library ? [[result.library.items, "Library"]] : []),
  ];
  $("stats").replaceChildren(
    ...stats.map(([value, label]) => {
      const stat = element("div", "stat");
      stat.append(element("b", null, value.toLocaleString()), element("span", null, label));
      return stat;
    }),
  );
  say(
    "problems",
    result.problems.length
      ? `${plural(result.problems.length, "item")} couldn't be downloaded. They're listed in manifest.json inside the zip.`
      : "",
  );
  show("done");
}

$("show").addEventListener("click", () => savedPath && window.tp.show(savedPath));
$("again").addEventListener("click", () => show("choose"));

window.tp.state().then(render);
