import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the workspace reset against the defect it was written for: not a wrong
 * reset, but an incomplete one. openWorkspace listed seven keys, and every
 * workspace-scoped key added to the store afterwards was never added to it, so
 * opening a second folder carried the first project's circuit, tabs, board
 * target and running processes into it.
 *
 * The store imports zustand and reaches for `window`, and the test env is node
 * with no jsdom, so this reads the source rather than the module. That is
 * deliberate: the question here is "does this key appear in the reset", which
 * is a question about the text.
 */

const SRC = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'store', 'useStore.ts'), 'utf8')

/** The body of workspaceScopedReset(). */
function resetBody(): string {
  const start = SRC.indexOf('export function workspaceScopedReset()')
  expect(start, 'workspaceScopedReset must exist').toBeGreaterThan(-1)
  const end = SRC.indexOf('\n}', start)
  return SRC.slice(start, end)
}

/**
 * The reset's effective keys: its own literal, plus the body of every constant
 * it spreads in.
 *
 * Resolving the spread is the whole point. Accepting the literal text
 * '...SIM_PIN_RESET' as proof that simPinModes is cleared made the assertion a
 * function of the key's own name: deleting simPinModes from SIM_PIN_RESET left
 * every test green, including the one called 'clears simPinModes'.
 */
function resetKeys(): string {
  const body = resetBody()
  let text = body
  for (const m of body.matchAll(/\.\.\.(\w+)/g)) {
    const name = m[1]
    // To end of line, not to the first brace: the values are themselves object
    // literals, so `\{[^}]*\}` stops inside the first one and silently drops
    // every key after it.
    const decl = SRC.match(new RegExp(`const ${name} = [^\\n]*`))
    expect(decl, `the spread ...${name} must resolve to a const declaration in this file`).toBeTruthy()
    text += '\n' + decl![0]
  }
  return text
}

/**
 * State that belongs to one project. Every key here must be cleared when
 * another folder is opened. Adding workspace-scoped state to the store means
 * adding it here and to the reset, and this test is the reminder.
 */
const WORKSPACE_SCOPED = [
  'childrenCache',
  'expanded',
  'tabs',
  'activePath',
  'activeGroup',
  'groupActive',
  'reveal',
  'simParts',
  'simWires',
  'sim3dBoard',
  'simDiagramDirty',
  'simDiagramError',
  'simDiagramSavedContent',
  'simStepperStates',
  'simActuatorStates',
  'simSerial',
  'simInputs',
  'simWiring',
  'simBlock',
  'simPinStates',
  'simPinPwm',
  'simPinModes',
  'simRunning',
  'simRunId',
  'running',
  'runId',
  'runPhase',
  'runAction',
  'lastExitCode',
  'output',
  'diagnostics',
  'selectedFqbn',
  'environmentReport',
  'lockCheck',
  'datasheets',
  'datasheetResults',
  'serialLines',
  'serialCarry',
  'serialError',
  'plotSeries',
  // The agent transcript, staged edits, and conversation reference the old
  // project's files, so a switch must clear them.
  'agentLog',
  'agentEdits',
  'agentMessages'
]

// A board change invalidates the previous target's build diagnostics, so they
// must not linger and be reused as missing-dependency evidence for the new board.
describe('board switch clears stale diagnostics', () => {
  it('setFqbn clears diagnostics when the target changes', () => {
    const body = SRC.slice(SRC.indexOf('setFqbn(fqbn) {'), SRC.indexOf('setBoardAndPort('))
    expect(body).toContain('diagnostics: []')
    expect(body).toContain('fqbn !== get().selectedFqbn')
  })
  it('setBoardAndPort clears diagnostics when the target changes', () => {
    const body = SRC.slice(SRC.indexOf('setBoardAndPort(fqbn, port) {'), SRC.indexOf('async verifyBoard('))
    expect(body).toContain('diagnostics: []')
  })
})

