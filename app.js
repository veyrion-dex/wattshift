"use strict";
const byId = id => document.getElementById(id);
const modelKey = "wattshift-model-v1";
const format = new Intl.NumberFormat("ru", {maximumFractionDigits: 4});
const price = value => format.format(value) + " ед.";
const clock = Watt.clock;
const form = byId("device-form");
const cap = byId("cap");
const statusMessage = byId("result-status");
let edited = null;
let run = 0;
let result = null;
let serial = 0;
let loaded = false;

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(modelKey));
    if (saved) {
      Watt.validate(saved, {allowEmpty: true});
      loaded = true;
      return {...saved, label: typeof saved.label === "string" ? saved.label.slice(0, 120) : "Сохранённый тариф"};
    }
  } catch {
    byId("storage-note").textContent = " Сохранённый набор недоступен.";
  }
  return Watt.demo();
}

let model = restore();

function save() {
  try {
    localStorage.setItem(modelKey, JSON.stringify(model));
    byId("storage-note").textContent = " Настройки сохранены в этом браузере.";
  } catch {
    byId("storage-note").textContent = " Браузер не предоставил локальное хранилище.";
  }
}

function make(tag, value = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
}

function action(label, detail, callback) {
  const button = make("button", label, "quiet");
  button.type = "button";
  button.setAttribute("aria-label", detail);
  button.onclick = callback;
  return button;
}

function renderDevices() {
  const list = byId("devices-list");
  list.replaceChildren();
  byId("new").disabled = model.devices.length >= Watt.MAX_DEVICES;
  if (!model.devices.length) list.append(make("li", "Добавь прибор, чтобы рассчитать план.", "muted"));
  for (const device of model.devices) {
    const item = make("li");
    const info = make("div", "", "device-title");
    info.append(make("strong", device.name), make("p", [
      device.watts + " Вт", device.duration + " ч", clock(device.earliest) + "–" + clock(device.latest)
    ].join(" · "), "muted"));
    const controls = make("div", "", "device-actions");
    controls.append(action("Изменить", "Изменить: " + device.name, () => edit(device)));
    controls.append(action("Удалить", "Удалить: " + device.name, () => {
      if (!window.confirm("Удалить прибор «" + device.name + "» из этого плана?")) return;
      model = {...model, devices: model.devices.filter(item => item.id !== device.id)};
      if (edited === device.id) form.hidden = true;
      changeModel();
      byId("new").focus();
    }));
    item.append(info, controls);
    list.append(item);
  }
}

function setEditor(data) {
  for (const [name, value] of Object.entries(data)) form.elements.namedItem(name).value = value;
}

function edit(device) {
  edited = device?.id ?? null;
  byId("editor-title").textContent = device ? "Изменить прибор" : "Новый прибор";
  byId("device-error").textContent = "";
  setEditor({
    deviceName: device?.name ?? "", watts: device?.watts ?? 1000, duration: device?.duration ?? 1,
    earliest: device?.earliest ?? 8, latest: device?.latest ?? 22, usual: device?.usual ?? 18
  });
  form.hidden = false;
  byId("name").focus();
}

function invalidate(message) {
  run += 1;
  result = null;
  byId("result-content").hidden = true;
  byId("export").disabled = true;
  byId("calculate").disabled = false;
  byId("calc-error").textContent = "";
  statusMessage.textContent = message;
  for (const id of ["baseline", "optimal", "saving", "energy"]) byId(id).textContent = "—";
}

function changeModel(message = "Данные изменены. Рассчитай расписание заново.") {
  invalidate(message);
  byId("tariff-name").textContent = model.label;
  renderDevices();
  save();
}

