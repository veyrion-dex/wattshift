const assert = require("node:assert/strict");
const {test} = require("node:test");
const Watt = require("./engine.js");

const prices = (first = 1, second = 1) => [first, second, ...Array(22).fill(5)];
const device = (id, changes = {}) => ({
  id, name: id, watts: 1000, duration: 1, earliest: 0, latest: 2, usual: 0, ...changes
});
const base = (devices, tariff = prices(), cap = 1000) => ({devices, prices: tariff, cap});

test("tariff round trips and accepts BOM, semicolons and decimal commas", () => {
  const input = Watt.demo().prices;
  assert.deepEqual(Watt.parseTariff(Watt.tariffCSV(input)), input);
  const rows = input.map((value, hour) => hour + ";" + String(value).replace(".", ","));
  assert.deepEqual(Watt.parseTariff("\uFEFFhour;price\r\n" + rows.join("\r\n")), input);
});

test("missing, repeated or malformed tariff rows fail", () => {
  const text = Watt.tariffCSV(prices());
  assert.throws(() => Watt.parseTariff(text.replace("23:00,5\n", "")), /каждого часа/);
  assert.throws(() => Watt.parseTariff(text + "2,1\n"), /дважды/);
  assert.throws(() => Watt.parseTariff(text.replace("00:00,1", "00:00,1.00001")), /Неверный/);
});

test("demo optimum, baseline, and energy have stable expected values", () => {
  const result = Watt.optimize(Watt.demo());
  assert.equal(result.complete, true);
  assert.equal(result.baseline.cost, 3.341);
  assert.equal(result.best.cost, 1.835);
  assert.equal(result.savings, 1.506);
  assert.equal(result.baseline.energy, result.best.energy);
  assert.equal(result.best.peak, 2500);
});

test("global search finds compatible windows when cheapest hours conflict", () => {
  const model = base([device("flex"), device("fixed", {latest: 1})], prices(0.1, 0.4));
  const result = Watt.optimize(model);
  assert.equal(result.best.rows.find(row => row.id === "flex").start, 1);
  assert.deepEqual(result.baseline.exceed, [0]);
  assert.equal(result.best.peak, 1000);
  assert.equal(result.savings, null);
});

test("negative prices and multi-hour jobs are scored correctly", () => {
  const model = base([device("load", {duration: 2, latest: 3})], [1,-0.2,0,...Array(21).fill(2)]);
  const result = Watt.optimize(model);
  assert.equal(result.best.rows[0].start, 1);
  assert.equal(result.best.cost, -0.2);
});

test("infeasibility and interrupted search are distinct", () => {
  const model = base([device("a", {latest: 1}), device("b", {latest: 1})], prices());
  assert.equal(Watt.optimize(model).best, null);
  assert.equal(Watt.optimize(model).complete, true);
  const limited = Watt.optimize(base([device("a"), device("b")]), 1);
  assert.equal(limited.best, null);
  assert.equal(limited.complete, false);
  const seeded = Watt.optimize(base([device("a", {usual: 1})], prices(0, 2)), 1);
  assert.equal(seeded.complete, false);
  assert.equal(seeded.best.rows[0].start, 1);
});

test("invalid windows are rejected and midnight is a valid end", () => {
  assert.throws(() => Watt.optimize(base([device("a", {duration: 3})])), /окно/);
  const late = base([device("a", {earliest: 23, latest: 24, usual: 23})]);
  assert.equal(Watt.optimize(late).best.rows[0].end, 24);
  assert.equal(Watt.clock(24), "24:00");
});

test("CSV preserves results, escapes quotes and neutralizes formula cells", () => {
  const plan = Watt.optimize(base([device("a", {name: '=SUM("x")'})])).best;
  const csv = Watt.scheduleCSV(plan);
  assert.match(csv, /^device,start,end,watts,kwh,cost/m);
  assert.ok(csv.includes('"\'=SUM(""x"")",00:00,01:00,1000,1,1.000000'));
});

test("optimization agrees with independent exhaustive enumeration on varied cases", () => {
  let seed = 7;
  function random(max) { seed = (1664525 * seed + 1013904223) >>> 0; return seed % max; }
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const tariff = Array.from({length: 24}, () => (random(11) - 3) / 10);
    const jobs = Array.from({length: 3}, (_, i) => {
      const earliest = random(3);
      return device("job" + i, {earliest, usual: earliest, latest: 5, duration: 1 + random(2), watts: 500 * (1 + random(3))});
    });
    const model = base(jobs, tariff, 1500);
    let oracle = Infinity;
    for (let a = jobs[0].earliest; a <= jobs[0].latest - jobs[0].duration; a += 1) {
      for (let b = jobs[1].earliest; b <= jobs[1].latest - jobs[1].duration; b += 1) {
        for (let c = jobs[2].earliest; c <= jobs[2].latest - jobs[2].duration; c += 1) {
          const load = Array(24).fill(0);
          [a,b,c].forEach((start, i) => {
            for (let h = start; h < start + jobs[i].duration; h += 1) load[h] += jobs[i].watts;
          });
          if (Math.max(...load) > model.cap) continue;
          oracle = Math.min(oracle, load.reduce((sum, watts, h) => sum + watts * tariff[h] / 1000, 0));
        }
      }
    }
    const result = Watt.optimize(model);
    assert.equal(result.complete, true);
    if (oracle === Infinity) assert.equal(result.best, null);
    else assert.ok(Math.abs(result.best.cost - oracle) < 1e-9, "case " + iteration);
  }
});
