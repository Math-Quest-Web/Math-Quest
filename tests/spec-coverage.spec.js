// Keeps docs/spec.md and the tests in lock-step:
//  - every requirement marked Done or Off in the spec must be named in at least one test title,
//  - every requirement ID named in a test title must exist in the spec.
// Requirements with status Process or Rule (working agreements) or Known issue are exempt.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '..');
const spec = fs.readFileSync(path.join(root, 'docs', 'spec.md'), 'utf8');

const ID = /\b[A-Z]{3}-\d{2}\b/g;

// | RAI-12 | text ... | Done |
function specRequirements() {
  const out = [];
  for (const line of spec.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([A-Z]{3}-\d{2})\s*\|(.*)\|\s*([A-Za-z ]+?)\s*\|\s*$/);
    if (m) out.push({ id: m[1], status: m[3].trim() });
  }
  return out;
}

function testTitles() {
  const titles = [];
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.spec.js'))) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const m of src.matchAll(/\btest\(\s*(['"`])([\s\S]*?)\1\s*,/g)) titles.push({ file: f, title: m[2] });
  }
  return titles;
}

test('TST-05 every Done/Off requirement in docs/spec.md has a test, and every tested ID exists in the spec', () => {
  const reqs = specRequirements();
  expect(reqs.length, 'the spec should list requirements').toBeGreaterThan(60);

  const ids = reqs.map((r) => r.id);
  expect(new Set(ids).size, 'duplicate requirement ids in the spec').toBe(ids.length);

  const tested = new Set();
  const unknown = [];
  for (const { file, title } of testTitles()) {
    for (const id of title.match(ID) || []) {
      tested.add(id);
      if (!ids.includes(id)) unknown.push(`${id} (in ${file})`);
    }
  }
  expect(unknown, 'tests refer to ids that are not in docs/spec.md').toEqual([]);

  const needsTest = reqs.filter((r) => ['Done', 'Off'].includes(r.status));
  const missing = needsTest.filter((r) => !tested.has(r.id)).map((r) => r.id);
  expect(missing, 'spec requirements with no test (add a test whose title starts with the id)').toEqual([]);

  const statuses = new Set(reqs.map((r) => r.status));
  statuses.forEach((s) => expect(['Done', 'Off', 'Process', 'Rule', 'Known issue']).toContain(s));
});
