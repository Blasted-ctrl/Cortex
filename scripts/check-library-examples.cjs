#!/usr/bin/env node
/**
 * Compile-check every example in src/shared/stdlib/cpp-libraries.json against the
 * real installed library, so curated documentation never ships an example that does
 * not build.
 *
 *   node scripts/check-library-examples.cjs                 all checkable libraries
 *   node scripts/check-library-examples.cjs opencv.hpp      one dictionary key
 *   node scripts/check-library-examples.cjs --jobs 8        parallel compiles
 *
 * Each example is syntax-checked (-fsyntax-only) with the flags `pkg-config` reports
 * for the library. A class example is a complete program and is compiled as written;
 * a function example is a statement fragment and is wrapped in `main`. Libraries that
 * cannot be built on the host (for example Arduino/ESP32 ones) are listed as skipped,
 * not passed. A dictionary key with no entry in LIBRARY_CHECKS fails, so adding a
 * library to the dictionary forces adding how to check it.
 *
 * Needs a host g++ and pkg-config. On Windows, Cortex's MSYS2 install is found
 * automatically (C:/msys64/ucrt64/bin).
 */
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir, cpus } = require('node:os')
const { delimiter, join } = require('node:path')

const argv = process.argv.slice(2)
const dictAt = argv.indexOf('--dict')
const DICT = dictAt >= 0 ? argv.splice(dictAt, 2)[1] : join(__dirname, '..', 'src', 'shared', 'stdlib', 'cpp-libraries.json')

/** How to compile an example for a dictionary key. `skip` explains why one cannot be. */
const LIBRARY_CHECKS = {
  'opencv.hpp': { pkg: 'opencv4', prelude: '#include <opencv2/opencv.hpp>\n#include <iostream>\n#include <vector>\n', main: 'int main()' },
  'raylib.h': { pkg: 'raylib', prelude: '#include <raylib.h>\n', main: 'int main()' },
  'sdl.h': { pkg: 'sdl2', prelude: '#include <SDL2/SDL.h>\n', main: 'int main(int argc, char* argv[])' },
  'glfw3.h': { pkg: 'glfw3', prelude: '#include <GLFW/glfw3.h>\n', main: 'int main()' },
  'esp32servo.h': { skip: 'needs the Arduino/ESP32 core, which a host compiler cannot build' }
}

const args = argv
const jobsAt = args.indexOf('--jobs')
const jobs = jobsAt >= 0 ? Number(args.splice(jobsAt, 2)[1]) || 4 : Math.max(2, Math.min(6, cpus().length - 1))
const only = args.filter((a) => !a.startsWith('--'))

const msys = ['ucrt64', 'mingw64', 'clang64'].map((e) => `C:/msys64/${e}/bin`).filter(existsSync)
const env = { ...process.env, PATH: [process.env.PATH, ...msys].filter(Boolean).join(delimiter) }

function find(...names) {
  for (const name of names) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { env, encoding: 'utf8' })
    if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim()
  }
  return null
}
const gxx = find('g++', 'clang++')
const pkg = find('pkgconf', 'pkg-config')
if (!gxx || !pkg) {
  console.error('Needs a C++ compiler and pkg-config on PATH (Cortex can install them: Settings > Libraries).')
  process.exit(2)
}

/** Every example in the dictionary, with a label for reporting. */
function collect(dict) {
  const out = []
  for (const [key, file] of Object.entries(dict)) {
    const ns = file.namespace ? `${file.namespace}::` : ''
    for (const [name, f] of Object.entries(file.functions ?? {})) out.push({ key, label: `${ns}${name}`, example: f.example, complete: false })
    for (const [cname, c] of Object.entries(file.classes ?? {})) {
      if (c.example) out.push({ key, label: `${ns}${cname}`, example: c.example, complete: true })
      for (const [mname, m] of Object.entries(c.members ?? {})) {
        if (m.example) out.push({ key, label: `${ns}${cname}::${mname}`, example: m.example, complete: false })
      }
    }
  }
  return out
}

/** The program text for an example under a library's check. */
function program(check, item) {
  // A class example (or any example that already has a main) is a whole program.
  if (item.complete || /\bint\s+main\s*\(/.test(item.example)) return item.example + '\n'
  let body = item.example
  let top = ''
  // A static helper function (a callback) cannot live inside main.
  const helper = /^static [^\n]+\{\n[\s\S]*?\n\}\n/m.exec(body)
  if (helper) {
    top = helper[0]
    body = body.replace(helper[0], '')
  }
  const indented = body.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')
  return `${check.prelude}${top}${check.main} {\n${indented}\n  return 0;\n}\n`
}

function run(cmd, argv) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { env, windowsHide: true })
    let stderr = ''
    p.stderr.on('data', (d) => (stderr += d))
    p.on('close', (code) => resolve({ code, stderr }))
  })
}

async function main() {
  const dict = JSON.parse(readFileSync(DICT, 'utf8'))
  const keys = Object.keys(dict).filter((k) => only.length === 0 || only.includes(k))
  const unknown = keys.filter((k) => !LIBRARY_CHECKS[k])
  if (unknown.length) {
    console.error(`No check is defined for: ${unknown.join(', ')}. Add it to LIBRARY_CHECKS in ${__filename}.`)
    process.exit(1)
  }
  const dir = mkdtempSync(join(tmpdir(), 'cortex-libcheck-'))
  const flagsFor = {}
  for (const k of keys) {
    const c = LIBRARY_CHECKS[k]
    if (c.pkg) {
      const r = spawnSync(pkg, ['--cflags', c.pkg], { env, encoding: 'utf8' })
      if (r.status !== 0) {
        console.error(`pkg-config cannot find ${c.pkg} (needed for ${k}). Install it in Settings > Libraries.`)
        process.exit(2)
      }
      flagsFor[k] = r.stdout.split(/\s+/).filter(Boolean)
    }
  }
  const items = collect(Object.fromEntries(keys.map((k) => [k, dict[k]])))
  const skipped = items.filter((i) => LIBRARY_CHECKS[i.key].skip)
  const todo = items.filter((i) => !LIBRARY_CHECKS[i.key].skip)
  let next = 0
  let failed = 0
  async function worker(id) {
    while (next < todo.length) {
      const item = todo[next++]
      const file = join(dir, `ex-${id}-${next}.cpp`)
      writeFileSync(file, program(LIBRARY_CHECKS[item.key], item))
      const { code, stderr } = await run(gxx, ['-std=c++17', '-fsyntax-only', '-w', file, ...flagsFor[item.key]])
      if (code !== 0) {
        failed++
        console.log(`FAIL ${item.key} ${item.label}\n${stderr.split('\n').slice(0, 8).join('\n')}\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i)))
  rmSync(dir, { recursive: true, force: true })
  console.log(`${todo.length - failed}/${todo.length} examples compile` + (skipped.length ? ` (${skipped.length} skipped: ${[...new Set(skipped.map((s) => LIBRARY_CHECKS[s.key].skip))].join('; ')})` : ''))
  process.exit(failed ? 1 : 0)
}

main()
