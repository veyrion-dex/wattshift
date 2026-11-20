const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const Watt = require("./engine.js");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const modelKey = "wattshift-model-v1";

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.value = "";
    this.listeners = new Map();
  }
  get valueAsNumber() { return this.value === "" ? NaN : Number(this.value); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  focus() { this.focused = true; }
  setAttribute() {}
  click() { this.onclick?.(); }
  remove() {}
}

function mount(storage = new Map()) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element(id)]));
  const get = id => {
    assert.ok(nodes.has(id), "Missing ID in index.html: " + id);
    return nodes.get(id);
  };
  const fields = new Map(Object.entries({deviceName: get("name")}));
  get("device-form").elements = {
    namedItem(name) {
      if (!fields.has(name)) fields.set(name, new Element("input"));
      return fields.get(name);
    }
  };
  const timers = [];
  const downloads = [];
  vm.runInNewContext(source, {
    Watt, Blob, Intl,
    document: {getElementById: get, createElement: tag => new Element(tag), body: new Element("body")},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    URL: {createObjectURL: blob => { downloads.push(blob); return "blob:testing"; }, revokeObjectURL() {}},
    window: {confirm: () => true, setTimeout: callback => timers.push(callback)}
  });
  const flush = () => { while (timers.length) timers.shift()(); };
  const submit = id => get(id).onsubmit({preventDefault() {}});
  flush();
  return {get, flush, submit, storage, downloads, fields};
}

test("demo renders the results and exports the calculated schedule", async () => {
  const app = mount();
  assert.match(app.get("optimal").textContent, /1,835/);
  assert.equal(app.get("chart").children.length, 24);
  assert.equal(app.get("schedule-rows").children.length, 3);
  app.get("export").click();
  assert.equal(app.downloads.length, 1);
  assert.match(await app.downloads[0].text(), /Стиральная машина/);
});

test("invalid input preserves prior plan and a new tariff is used and restored", () => {
  const app = mount();
  app.get("csv").value = "hour,price\n0,1";
  app.get("import").click();
  assert.match(app.get("csv-error").textContent, /каждого часа/);
  assert.match(app.get("optimal").textContent, /1,835/);
  const prices = Array(24).fill(0.4);
  app.get("csv").value = Watt.tariffCSV(prices);
  app.get("import").click();
  assert.equal(app.get("export").disabled, true);
  app.submit("limit-form");
  app.flush();
  assert.match(app.get("optimal").textContent, /3,92/);
  assert.deepEqual(JSON.parse(app.storage.get(modelKey)).prices, prices);
  assert.match(mount(app.storage).get("optimal").textContent, /3,92/);
});

test("device editor reports bad input without discarding it and saves a valid item", () => {
  const app = mount();
  app.get("new").click();
  assert.equal(app.get("name").focused, true);
  app.get("name").value = "Насос";
  app.fields.get("latest").value = 9;
  app.submit("device-form");
  assert.match(app.get("device-error").textContent, /обычный старт/);
  assert.equal(app.get("name").value, "Насос");
  app.fields.get("latest").value = 22;
  app.submit("device-form");
  assert.equal(app.get("device-form").hidden, true);
  app.submit("limit-form");
  app.flush();
  assert.equal(app.get("schedule-rows").children.length, 4);
});