describe('workspaceScopedReset', () => {
  const keys = resetKeys()

  it.each(WORKSPACE_SCOPED)('clears %s', (key) => {
    expect(new RegExp(`\\b${key}\\s*:`).test(keys), `${key} missing from the reset`).toBe(true)
  })

  // Guards the guard: if the spread stops resolving, every key that arrives
  // through it would silently stop being checked.
  it('resolves the constants it spreads in', () => {
    expect(resetBody()).toContain('...SIM_PIN_RESET')
    expect(keys.length).toBeGreaterThan(resetBody().length)
    expect(keys).toContain('simPinModes')
  })

  it('is applied by openWorkspace', () => {
    const open = SRC.slice(SRC.indexOf('async openWorkspace('), SRC.indexOf('async closeWorkspace()'))
    expect(open).toContain('...workspaceScopedReset()')
  })

  // Both entry guards return silently when their flag is set, so a run carried
  // in from the old project makes the new project's Run button do nothing.
  it('stops the previous project processes before switching', () => {
    const open = SRC.slice(SRC.indexOf('async openWorkspace('), SRC.indexOf('async closeWorkspace()'))
    expect(open).toContain('stopRun()')
    expect(open).toContain('stopSim()')
  })

  // openWorkspace seeds default parts and then loads. If a load path returns
  // without assigning, the seeded (or previous project's) parts stay on the
  // canvas and saveDiagram writes them into this project's file.
  describe('loadDiagram is authoritative about simParts', () => {
    const load = SRC.slice(SRC.indexOf('async loadDiagram()'), SRC.indexOf('async detectToolchains'))

    it('assigns parts when the file is missing', () => {
      expect(load).toContain('const exists = await window.api.exists(file)')
      expect(load).toMatch(/if \(!exists\) \{[\s\S]*?set\(\{ simParts: parts, simWires: wiresFromParts\(parts\)/)
    })

    it('assigns parts when the file is not a diagram', () => {
      expect(load).toContain('decodeSimDiagram(JSON.parse(read.content))')
      expect(load).toContain("set({ simParts: [], simWires: [], sim3dBoard: 'uno'")
    })

    it('assigns parts when the file is unreadable', () => {
      const katch = load.slice(load.indexOf('} catch'))
      expect(katch).toContain('simParts')
    })

    // Any new exit must assign parts too.
    //
    // Allowlisted by content, at any depth. An earlier version keyed on
    // indentation and filtered on the same properties it then asserted, so it
    // compared [] to [] and could not fail. Depth is also the wrong signal:
    // loadDiagram has its own control flow nested inside the try.
    it('guards every asynchronous load result from replacing a different project', () => {
      expect(load.match(/if \(get\(\)\.workspaceRoot !== root\) return/g)).toHaveLength(4)
      expect(load).toContain('simDiagramError: message')
      expect(load).toContain("get().notify('error', 'Circuit not loaded', message)")
    })

    it('is awaited by openWorkspace, so the canvas never paints stale parts', () => {
      expect(SRC).toContain('await get().loadDiagram()')
    })
  })

  // The panes render groupActive, not activePath, so any tab-set mutation must
  // go through the group resolver or a pane can point at a stale/removed path.
  // renameEntry and deleteEntry set tabs directly, so they must re-resolve.
  describe('rename/delete reconcile the editor groups', () => {
    it('renameEntry re-resolves the groups (so a renamed open file does not blank its pane)', () => {
      const body = SRC.slice(SRC.indexOf('async renameEntry('), SRC.indexOf('async deleteEntry('))
      expect(body).toContain('resolveGroups(')
      expect(body).toContain('groupActive')
    })
    it('deleteEntry re-resolves the groups (so a deleted active tab does not strand activeGroup)', () => {
      const body = SRC.slice(SRC.indexOf('async deleteEntry('), SRC.indexOf('async createNewFile('))
      expect(body).toContain('resolveGroups(')
    })
  })

  // Close Folder returns to Welcome. It must be as thorough a teardown as a
  // switch (same reset, same process/watcher/server teardown), plus it must save
  // first (closing is not a place to silently drop edits) and must forget the
  // last workspace so it is not reopened on next launch.
  describe('closeWorkspace', () => {
    const body = SRC.slice(SRC.indexOf('async closeWorkspace()'), SRC.indexOf('removeRecent(path)'))

    it('slices a real function body', () => {
      expect(body).toContain('workspaceRoot')
      expect(body.length).toBeGreaterThan(100)
    })

    it('saves all tabs before tearing anything down', () => {
      const save = body.indexOf('saveAll()')
      const reset = body.indexOf('workspaceScopedReset()')
      expect(save).toBeGreaterThan(-1)
      expect(reset).toBeGreaterThan(-1)
      expect(save, 'saveAll must run before the reset').toBeLessThan(reset)
    })

    it('applies the full workspace reset and clears the root', () => {
      expect(body).toContain('...workspaceScopedReset()')
      expect(body).toMatch(/workspaceRoot:\s*null/)
      expect(body).toMatch(/tree:\s*\[\]/)
    })

    it('stops the project processes, watcher, language servers, and terminal', () => {
      expect(body).toContain('stopRun()')
      expect(body).toContain('stopSim()')
      expect(body).toContain('stopDebug()')
      expect(body).toContain('watchStop()')
      expect(body).toContain('lspDisposeRoot')
      // The terminal's shell is rooted in the closing project; tear it down too.
      expect(body).toContain('__cortexTerminal?.dispose()')
    })

    it('returns to the editor view so Welcome shows, and forgets the last workspace', () => {
      expect(body).toMatch(/mainView:\s*'editor'/)
      expect(body).toContain('removeItem(LAST_WORKSPACE_KEY)')
    })
  })

  /**
   * Everything in ProjectConfig is per project, so none of it may fall back to
   * the live value: that IS the previous project's. These four resolve in
   * loadProjectConfig rather than in the static reset because two of them need
   * the app defaults and detection, which a pure function cannot reach.
   */
  describe('loadProjectConfig is authoritative', () => {
    // persistProjectConfig is the next function in the file. Slicing to
    // detectToolchains ran backwards (it is declared 200 lines earlier) and
    // silently produced an empty string, which every assertion then "passed".
    const start = SRC.indexOf('async loadProjectConfig()')
    const end = SRC.indexOf('async persistProjectConfig(')
    const load = SRC.slice(start, end)

    it('slices a real function body', () => {
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      expect(load).toContain('getProjectConfig')
    })

    // Generalized on purpose: the old assertion banned this shape for exactly
    // one key while `cfg.compiler || get().compiler` sat three lines above it.
    it('no project setting falls back to the live value', () => {
      const leaks = [...load.matchAll(/cfg\.\w+ \|\| get\(\)\.\w+/g)].map((m) => m[0])
      expect(leaks, 'a project setting resolving to get().X carries the previous project in').toEqual([])
    })

    it.each(['compiler', 'std', 'optimization', 'selectedFqbn'])('resolves %s', (key) => {
      expect(new RegExp(`\\b${key}:`).test(load), `${key} must be resolved on open`).toBe(true)
    })

    // The two-level ones must reach the app default, or an empty project value
    // lands on a literal and overrides what detection chose.
    it('lets the app default win over a hardcoded compiler', () => {
      expect(load).toContain('defaultCppCompiler')
      expect(load).toContain('defaultCppStandard')
    })

    // Asserted on the expression, not on file offsets: the comment above it
    // names both 'g++' and detection, so an indexOf comparison was measuring
    // prose.
    it('resolves the compiler project, then app default, then detection, then a literal', () => {
      expect(load).toContain('isHostCpp')
      // The project value goes through hostCppOrNull first: .cortex/config.json
      // is untrusted, so 'gcc' must be normalized to 'g++' and a cross driver
      // like 'arm-none-eabi-g++' must not become the host compiler at all.
      expect(load).toMatch(/compiler: hostCppOrNull\(cfg\.compiler\) \|\| s\?\.defaultCppCompiler \|\| detected \|\| 'g\+\+'/)
    })
  })
})
