const THEME_KEY = "sasha-theme";
const STORE_KEY = "sasha-masha-notes";

function $(sel, root = document) {
  return root.querySelector(sel);
}

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "light" ? "Тёмная" : "Светлая";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f3eee4" : "#0b0c10");
}

function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (d === 1) return one;
  if (d >= 2 && d <= 4) return few;
  return many;
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    return {
      sasha: Array.isArray(raw?.sasha) ? raw.sasha : [],
      masha: Array.isArray(raw?.masha) ? raw.masha : [],
    };
  } catch {
    return { sasha: [], masha: [] };
  }
}

function save(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l5 5 9-11"/></svg>`;

function renderBoard(person) {
  const root = document.querySelector(`.board[data-person="${person}"]`);
  const items = state[person];
  const open = items.filter((t) => !t.done).length;
  const list = $("[data-list]", root);
  const count = $("[data-count]", root);
  count.textContent = `${open} ${plural(open, "открытое", "открытых", "открытых")}`;

  const ordered = [...items.filter((t) => !t.done), ...items.filter((t) => t.done)];
  if (!ordered.length) {
    list.innerHTML = `<li class="empty">Пока пусто. Напишите первое дело — и оно останется здесь.</li>`;
    return;
  }
  list.innerHTML = ordered.map((t) => `
    <li class="task ${t.done ? "done" : ""}" data-id="${t.id}">
      <button type="button" class="check" aria-label="${t.done ? "Вернуть в открытые" : "Отметить сделанным"}">${CHECK}</button>
      <span class="task-text">${escapeHtml(t.text)}</span>
    </li>
  `).join("");
}

function addTask(person, text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
  state[person].push({ id: uid(), text: clean, done: false, at: Date.now() });
  save(state);
  renderBoard(person);
}

function toggleTask(person, id) {
  const item = state[person].find((t) => t.id === id);
  if (!item) return;
  item.done = !item.done;
  save(state);
  renderBoard(person);
}

function clearBoard(person) {
  state[person] = [];
  save(state);
  renderBoard(person);
}

const state = load();
applyTheme(currentTheme());
document.getElementById("theme-toggle").addEventListener("click", () => {
  applyTheme(currentTheme() === "light" ? "dark" : "light");
});

document.querySelectorAll(".board").forEach((board) => {
  const person = board.dataset.person;
  renderBoard(person);

  $("[data-form]", board).addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("input", board);
    addTask(person, input.value);
    input.value = "";
    input.focus();
  });

  $("[data-list]", board).addEventListener("click", (e) => {
    const btn = e.target.closest(".check");
    if (!btn) return;
    const id = btn.closest(".task")?.dataset.id;
    if (id) toggleTask(person, id);
  });

  const clearBtn = $("[data-clear]", board);
  clearBtn.addEventListener("click", () => {
    if (!state[person].length) return;
    if (!clearBtn.classList.contains("armed")) {
      document.querySelectorAll(".clear-btn.armed").forEach((b) => {
        b.classList.remove("armed");
        b.textContent = "Очистить";
      });
      clearBtn.classList.add("armed");
      clearBtn.textContent = "Точно?";
      return;
    }
    clearBoard(person);
    clearBtn.classList.remove("armed");
    clearBtn.textContent = "Очистить";
  });
});

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-clear]")) return;
  document.querySelectorAll(".clear-btn.armed").forEach((b) => {
    b.classList.remove("armed");
    b.textContent = "Очистить";
  });
});

const SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeMic = null;

function stopMic() {
  if (!activeMic) return;
  try { activeMic.rec.stop(); } catch {}
  activeMic.btn.classList.remove("listening");
  activeMic = null;
}

function startVoice(board, person) {
  const btn = $("[data-mic]", board);
  const input = $("input", board);
  if (!SpeechAPI) return;
  if (activeMic && activeMic.btn === btn) {
    stopMic();
    return;
  }
  stopMic();
  const rec = new SpeechAPI();
  rec.lang = "ru-RU";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  rec.onstart = () => {
    btn.classList.add("listening");
    input.placeholder = "Слушаю…";
  };
  rec.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        addTask(person, transcript);
        input.value = "";
        return;
      }
    }
    input.value = transcript.trim();
  };
  rec.onerror = () => stopMic();
  rec.onend = () => {
    input.placeholder = "Новое дело…";
    btn.classList.remove("listening");
    if (activeMic && activeMic.rec === rec) activeMic = null;
  };
  activeMic = { rec, btn };
  try { rec.start(); } catch { stopMic(); }
}

if (!SpeechAPI) {
  document.querySelectorAll("[data-mic]").forEach((btn) => btn.classList.add("unsupported"));
} else {
  document.querySelectorAll(".board").forEach((board) => {
    $("[data-mic]", board).addEventListener("click", (e) => {
      e.preventDefault();
      startVoice(board, board.dataset.person);
    });
  });
}
