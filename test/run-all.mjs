/*
 * The package's test entry (see package.json). It runs every `*.test.mjs` in
 * this directory through Node's own test runner, so the ported domain tests and
 * the plugin's own tests are one command and one exit code — which is what CI,
 * a pre-commit hook, and a human in a hurry all actually need.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/*
 * 让整套用例**与这台机器无关**。
 *
 * 不少用例调 `loadConfig({...})` 时没有给 `dataDir`，于是配置解析会去读
 * `$DSH_HOME/team/config.json` —— 也就是**开发者本人的真实配置**。后果是
 * "测试在你机器上过、在别人机器上挂"（反之亦然），而且没人看得出来为什么。
 * 把 `DSH_HOME` 指到一个空的临时目录就解决了：默认 dataDir 落在那里，
 * 显式传了 `dataDir` 的用例不受影响（row config 仍然优先于默认值）。
 */
const home = mkdtempSync(join(tmpdir(), 'dsh-team-test-home-'))
const result = spawnSync(process.execPath, ['--test', ...files.map((name) => join(here, name))], {
  stdio: 'inherit',
  cwd: join(here, '..'),
  env: { ...process.env, DSH_HOME: home },
})
rmSync(home, { recursive: true, force: true })
process.exit(result.status === null ? 1 : result.status)
