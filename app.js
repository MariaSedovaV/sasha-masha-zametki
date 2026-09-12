const THEME_KEY = "sasha-theme";
const STORE_KEY = "sasha-masha-notes";
const MONTHS_WHEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const BULLET_RE = /^\s*(?:[-–—*•]|—)\s+(.*)$/;

const ui = {
  open: new Set(),
  editing: null,
  drafts: new Map(),
  rename: null,
  renameDraft: new Map(),
  pendingReload: false,
};

function isBusy() {
  return ui.open.size > 0 || Boolean(ui.rename);
}

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

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function validDue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
}

function convertDashLines(text) {
  return String(text || "").replace(/^(\s*)[-–—]\s+/gm, "$1• ");
}

function parseDetails(text) {
  const lines = convertDashLines(text).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let blankRun = 0;
  const flushPara = () => {
    if (!para.length) return;
    const cleaned = para.map((l) => l.replace(/[ \t]+$/, "")).join("\n");
    if (cleaned.trim()) blocks.push({ type: "p", text: cleaned });
    para = [];
  };
  const flushBlanks = () => {
    if (blankRun > 0) {
      blocks.push({ type: "gap", count: Math.min(12, blankRun) });
      blankRun = 0;
    }
  };
  for (const line of lines) {
    const m = line.match(/^\s*•\s+(.*)$/) || line.match(BULLET_RE);
    if (m) {
      flushPara();
      flushBlanks();
      const item = String(m[1] || "").trim();
      if (item) blocks.push({ type: "li", id: uid(), text: item, done: false });
    } else if (!line.trim()) {
      flushPara();
      blankRun += 1;
    } else {
      flushBlanks();
      para.push(line);
    }
  }
  flushPara();
  flushBlanks();
  return blocks;
}

function serializeDetails(blocks) {
  const lines = [];
  (blocks || []).forEach((b) => {
    if (b.type === "gap") {
      const n = Math.max(1, Math.min(12, Number(b.count) || 1));
      for (let i = 0; i < n; i += 1) lines.push("");
      return;
    }
    if (b.type === "li") {
      lines.push("• " + b.text);
      return;
    }
    if (b.text) String(b.text).split("\n").forEach((line) => lines.push(line));
  });
  return lines.join("\n");
}

function adoptDone(prev, next) {
  const map = new Map();
  (prev || []).forEach((b) => {
    if (b.type === "li") map.set(String(b.text || "").trim().toLowerCase(), b);
  });
  return (next || []).map((b) => {
    if (b.type !== "li") return b;
    const old = map.get(String(b.text || "").trim().toLowerCase());
    if (!old) return b;
    return { ...b, id: old.id, done: !!old.done };
  });
}

function normalizeBlock(b) {
  if (!b || typeof b !== "object") return null;
  if (b.type === "gap") {
    const count = Math.max(1, Math.min(12, Number(b.count) || 1));
    return { type: "gap", count };
  }
  if (b.type === "li") {
    const text = String(b.text || "").trim();
    if (!text) return null;
    return { type: "li", id: String(b.id || uid()), text, done: !!b.done };
  }
  const text = String(b.text || "").replace(/[ \t]+$/gm, "");
  if (!text.trim()) return { type: "gap", count: 1 };
  return { type: "p", text };
}

function normalizeTask(t) {
  if (!t || typeof t !== "object") return t;
  let details = [];
  if (Array.isArray(t.details)) details = t.details.map(normalizeBlock).filter(Boolean);
  else if (typeof t.details === "string") details = parseDetails(t.details);
  else if (typeof t.note === "string" && t.note.trim()) details = parseDetails(t.note);
  return { ...t, due: validDue(t.due), details };
}

function load() {
  try {
    const cloud = window.SashaCloud && typeof window.SashaCloud.snapshot === "function"
      ? window.SashaCloud.snapshot().notes
      : null;
    const raw = cloud || JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    return {
      sasha: (Array.isArray(raw?.sasha) ? raw.sasha : []).map(normalizeTask),
      masha: (Array.isArray(raw?.masha) ? raw.masha : []).map(normalizeTask),
    };
  } catch {
    return { sasha: [], masha: [] };
  }
}

