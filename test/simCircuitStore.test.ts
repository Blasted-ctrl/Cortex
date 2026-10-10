import { beforeEach, describe, expect, it, vi } from 'vitest'
import { wiresFromParts, type SimPart } from '../src/shared/simCircuit'
import { CONSOLE_TEXT_LIMIT, OMITTED_OUTPUT } from '../src/shared/consoleBuffer'
const api = { exists: vi.fn(), readFile: vi.fn(), createDir: vi.fn(), writeFile: vi.fn(), simInput: vi.fn() }
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { api, confirm: vi.fn(() => true) })
const { useStore, workspaceScopedReset } = await import('../src/renderer/src/store/useStore')
const led = (): SimPart => ({ id: 'led', type: 'led', x: 100, y: 100, rotation: 0, pins: { sig: 13, gnd: -1 } })
beforeEach(() => {
  vi.clearAllMocks()
  api.exists.mockResolvedValue(false); api.createDir.mockResolvedValue(undefined); api.writeFile.mockResolvedValue(undefined)
  useStore.setState({ ...workspaceScopedReset(), workspaceRoot: 'C:/fixture', notifications: [] })
})
describe('production circuit store persistence', () => {
  it.each(['simulator', 'run'])('bounds actual %s console text as well as its entry count', (console) => {
    useStore.setState({ simRunId: 'fixture-run', simSerial: [], runId: 'fixture-run', output: [] })
    const text = 'x'.repeat(CONSOLE_TEXT_LIMIT * 2) + 'end'
    if (console === 'simulator') useStore.getState().handleSimEvent({ id: 'fixture-run', kind: 'serial', text })
    else useStore.getState().appendOutput({ id: 'fixture-run', stream: 'stdout', data: text })
    const entries = console === 'simulator' ? useStore.getState().simSerial : useStore.getState().output
    expect(entries.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(CONSOLE_TEXT_LIMIT)
    expect(entries[0].text.startsWith(OMITTED_OUTPUT)).toBe(true)
    expect(entries.at(-1)?.text.endsWith('end')).toBe(true)
  })
  it('resets missing layouts to fresh connected defaults, not previous project parts', async () => {
    useStore.setState({ simParts: [led()], sim3dBoard: 'teensy41', simDiagramDirty: true })
    await useStore.getState().loadDiagram()
    const s = useStore.getState()
    expect(s.simParts).toHaveLength(2); expect(s.simParts[0].id).not.toBe('led')
    expect(s.simWires).toHaveLength(4); expect(s.sim3dBoard).toBe('uno'); expect(s.simDiagramDirty).toBe(false)
  })
  it.each([{ version: 99, parts: [] }, { version: 2, parts: [{ ...led(), type: 'made-up' }] }, { version: 2, parts: [led(), led()] }])('refuses malformed layouts without overwriting the saved file %#', async (raw) => {
    api.exists.mockResolvedValue(true); api.readFile.mockResolvedValue({ kind: 'text', content: JSON.stringify(raw) })
    await useStore.getState().loadDiagram()
    expect(useStore.getState().simParts).toEqual([]); expect(useStore.getState().simDiagramError).toContain('not changed')
    expect(api.writeFile).not.toHaveBeenCalled(); expect(useStore.getState().notifications[0].kind).toBe('error')
  })
  it('loads v2 mappings and clamps otherwise stranded coordinates', async () => {
    api.exists.mockResolvedValue(true); api.readFile.mockResolvedValue({ kind: 'text', content: JSON.stringify({ version: 2, parts: [{ ...led(), x: -999, y: 9999 }] }) })
    await useStore.getState().loadDiagram()
    const p = useStore.getState().simParts[0]
    expect(p.x).toBeGreaterThan(0); expect(p.y).toBeLessThan(520); expect(p.pins).toEqual({ sig: 13, gnd: -1 })
    expect(useStore.getState().simWires).toHaveLength(2)
  })
  it('does not apply delayed layout reads to a different project', async () => {
    api.exists.mockImplementation(async () => { useStore.setState({ workspaceRoot: 'C:/other', simParts: [led()] }); return true })
    await useStore.getState().loadDiagram()
    expect(useStore.getState().simParts).toEqual([led()]); expect(api.readFile).not.toHaveBeenCalled()
  })
  it('saves board, wires and connector type in v3 and restores them', async () => {
    const p = led(), wires = wiresFromParts([p]).map((w) => ({ ...w, kind: 'alligator' as const }))
    useStore.setState({ simParts: [p], simWires: wires, sim3dBoard: 'teensy41', simDiagramDirty: true })
    await useStore.getState().saveDiagram()
    const raw = api.writeFile.mock.calls[0][1]
    expect(JSON.parse(raw)).toMatchObject({ version: 3, board: 'teensy41', wires: [{ kind: 'alligator' }, { kind: 'alligator' }] })
    api.exists.mockResolvedValue(true); api.readFile.mockResolvedValue({ kind: 'text', content: raw })
    await useStore.getState().loadDiagram()
    expect(useStore.getState().sim3dBoard).toBe('teensy41'); expect(useStore.getState().simWires).toEqual(wires)
  })
  it('keeps failed saves dirty and actionable', async () => {
    useStore.setState({ simDiagramDirty: true }); api.writeFile.mockRejectedValue(new Error('disk full'))
    await expect(useStore.getState().saveDiagram()).rejects.toThrow('disk full')
    expect(useStore.getState().simDiagramDirty).toBe(true); expect(useStore.getState().notifications[0].title).toBe('Circuit save failed')
  })
  it('does not clear edits made while saving', async () => {
    api.writeFile.mockImplementation(async () => useStore.getState().addPart('power'))
    await expect(useStore.getState().saveDiagram()).rejects.toThrow('changed while saving')
    expect(useStore.getState().simDiagramDirty).toBe(true)
  })
  it('refuses replacing a corrupt layout when confirmation is cancelled', async () => {
    useStore.setState({ simDiagramError: 'bad saved JSON' }); vi.mocked(window.confirm).mockReturnValueOnce(false)
    await expect(useStore.getState().saveDiagram()).rejects.toThrow('cancelled'); expect(api.writeFile).not.toHaveBeenCalled()
  })
  it('adds a real part-to-part wire with selected connector metadata', () => {
    const p = led(); useStore.setState({ simParts: [p], simWires: wiresFromParts([p]) })
    useStore.getState().addPart('power'); const supply = useStore.getState().simParts[1]
    useStore.getState().setWireKind('female-female'); useStore.getState().beginWire(supply.id, 'negative'); useStore.getState().beginWire(p.id, 'gnd')
    expect(useStore.getState().simWires.at(-1)).toMatchObject({ kind: 'female-female', from: { partId: supply.id, pin: 'negative' }, to: { partId: 'led', pin: 'gnd' } })
    expect(useStore.getState().simDiagramDirty).toBe(true)
  })
  it('feeds every connected GPIO and never feeds a power rail to firmware', () => {
    const p: SimPart = { id: 'button', type: 'button', x: 100, y: 100, rotation: 0, pins: { sig: null, gnd: -1 } }
    const wires = [2, 3, -1].map((pin, i) => ({ id: `wire-${i}`, kind: 'male-male' as const, from: { kind: 'part' as const, partId: p.id, pin: 'sig' }, to: { kind: 'board' as const, pin } }))
    useStore.setState({ simParts: [p], simWires: wires, simRunning: true, simRunId: 'run' })
    useStore.getState().setPartInput(p.id, 1023)
    expect(api.simInput.mock.calls).toEqual([['run', 2, 1023], ['run', 3, 1023]])
    useStore.getState().setSimInput(-1, 1023); expect(api.simInput).toHaveBeenCalledTimes(2)
  })
  it('stops at the persistence part limit instead of making an unsavable circuit', () => {
    useStore.setState({ simParts: Array.from({ length: 256 }, (_, i) => ({ ...led(), id: `led-${i}` })) })
    useStore.getState().addPart('motor'); expect(useStore.getState().simParts).toHaveLength(256)
    expect(useStore.getState().notifications[0].title).toBe('Circuit limit reached')
  })
  it('closes a grounded switch LOW for plain INPUT, without inventing a released HIGH', () => {
    const p: SimPart = { id: 'button', type: 'button', x: 100, y: 100, rotation: 0, pins: { sig: 2, gnd: -1 } }
    useStore.setState({ simParts: [p], simWires: wiresFromParts([p]), simPinModes: { 2: 0 }, simInputs: { 2: 700 } })
    useStore.getState().setPartButton(p.id, true); expect(useStore.getState().simInputs[2]).toBe(0)
    useStore.getState().setPartButton(p.id, false); expect(useStore.getState().simInputs[2]).toBe(0)
  })
  it('restores each pullup independently on release and does not inject into OUTPUT', () => {
    const p: SimPart = { id: 'button', type: 'button', x: 100, y: 100, rotation: 0, pins: { sig: null, gnd: -1 } }
    const wires = [2, 3, 4].map((pin) => ({ id: `wire-${pin}`, kind: 'male-male' as const, from: { kind: 'part' as const, partId: p.id, pin: 'sig' }, to: { kind: 'board' as const, pin } }))
    useStore.setState({ simParts: [p], simWires: wires, simPinModes: { 2: 2, 3: 0, 4: 1 }, simRunning: true, simRunId: 'run' })
    useStore.getState().setPartButton(p.id, true); useStore.getState().setPartButton(p.id, false)
    expect(api.simInput.mock.calls).toEqual([['run', 2, 0], ['run', 3, 0], ['run', 2, 1023]])
  })
  it('refuses a button without a ground connection', () => {
    const p: SimPart = { id: 'button', type: 'button', x: 100, y: 100, rotation: 0, pins: { sig: 2, gnd: null } }
    useStore.setState({ simParts: [p], simWires: wiresFromParts([p]), simPinModes: { 2: 2 } })
    useStore.getState().setPartButton(p.id, true)
    expect(useStore.getState().simInputs).toEqual({}); expect(useStore.getState().notifications[0].title).toBe('Button needs GND')
  })
  it('resolves a known single output on a GPIO fanout net and drops ambiguous drivers', () => {
    const p = led(), wires = wiresFromParts([p])
    wires.push({ id: 'fanout', kind: 'male-male', from: { kind: 'part', partId: p.id, pin: 'sig' }, to: { kind: 'board', pin: 2 } })
    useStore.setState({ simParts: [p], simWires: wires, simRunId: 'run' })
    useStore.getState().handleSimEvent({ id: 'run', kind: 'mode', pin: 13, value: 1 })
    expect(useStore.getState().simParts[0].pins.sig).toBeNull()
    useStore.getState().handleSimEvent({ id: 'run', kind: 'mode', pin: 2, value: 0 })
    expect(useStore.getState().simParts[0].pins.sig).toBe(13)
    useStore.getState().handleSimEvent({ id: 'run', kind: 'mode', pin: 2, value: 1 })
    expect(useStore.getState().simParts[0].pins.sig).toBeNull()
  })
  it('clears stale PWM interpretation when a tone replaces PWM on the same pin', () => {
    useStore.setState({ simRunId: 'run' })
    useStore.getState().handleSimEvent({ id: 'run', kind: 'pwm', pin: 9, value: 128 })
    useStore.getState().handleSimEvent({ id: 'run', kind: 'tone', pin: 9, value: 440 })
    expect(useStore.getState().simPinStates[9]).toBe(1); expect(useStore.getState().simPinPwm[9]).toBe(false)
  })
  it('does not mistake runtime-resolved net bindings for edits during a circuit save', async () => {
    const p = led(), wires = wiresFromParts([p])
    wires.push({ id: 'fanout', kind: 'male-male', from: { kind: 'part', partId: p.id, pin: 'sig' }, to: { kind: 'board', pin: 2 } })
    useStore.setState({ simParts: [p], simWires: wires, simRunId: 'run', simPinModes: { 2: 0 } })
    api.writeFile.mockImplementation(async () => useStore.getState().handleSimEvent({ id: 'run', kind: 'mode', pin: 13, value: 1 }))
    await expect(useStore.getState().saveDiagram()).resolves.toBeUndefined()
    expect(useStore.getState().simDiagramDirty).toBe(false)
    expect(useStore.getState().simParts[0].pins.sig).toBe(13)
    expect(JSON.parse(api.writeFile.mock.calls[0][1]).parts[0].pins.sig).toBeNull()
  })
  it('requires explicit confirmation before changing the board and clears old pin wiring', () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false); useStore.getState().setSim3dBoard('teensy41'); expect(useStore.getState().sim3dBoard).toBe('uno')
    useStore.getState().setSim3dBoard('teensy41'); expect(useStore.getState().simWires).toEqual([])
    expect(Object.values(useStore.getState().simParts[0].pins).every((p) => p === null)).toBe(true)
  })
})