function download(name, source) {
  const url = URL.createObjectURL(new Blob(["\uFEFF", source], {type: "text/csv;charset=utf-8"}));
  const link = make("a");
  link.download = name;
  link.href = url;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function applyTariff(source, label) {
  try {
    const prices = Watt.parseTariff(source);
    model = {...model, prices, label};
    byId("csv-error").textContent = "";
    changeModel("Тариф принят. Рассчитай расписание с новыми ценами.");
  } catch (error) {
    byId("csv-error").textContent = error.message;
  }
}

function timeRange(row) {
  return row ? clock(row.start) + "–" + clock(row.end) : "—";
}

function fillTable(body, groups) {
  body.replaceChildren();
  for (const group of groups) {
    const row = make("tr");
    const label = make("th", group[0]);
    label.scope = "row";
    row.append(label);
    for (const cell of group.slice(1)) row.append(make("td", cell));
    body.append(row);
  }
}

function renderResult() {
  const {baseline, best, savings, complete, visited} = result;
  byId("baseline").textContent = price(baseline.cost);
  byId("optimal").textContent = best ? price(best.cost) : "—";
  byId("saving").textContent = savings === null ? "—" : price(savings);
  byId("energy").textContent = format.format(baseline.energy) + " кВт·ч";
  const initialOver = baseline.exceed.length
    ? " Обычный план превышает лимит в " + baseline.exceed.map(clock).join(", ") + "."
    : "";
  statusMessage.textContent = best
    ? (complete ? "Найден план с минимальными затратами." : "Найден допустимый план. Лимит поиска не позволил доказать оптимальность.") + initialOver
    : (complete ? "При этих ограничениях допустимого плана нет. Проверь окна приборов и лимит." :
      "В пределах лимита поиска допустимый план не найден. Попробуй сократить число приборов.") + initialOver;
  statusMessage.textContent += " Проверено состояний: " + format.format(visited) + ".";
  byId("result-content").hidden = false;
  byId("export").disabled = !best;
  const chosen = new Map(best?.rows.map(row => [row.id, row]));
  fillTable(byId("schedule-rows"), baseline.rows.map(row => {
    const after = chosen.get(row.id);
    return [row.name, timeRange(row), timeRange(after), after ? price(after.cost) : "—"];
  }));
  fillTable(byId("hour-rows"), model.prices.map((value, hour) => [
    clock(hour), price(value), format.format(baseline.load[hour]), best ? format.format(best.load[hour]) : "—"
  ]));
  byId("peak").textContent = "Пик нагрузки: " + format.format(baseline.peak) + " Вт → " +
    (best ? format.format(best.peak) + " Вт" : "—") + ". Лимит: " + format.format(model.cap) + " Вт.";
  const chart = byId("chart");
  chart.replaceChildren();
  const max = Math.max(1, baseline.peak, best?.peak ?? 0);
  for (const [hour, watts] of baseline.load.entries()) {
    const column = make("div", "", "column");
    const bars = make("div", "", "bars");
    const original = make("span", "", "bar baseline-bar");
    original.style.height = watts * 100 / max + "%";
    const optimized = make("span", "", "bar optimal-bar");
    optimized.style.height = (best?.load[hour] ?? 0) * 100 / max + "%";
    bars.append(original, optimized);
    column.append(bars, make("span", hour % 3 ? "" : String(hour), "hour"));
    chart.append(column);
  }
}

function calculate() {
  invalidate("Подбираем расписание…");
  const job = run;
  const candidate = {...model, cap: cap.valueAsNumber};
  byId("calculate").disabled = true;
  window.setTimeout(() => {
    if (job !== run) return;
    try {
      result = Watt.optimize(candidate);
      model = candidate;
      save();
      renderResult();
    } catch (error) {
      byId("calc-error").textContent = error.message;
      statusMessage.textContent = "Исправь исходные данные и повтори расчёт.";
    } finally {
      byId("calculate").disabled = false;
    }
  }, 25);
}

byId("limit-form").onsubmit = event => { event.preventDefault(); calculate(); };
cap.addEventListener("input", () => invalidate("Лимит изменён. Рассчитай расписание заново."));
byId("new").onclick = () => edit();
byId("cancel").onclick = () => { form.hidden = true; byId("new").focus(); };
form.onsubmit = event => {
  event.preventDefault();
  const id = edited ?? (globalThis.crypto?.randomUUID?.() || "device-" + Date.now() + "-" + serial++);
  const number = name => form.elements.namedItem(name).valueAsNumber;
  const device = {
    id, name: byId("name").value.trim(), watts: number("watts"), duration: number("duration"),
    earliest: number("earliest"), latest: number("latest"), usual: number("usual")
  };
  const devices = edited ? model.devices.map(item => item.id === id ? device : item) : [...model.devices, device];
  try {
    Watt.validate({...model, devices});
  } catch (error) {
    byId("device-error").textContent = error.message;
    return;
  }
  model = {...model, devices};
  form.hidden = true;
  changeModel();
  const next = byId("new").disabled ? byId("calculate") : byId("new");
  next.focus();
};
byId("file").addEventListener("change", async event => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  const element = event.currentTarget;
  try {
    if (file.size > 20000) throw new Error("Выбери CSV размером не более 20 КБ.");
    const source = await file.text();
    if (element.files[0] !== file) return;
    byId("csv").value = source;
    applyTariff(source, file.name.slice(0, 120));
  } catch (error) {
    byId("csv-error").textContent = error.message;
  } finally {
    if (element.files[0] === file) element.value = "";
  }
});
byId("import").onclick = () => applyTariff(byId("csv").value, "Вставленный CSV");
byId("template").onclick = () => download("tariff-example.csv", Watt.tariffCSV(Watt.demo().prices));
byId("export").onclick = () => { if (result?.best) download("wattshift-schedule.csv", Watt.scheduleCSV(result.best)); };
byId("example").onclick = () => {
  if (!window.confirm("Заменить текущие приборы, тариф и лимит демонстрационными данными?")) return;
  model = Watt.demo();
  form.hidden = true;
  cap.value = model.cap;
  byId("csv").value = "";
  byId("csv-error").textContent = "";
  changeModel();
  calculate();
};

cap.value = model.cap;
byId("tariff-name").textContent = model.label;
renderDevices();
if (model.devices.length) calculate();
else if (loaded) statusMessage.textContent = "Последний набор восстановлен. Добавь прибор, чтобы рассчитать план.";