function save(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify({
    sasha: state.sasha.filter((t) => !t.deleted),
    masha: state.masha.filter((t) => !t.deleted),
  }));
  if (window.SashaCloud && typeof window.SashaCloud.setNotes === "function") {
    window.SashaCloud.setNotes({ sasha: state.sasha, masha: state.masha });
  }
}

function taskKey(person, id) {
  return person + ":" + id;
}

function formatDue(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return null;
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((due - today) / 86400000);
  const label = d + " " + MONTHS_WHEN[m - 1];
  if (diff < 0) return { label, cls: "is-overdue", title: "срок прошёл" };
  if (diff === 0) return { label: "сегодня", cls: "is-today", title: "срок сегодня" };
  if (diff === 1) return { label: "завтра", cls: "is-soon", title: "срок завтра" };
  return { label, cls: "", title: "срок " + label };
}

const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l5 5 9-11"/></svg>`;

function renderBlocks(blocks, interactive) {
  if (!blocks.length) return "";
  return `<div class="detail-blocks">${blocks.map((b) => {
    if (b.type === "gap") {
      const n = Math.max(1, Math.min(12, Number(b.count) || 1));
      return `<div class="detail-gap" style="height:${n * 0.7}em" aria-hidden="true"></div>`;
    }
    if (b.type === "li") {
      const check = interactive
        ? `<button type="button" class="detail-check" data-bullet="${escapeHtml(b.id)}" aria-label="${b.done ? "Вернуть пункт" : "Отметить пункт сделанным"}">${CHECK}</button>`
        : `<span class="detail-check fake" aria-hidden="true">${b.done ? CHECK : ""}</span>`;
      return `<div class="detail-li ${b.done ? "done" : ""}">${check}<span class="detail-li-text">${escapeHtml(b.text)}</span></div>`;
    }
    return `<p class="detail-p">${escapeHtml(b.text).replace(/\n/g, "<br>")}</p>`;
  }).join("")}</div>`;
}

function renderExtra(person, t, editing) {
  const d = ensureDraft(person, t.id);
  const due = d.due || "";
  const blocks = Array.isArray(t.details) ? t.details : [];
  const showEditor = editing || !blocks.length;
  const view = showEditor
    ? `
      <label class="detail-editor detail-compose">
        <span>Пояснение</span>
        <textarea data-details-input rows="10" maxlength="4000" placeholder="Зачем это дело и что не забыть. Новая строка с тире станет пунктом:&#10;— позвонить в кассу&#10;— взять паспорт">${escapeHtml(d.details)}</textarea>
        <small class="detail-hint">Тире в начале строки станет пунктом. Пустая строка по Enter сохранится. Кружки «сделано» пишутся сразу.</small>
      </label>`
    : `<div class="detail-view">${renderBlocks(blocks, true)}</div>`;

  return `
    <div class="task-extra">
      <div class="detail-actions">
        <button type="button" class="detail-save" data-save-card>
          <span class="detail-save-mark">${CHECK}</span>
          <span data-save-label>Сохранить</span>
        </button>
        ${!showEditor && blocks.length ? `<button type="button" class="detail-btn" data-edit>Изменить пояснение</button>` : ""}
        ${showEditor && blocks.length ? `<button type="button" class="detail-btn" data-cancel-edit>Отмена</button>` : ""}
        ${blocks.length || (showEditor && d.details.trim()) ? `<button type="button" class="detail-btn danger" data-wipe>Удалить пояснение</button>` : ""}
      </div>
      <div class="detail-due-row">
        <label class="detail-due">
          <span>Срок</span>
          <input type="date" data-due value="${escapeHtml(due)}" />
        </label>
        ${due
          ? `<button type="button" class="detail-btn" data-clear-due>Без срока</button>`
          : `<span class="detail-due-hint">Если указать дату, дело появится в календаре у ${person === "sasha" ? "Саши" : "Маши"}</span>`}
      </div>
      ${view}
    </div>
  `;
}

