import type { AssertionResult, FirmwareAssertion, TimelineEvent } from '../../shared/firmwareTest'

export function evaluateAssertions(assertions: FirmwareAssertion[], timeline: TimelineEvent[]): AssertionResult[] {
  return assertions.map((assertion) => {
    const result = (passed: boolean, atMs: number, message: string, evidence: TimelineEvent[]): AssertionResult => ({
      id: assertion.id, kind: assertion.kind, passed, atMs, message, evidence
    })
    if (assertion.kind === 'state') {
      const last = timeline.filter(e => e.kind === assertion.event && 'pin' in e && e.pin === assertion.pin && e.atMs <= assertion.atMs).at(-1)
      const actual = last && 'value' in last ? last.value : undefined
      return result(actual === assertion.value, assertion.atMs,
        `${assertion.event} pin ${assertion.pin} at ${assertion.atMs}ms: expected ${assertion.value}, observed ${actual ?? 'no output'}`,
        last ? [last] : [])
    }
    const window = timeline.filter(e => e.atMs >= assertion.fromMs && e.atMs <= assertion.toMs)
    if (assertion.kind === 'event') {
      const match = window.find(e => e.kind === assertion.event && (assertion.event === 'serial'
        ? 'text' in e && e.text === assertion.text
        : 'pin' in e && e.pin === assertion.pin && e.value === assertion.value))
      const label = assertion.event === 'serial' ? `Serial "${assertion.text}"` : `${assertion.event} pin ${assertion.pin} = ${assertion.value}`
      return result(!!match, match?.atMs ?? assertion.toMs,
        `${label} ${match ? 'observed' : 'not observed'} within [${assertion.fromMs}, ${assertion.toMs}]ms`,
        match ? [match] : timeline.filter(e => e.atMs <= assertion.toMs && e.kind === assertion.event &&
          (assertion.event === 'serial' || ('pin' in e && e.pin === assertion.pin))).slice(-10))
    }
    if (assertion.kind === 'sequence') {
      const serial = window.filter((e): e is TimelineEvent & { kind: 'serial'; text: string } => e.kind === 'serial')
      const matched: TimelineEvent[] = []
      let index = 0
      for (const e of serial) {
        if (e.text === assertion.texts[index]) { matched.push(e); index++ }
        if (index === assertion.texts.length) break
      }
      return result(index === assertion.texts.length, index === assertion.texts.length ? matched.at(-1)!.atMs : assertion.toMs,
        `Serial sequence: ${index}/${assertion.texts.length} states observed in order${index < assertion.texts.length ? `; missing "${assertion.texts[index]}"` : ''}`,
        index === assertion.texts.length ? matched : serial.slice(-20))
    }
    const outputs = timeline.filter(e => e.kind === assertion.event && 'pin' in e && e.pin === assertion.pin)
    const carried = outputs.filter(e => e.atMs < assertion.fromMs).at(-1)
    const observed = [...(carried ? [carried] : []), ...outputs.filter(e => e.atMs >= assertion.fromMs && e.atMs <= assertion.toMs)]
    const invalid = observed.find(e => 'value' in e && (e.value < assertion.min || e.value > assertion.max))
    // Unknown output at the beginning is not proof of a safe actuator state.
    const initialized = carried || observed.some(e => e.atMs === assertion.fromMs)
    const passed = !!initialized && !invalid
    return result(passed, invalid ? Math.max(assertion.fromMs, invalid.atMs) : !initialized ? assertion.fromMs : assertion.toMs,
      `${assertion.event} pin ${assertion.pin} in [${assertion.min}, ${assertion.max}] throughout [${assertion.fromMs}, ${assertion.toMs}]ms: ${
        invalid && 'value' in invalid ? `observed ${invalid.value}` : !initialized ? 'no output established at window start' : 'within bounds'}`,
      invalid ? [invalid] : observed.slice(-10))
  })
}
