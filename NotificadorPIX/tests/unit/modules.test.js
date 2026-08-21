const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const files = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'app.js');

for (const file of files) {
  test(`módulo ${file} carrega sem erro`, () => {
    const mod = require(path.join(ROOT, file));
    assert.ok(mod !== undefined, `${file} não deveria exportar undefined`);
  });
}