function renderBoard(person) {
  captureOpenCards();
  const root = document.querySelector(`.board[data-person="${person}"]`);
  const items = state[person].filter((t) => !t.deleted).map(normalizeTask);
  const open = items.filter((t) => !t.done).length;
  const list = $("[data-list]", root);
  const count = $("[data-count]", root);
  count.textContent = `${open} ${plural(open, "открытое", "открытых", "открытых")}`;

  const ordered = [...items.filter((t) => !t.done), ...items.filter((t) => t.done)];
  if (!ordered.length) {
    list.innerHTML = `<li class="empty">Пока пусто. Напишите первое дело — и оно останется здесь.</li>`;
    return;
  }
  list.innerHTML = ordered.map((t) => {
    const key = taskKey(person, t.id);
    const opened = ui.open.has(key);
    const editing = ui.editing === key;
    const renaming = ui.rename === key;
    const hasExtra = Boolean(t.due) || (t.details && t.details.length);
    const due = t.due ? formatDue(t.due) : null;
    const titleValue = renaming ? (ui.renameDraft.get(key) ?? t.text) : t.text;
    return `
    <li class="task ${t.done ? "done" : ""} ${opened ? "open" : ""} ${renaming ? "renaming" : ""}" data-id="${t.id}">
      <button type="button" class="check" aria-label="${t.done ? "Вернуть в открытые" : "Отметить сделанным"}">${CHECK}</button>
      <div class="task-main">
        ${renaming
          ? `<div class="task-rename">
              <input class="task-title-input" data-title-input maxlength="180" value="${escapeHtml(titleValue)}" aria-label="Текст дела" />
              <button type="button" class="task-rename-save" data-rename-save aria-label="Сохранить название">${CHECK}</button>
            </div>`
          : `<button type="button" class="task-text" data-title title="Нажмите, чтобы изменить">${escapeHtml(t.text)}</button>`}
        ${due ? `<span class="task-due ${due.cls}" title="${escapeHtml(due.title)}">${escapeHtml(due.label)}</span>` : ""}
      </div>
      <button type="button" class="task-info ${hasExtra ? "has-extra" : ""}" data-info aria-expanded="${opened ? "true" : "false"}" aria-label="Пояснение и срок"><span>i</span></button>
      <button type="button" class="task-del" aria-label="Удалить">×</button>
      ${opened ? renderExtra(person, t, editing) : ""}
    </li>`;
  }).join("");
  list.querySelectorAll("[data-details-input]").forEach(fitDetailsEditor);
}

function findTask(person, id) {
  return state[person].find((t) => String(t.id) === String(id));
}

function touch(item) {
  if (!item) return;
  item.updatedAt = Date.now();
}

function addTask(person, text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
  state[person].push({
    id: uid(),
    text: clean,
    done: false,
    at: Date.now(),
    updatedAt: Date.now(),
    due: "",
    details: [],
  });
  save(state);
  renderBoard(person);
}

function toggleTask(person, id) {
  const item = findTask(person, id);
  if (!item) return;
  item.done = !item.done;
  touch(item);
  save(state);
  renderBoard(person);
}

function deleteTask(person, id) {
  const item = findTask(person, id);
  if (!item) return;
  item.deleted = true;
  touch(item);
  ui.open.delete(taskKey(person, id));
  ui.drafts.delete(taskKey(person, id));
  ui.renameDraft.delete(taskKey(person, id));
  if (ui.editing === taskKey(person, id)) ui.editing = null;
  if (ui.rename === taskKey(person, id)) ui.rename = null;
  save(state);
  renderBoard(person);
}

function clearBoard(person) {
  const now = Date.now();
  state[person].forEach((t) => {
    t.deleted = true;
    t.updatedAt = now;
  });
  [...ui.open].forEach((key) => {
    if (key.startsWith(person + ":")) ui.open.delete(key);
  });
  [...ui.drafts.keys()].forEach((key) => {
    if (key.startsWith(person + ":")) ui.drafts.delete(key);
  });
  save(state);
  renderBoard(person);
}

function ensureDraft(person, id) {
  const key = taskKey(person, id);
  if (!ui.drafts.has(key)) {
    const item = findTask(person, id);
    ui.drafts.set(key, {
      title: item?.text || "",
      due: item?.due || "",
      details: serializeDetails(item?.details || []),
    });
  }
  return ui.drafts.get(key);
}

