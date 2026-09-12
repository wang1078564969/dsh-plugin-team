/*
 * The package's test entry (see package.json). It runs every `*.test.mjs` in
 * this directory through Node's own test runner, so the ported domain tests and
 * the plugin's own tests are one command and one exit code — which is what CI,
 * a pre-commit hook, and a human in a hurry all actually need.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  console.error('no *.test.mjs files found in ' + here)
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files.map((name) => join(here, name))], {
  stdio: 'inherit',
  cwd: join(here, '..'),
})
process.exit(result.status === null ? 1 : result.status)
