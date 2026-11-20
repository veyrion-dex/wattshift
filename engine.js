"use strict";
const Watt = (() => {
  const HOURS = 24;
  const MAX_DEVICES = 8;
  const SEARCH_LIMIT = 180000;
  const PRICE_SCALE = 10000;
  const COST_SCALE = PRICE_SCALE * 1000;
  const hours = () => Array(HOURS).fill(0);
  const validPrice = value => typeof value === "number" && Number.isFinite(value) &&
    Math.abs(value) <= 1000 && Math.abs(value - Math.round(value * PRICE_SCALE) / PRICE_SCALE) < 1e-10;
  const validInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

  function parseTariff(source) {
    if (typeof source !== "string" || source.length > 20000) throw new Error("CSV должен занимать не более 20 КБ.");
    const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const header = lines.shift() || "";
    const separator = header.includes(";") ? ";" : ",";
    if (header.toLowerCase().replaceAll(" ", "") !== ["hour", "price"].join(separator)) {
      throw new Error("В первой строке CSV нужны столбцы hour и price.");
    }
    const prices = Array(HOURS);
    for (const [index, line] of lines.entries()) {
      const [hour, raw, ...extra] = line.split(separator).map(cell => cell.trim());
      const decimal = separator === ";" ? raw?.replace(",", ".") : raw;
      const match = /^(\d{1,2})(?::00)?$/.exec(hour);
      const value = Number(decimal);
      if (!match || extra.length || !validInteger(Number(match[1]), 0, 23) ||
          !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(decimal || "") || !validPrice(value)) {
        throw new Error("Неверный час или цена в строке данных " + (index + 1) + ".");
      }
      const slot = Number(match[1]);
      if (prices[slot] !== undefined) throw new Error("Час " + slot + " указан дважды.");
      prices[slot] = value;
    }
    if (prices.includes(undefined)) throw new Error("В CSV нужен ровно один тариф для каждого часа от 00 до 23.");
    return prices;
  }

  function validate(model, {allowEmpty = false} = {}) {
    if (!model || !Array.isArray(model.prices) || model.prices.length !== HOURS ||
        Array.from(model.prices).some(value => typeof value !== "number" || !validPrice(value))) {
      throw new Error("Импортируй 24 конечные почасовые цены в диапазоне от −1000 до 1000, до 4 знаков после запятой.");
    }
    if (!validInteger(model.cap, 1, 100000)) throw new Error("Лимит мощности должен быть целым числом от 1 до 100 000 Вт.");
    if (!Array.isArray(model.devices) || (!allowEmpty && model.devices.length < 1) || model.devices.length > MAX_DEVICES) {
      throw new Error("Добавь от 1 до " + MAX_DEVICES + " приборов.");
    }
    const ids = new Set();
    for (const [index, device] of model.devices.entries()) {
      if (!device || typeof device.id !== "string" || !device.id || ids.has(device.id) ||
          typeof device.name !== "string" || !device.name.trim() || device.name.length > 60 ||
          !validInteger(device.watts, 1, 100000) || !validInteger(device.duration, 1, 24) ||
          !validInteger(device.earliest, 0, 23) || !validInteger(device.latest, 1, 24) ||
          device.latest - device.earliest < device.duration || !validInteger(device.usual, 0, 23) ||
          device.usual < device.earliest || device.usual + device.duration > device.latest) {
        throw new Error("Прибор " + (index + 1) + ": проверь название, мощность, длительность, окно и обычный старт.");
      }
      ids.add(device.id);
    }
  }

  function bill(prices, device, start) {
    let result = 0;
    for (let hour = start; hour < start + device.duration; hour += 1) result += Math.round(prices[hour] * PRICE_SCALE) * device.watts;
    return result;
  }

  function evaluate(model, starts) {
    validate(model);
    const load = hours();
    const rows = model.devices.map(device => {
      const start = starts[device.id];
      const end = start + device.duration;
      if (!validInteger(start, device.earliest, device.latest - device.duration)) {
        throw new Error("Старт вне допустимого окна: " + device.name);
      }
      for (let hour = start; hour < end; hour += 1) load[hour] += device.watts;
      return {...device, start, end, cost: bill(model.prices, device, start) / COST_SCALE};
    });
    const exceed = load.flatMap((watts, hour) => watts > model.cap ? [hour] : []);
    return {
      rows, load, exceed, peak: Math.max(...load),
      cost: rows.reduce((sum, row) => sum + row.cost, 0),
      energy: rows.reduce((sum, row) => sum + row.watts * row.duration / 1000, 0)
    };
  }

  function optimize(model, limit = SEARCH_LIMIT) {
    validate(model);
    if (!validInteger(limit, 1, SEARCH_LIMIT)) throw new Error("Неверный лимит поиска.");
    const baseline = evaluate(model, Object.fromEntries(model.devices.map(device => [device.id, device.usual])));
    const jobs = model.devices.map(device => {
      const candidates = [];
      for (let start = device.earliest; start <= device.latest - device.duration; start += 1) {
        candidates.push({start, end: start + device.duration, cost: bill(model.prices, device, start)});
      }
      candidates.sort((a, b) => a.cost - b.cost || a.start - b.start);
      return {...device, candidates};
    }).sort((a, b) => a.candidates.length - b.candidates.length || b.watts - a.watts);
    const bound = Array(jobs.length + 1).fill(0);
    for (let i = jobs.length - 1; i >= 0; i -= 1) bound[i] = bound[i + 1] + jobs[i].candidates[0].cost;

    const load = hours();
    const starts = Object.create(null);
    let best = baseline.exceed.length ? null : Object.fromEntries(model.devices.map(device => [device.id, device.usual]));
    let bestCost = best ? jobs.reduce((sum, job) => sum + bill(model.prices, job, job.usual), 0) : Infinity;
    let visited = 0;
    let complete = true;

    function search(index, cost) {
      if (cost + bound[index] >= bestCost) return;
      if (visited >= limit) {
        complete = false;
        return;
      }
      visited += 1;
      if (index === jobs.length) {
        best = {...starts};
        bestCost = cost;
        return;
      }
      const job = jobs[index];
      for (const option of job.candidates) {
        if (!complete || cost + option.cost + bound[index + 1] >= bestCost) break;
        let fits = true;
        for (let hour = option.start; hour < option.end; hour += 1) {
          if (load[hour] + job.watts > model.cap) {
            fits = false;
            break;
          }
        }
        if (!fits) continue;
        for (let hour = option.start; hour < option.end; hour += 1) load[hour] += job.watts;
        starts[job.id] = option.start;
        search(index + 1, cost + option.cost);
        for (let hour = option.start; hour < option.end; hour += 1) load[hour] -= job.watts;
      }
    }
    if (!jobs.some(job => job.watts > model.cap)) search(0, 0);
    const bestPlan = best ? evaluate(model, best) : null;
    return {
      baseline, best: bestPlan, complete, visited,
      savings: bestPlan && !baseline.exceed.length ? Math.round((baseline.cost - bestPlan.cost) * COST_SCALE) / COST_SCALE : null
    };
  }

  const clock = hour => String(hour).padStart(2, "0") + ":00";
  function tariffCSV(prices) {
    return "hour,price\n" + prices.map((price, hour) => clock(hour) + "," + price).join("\n") + "\n";
  }
  function scheduleCSV(plan) {
    const quote = value => '"' + (/^[=+@\-\t\r\n]/.test(value.trimStart()) ? "'" : "") + value.replaceAll('"', '""') + '"';
    return "device,start,end,watts,kwh,cost\n" + plan.rows.map(row =>
      [quote(row.name), clock(row.start), clock(row.end), row.watts, row.watts * row.duration / 1000, row.cost.toFixed(6)].join(",")
    ).join("\n") + "\n";
  }

  function demo() {
    return {
      label: "Демонстрационный тариф", cap: 3200,
      prices: [0.14,0.13,0.12,0.11,0.12,0.15,0.23,0.28,0.29,0.23,0.20,0.19,0.17,0.18,0.19,0.22,0.28,0.35,0.39,0.36,0.30,0.24,0.20,0.16],
      devices: [
        {id: "washer", name: "Стиральная машина", watts: 1100, duration: 2, earliest: 8, latest: 21, usual: 18},
        {id: "dishwasher", name: "Посудомоечная машина", watts: 1400, duration: 2, earliest: 10, latest: 24, usual: 20},
        {id: "charger", name: "Зарядное устройство", watts: 1600, duration: 3, earliest: 17, latest: 24, usual: 17}
      ]
    };
  }
  return {parseTariff, validate, evaluate, optimize, clock, tariffCSV, scheduleCSV, demo, MAX_DEVICES};
})();
if (typeof module !== "undefined") module.exports = Watt;