function taskRoot(person, id) {
  return document.querySelector(`.board[data-person="${person}"] .task[data-id="${CSS.escape(id)}"]`);
}

function captureCard(person, id) {
  const d = ensureDraft(person, id);
  const root = taskRoot(person, id);
  if (!root) return d;
  const due = root.querySelector("[data-due]");
  const ta = root.querySelector("[data-details-input]");
  if (due) d.due = due.value;
  if (ta) d.details = ta.value;
  return d;
}

function captureOpenCards() {
  ui.open.forEach((key) => {
    const person = key.startsWith("sasha:") ? "sasha" : key.startsWith("masha:") ? "masha" : "";
    if (!person) return;
    captureCard(person, key.slice(person.length + 1));
  });
}

function commitCard(person, id) {
  const item = findTask(person, id);
  if (!item) return;
  const key = taskKey(person, id);
  const d = captureCard(person, id);
  item.due = validDue(d.due);
  if (ui.editing === key || taskRoot(person, id)?.querySelector("[data-details-input]")) {
    item.details = adoptDone(item.details, parseDetails(d.details));
  }
  touch(item);
  ui.drafts.delete(key);
  ui.editing = null;
  save(state);
  renderBoard(person);
}

function startRename(person, id) {
  const key = taskKey(person, id);
  if (ui.rename && ui.rename !== key) {
    const prev = ui.rename.split(":");
    commitRename(prev[0], prev.slice(1).join(":"));
  }
  const item = findTask(person, id);
  if (!item) return;
  ui.rename = key;
  if (!ui.renameDraft.has(key)) ui.renameDraft.set(key, item.text);
  renderBoard(person);
  const input = document.querySelector(`.board[data-person="${person}"] .task[data-id="${id}"] [data-title-input]`);
  if (!input) return;
  input.focus();
  input.select();
}

function commitRename(person, id) {
  const key = taskKey(person, id);
  if (ui.rename !== key) return;
  const root = document.querySelector(`.board[data-person="${person}"]`);
  const input = root?.querySelector(`.task[data-id="${CSS.escape(id)}"] [data-title-input]`);
  const raw = input ? input.value : ui.renameDraft.get(key);
  const item = findTask(person, id);
  const clean = String(raw || "").replace(/\s+/g, " ").trim();
  ui.rename = null;
  ui.renameDraft.delete(key);
  if (item && clean && clean !== item.text) {
    item.text = clean;
    touch(item);
    save(state);
  }
  renderBoard(person);
}

function cancelRename(person, id) {
  const key = taskKey(person, id);
  ui.rename = null;
  ui.renameDraft.delete(key);
  renderBoard(person);
}

function wipeDetails(person, id) {
  const d = ensureDraft(person, id);
  d.details = "";
  ui.editing = taskKey(person, id);
  renderBoard(person);
  focusDetails(person, id);
}

function toggleInfo(person, id) {
  const key = taskKey(person, id);
  if (ui.open.has(key)) {
    captureCard(person, id);
    ui.open.delete(key);
    ui.editing = null;
    renderBoard(person);
    if (!isBusy() && ui.pendingReload) {
      ui.pendingReload = false;
      applyCloudState();
    }
    return;
  }
  ui.open.add(key);
  const item = findTask(person, id);
  ensureDraft(person, id);
  if (item && !(item.details && item.details.length)) ui.editing = key;
  renderBoard(person);
  focusDetails(person, id);
}

function focusDetails(person, id) {
  const ta = document.querySelector(`.board[data-person="${person}"] .task[data-id="${id}"] [data-details-input]`);
  if (!ta) return;
  fitDetailsEditor(ta);
  ta.focus();
  const len = ta.value.length;
  try { ta.setSelectionRange(len, len); } catch {}
  ta.closest(".task")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function toggleBullet(person, id, bulletId, row) {
  const item = findTask(person, id);
  if (!item || !Array.isArray(item.details)) return;
  const block = item.details.find((b) => b.type === "li" && String(b.id) === String(bulletId));
  if (!block) return;
  block.done = !block.done;
  touch(item);
  const d = ui.drafts.get(taskKey(person, id));
  if (d) d.details = serializeDetails(item.details);
  if (row) {
    row.classList.toggle("done", block.done);
    const btn = row.querySelector("[data-bullet]");
    if (btn) btn.setAttribute("aria-label", block.done ? "Вернуть пункт" : "Отметить пункт сделанным");
  }
  save(state);
}

function applyDashConvert(ta) {
  const old = ta.value;
  const next = convertDashLines(old);
  if (next === old) return;
  const pos = ta.selectionStart;
  ta.value = next;
  try { ta.setSelectionRange(pos, pos); } catch {}
}

function fitDetailsEditor(ta) {
  if (!ta) return;
  ta.style.height = "auto";
  const min = 220;
  const max = Math.max(min, Math.round(window.innerHeight * 0.58));
  ta.style.height = Math.max(min, Math.min(max, ta.scrollHeight + 2)) + "px";
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

  const list = $("[data-list]", board);

  list.addEventListener("click", (e) => {
    const task = e.target.closest(".task");
    if (!task) return;
    const id = task.dataset.id;
    if (e.target.closest(".task-del")) {
      deleteTask(person, id);
      return;
    }
    if (e.target.closest("[data-info]")) {
      if (ui.rename === taskKey(person, id)) commitRename(person, id);
      toggleInfo(person, id);
      return;
    }
    if (e.target.closest("[data-rename-save]")) {
      commitRename(person, id);
      return;
    }
    if (e.target.closest("[data-title]")) {
      startRename(person, id);
      return;
    }
    if (e.target.closest(".check") && !e.target.closest(".detail-check")) {
      if (ui.rename === taskKey(person, id)) commitRename(person, id);
      toggleTask(person, id);
      return;
    }
    const bulletRow = e.target.closest(".detail-view .detail-li");
    if (bulletRow) {
      const btn = bulletRow.querySelector("[data-bullet]");
      if (btn) toggleBullet(person, id, btn.dataset.bullet, bulletRow);
      return;
    }
    if (e.target.closest("[data-edit]")) {
      captureCard(person, id);
      ui.editing = taskKey(person, id);
      renderBoard(person);
      focusDetails(person, id);
      return;
    }
    if (e.target.closest("[data-save-card]")) {
      commitCard(person, id);
      return;
    }
    if (e.target.closest("[data-cancel-edit]")) {
      const item = findTask(person, id);
      const d = ensureDraft(person, id);
      d.details = serializeDetails(item?.details || []);
      ui.editing = null;
      renderBoard(person);
      return;
    }
    if (e.target.closest("[data-clear-due]")) {
      const d = ensureDraft(person, id);
      d.due = "";
      const input = task.querySelector("[data-due]");
      if (input) input.value = "";
      return;
    }
    const wipe = e.target.closest("[data-wipe]");
    if (wipe) {
      if (!wipe.classList.contains("armed")) {
        list.querySelectorAll("[data-wipe].armed").forEach((b) => {
          b.classList.remove("armed");
          b.textContent = "Удалить пояснение";
        });
        wipe.classList.add("armed");
        wipe.textContent = "Точно удалить?";
        return;
      }
      wipeDetails(person, id);
    }
  });

  list.addEventListener("input", (e) => {
    const taskEl = e.target.closest(".task");
    if (!taskEl) return;
    const id = taskEl.dataset.id;
    const d = ensureDraft(person, id);
    const titleInline = e.target.closest("[data-title-input]");
    if (titleInline) {
      ui.renameDraft.set(taskKey(person, id), titleInline.value);
      return;
    }
    const due = e.target.closest("[data-due]");
    if (due) {
      d.due = due.value;
      return;
    }
    const ta = e.target.closest("[data-details-input]");
    if (!ta) return;
    applyDashConvert(ta);
    d.details = ta.value;
    fitDetailsEditor(ta);
  });

  list.addEventListener("keydown", (e) => {
    const title = e.target.closest("[data-title-input]");
    if (title) {
      const taskEl = title.closest(".task");
      if (!taskEl) return;
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename(person, taskEl.dataset.id);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRename(person, taskEl.dataset.id);
      }
      return;
    }
    const ta = e.target.closest("[data-details-input]");
    if (!ta || e.key !== "Enter" || e.shiftKey) return;
    const pos = ta.selectionStart;
    if (ta.selectionEnd !== pos) return;
    const before = ta.value.slice(0, pos);
    const line = before.split("\n").pop();
    const m = line.match(/^(\s*)•\s*(.*)$/);
    if (!m) return;
    e.preventDefault();
    if (!m[2].trim()) {
      const start = pos - line.length;
      ta.value = ta.value.slice(0, start) + "\n" + ta.value.slice(pos);
      try { ta.setSelectionRange(start + 1, start + 1); } catch {}
    } else {
      const insert = "\n• ";
      ta.value = ta.value.slice(0, pos) + insert + ta.value.slice(pos);
      const n = pos + insert.length;
      try { ta.setSelectionRange(n, n); } catch {}
    }
    const task = ta.closest(".task");
    if (task) ensureDraft(person, task.dataset.id).details = ta.value;
    fitDetailsEditor(ta);
  });

  list.addEventListener("change", (e) => {
    const due = e.target.closest("[data-due]");
    if (!due) return;
    const taskEl = due.closest(".task");
    if (taskEl) ensureDraft(person, taskEl.dataset.id).due = due.value;
  });

  const clearBtn = $("[data-clear]", board);
  clearBtn.addEventListener("click", () => {
    if (!state[person].filter((t) => !t.deleted).length) return;
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
  if (e.target.closest("[data-wipe]")) return;
  document.querySelectorAll("[data-wipe].armed").forEach((b) => {
    b.classList.remove("armed");
    b.textContent = "Удалить пояснение";
  });
});

function speechEngine() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

let activeMic = null;

function stopMic() {
  if (!activeMic) return;
  try { activeMic.rec.stop(); } catch {}
  activeMic.btn.classList.remove("listening");
  activeMic.btn.textContent = "Голос";
  const input = $("input", activeMic.btn.closest(".board"));
  if (input) input.placeholder = "Новое дело…";
  activeMic = null;
}

function startVoice(board, person) {
  const SpeechAPI = speechEngine();
  const btn = $("[data-mic]", board);
  const input = $("input", board);
  if (!SpeechAPI) {
    window.alert("Голосовой ввод работает в Chrome или Safari. В Firefox его нет — напишите дело текстом.");
    return;
  }
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
    btn.textContent = "Слушаю";
    input.placeholder = "Говорите…";
  };
  rec.onresult = (event) => {
    let transcript = "";
    let isFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) isFinal = true;
    }
    input.value = transcript.trim();
    if (isFinal && input.value) {
      addTask(person, input.value);
      input.value = "";
    }
  };
  rec.onerror = (event) => {
    if (event.error === "not-allowed") {
      window.alert("Нужно разрешить микрофон в настройках браузера — иначе голос не услышать.");
    }
    stopMic();
  };
  rec.onend = () => {
    if (input.value.trim()) {
      addTask(person, input.value);
      input.value = "";
    }
    input.placeholder = "Новое дело…";
    btn.classList.remove("listening");
    btn.textContent = "Голос";
    if (activeMic && activeMic.rec === rec) activeMic = null;
  };
  activeMic = { rec, btn };
  try { rec.start(); } catch { stopMic(); }
}

document.querySelectorAll(".board").forEach((board) => {
  $("[data-mic]", board).addEventListener("click", (e) => {
    e.preventDefault();
    startVoice(board, board.dataset.person);
  });
});

function renderSync() {
  const el = document.querySelector("[data-sync]");
  if (!el) return;
  const st = window.SashaCloud && typeof window.SashaCloud.status === "function"
    ? window.SashaCloud.status()
    : { ok: false };
  el.textContent = st.ok ? "на всех устройствах" : "сохраняется здесь";
  el.dataset.ok = st.ok ? "1" : "0";
}

function applyCloudState() {
  const fresh = load();
  state.sasha = fresh.sasha;
  state.masha = fresh.masha;
  renderBoard("sasha");
  renderBoard("masha");
  renderSync();
}

window.sashaNotesReload = function () {
  renderSync();
  if (isBusy()) {
    ui.pendingReload = true;
    return;
  }
  applyCloudState();
};

if (window.SashaCloud && typeof window.SashaCloud.subscribe === "function") {
  window.SashaCloud.subscribe(renderSync);
}
renderSync();
