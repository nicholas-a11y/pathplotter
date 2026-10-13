import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseDecision, type DecisionInput } from '../src/decisions.ts'

const idle: DecisionInput = {
  pairing: null, unresolvedImportId: null, workspaceMismatch: false, rapUpdateRequired: false, control: null, offline: null,
}

test('no modal is shown when nothing needs a decision', () => {
  assert.equal(chooseDecision(idle), null)
})

test('a pairing in progress is mandatory, opens at once and can only be cancelled', () => {
  const decision = chooseDecision({ ...idle, pairing: { text: 'Compare “AMBER RIVER” with RAP', urgent: true, error: false } })
  assert.equal(decision?.kind, 'pairing')
  assert.equal(decision?.urgent, true)
  assert.equal(decision?.mandatory, true)
  assert.equal(decision?.delayMs, 0)
  assert.deepEqual(decision?.actions.map(action => action.id), ['cancel-pairing'])
})

test('a pairing failure can be closed and is no longer urgent', () => {
  const decision = chooseDecision({ ...idle, pairing: { text: 'RAP declined this pairing.', urgent: true, error: true } })
  assert.equal(decision?.urgent, false)
  assert.equal(decision?.mandatory, false)
  assert.deepEqual(decision?.actions.map(action => action.id), ['close'])
})

test('an unresolved import offers check and acknowledge, never a silent retry', () => {
  const decision = chooseDecision({ ...idle, unresolvedImportId: 'job-1' })
  assert.equal(decision?.kind, 'import')
  assert.match(decision?.message ?? '', /job-1/)
  assert.deepEqual(decision?.actions.map(action => action.id), ['check-import', 'acknowledge-import', 'close'])
  assert.notEqual(decision?.key, chooseDecision({ ...idle, unresolvedImportId: 'job-2' })?.key)
})

test('an unreadable import journal is explained rather than shown as a job id', () => {
  const decision = chooseDecision({ ...idle, unresolvedImportId: 'unreadable-journal' })
  assert.doesNotMatch(decision?.message ?? '', /unreadable-journal/)
})

test('a workspace mismatch lets the user confirm, back up or clear', () => {
  const decision = chooseDecision({ ...idle, workspaceMismatch: true })
  assert.equal(decision?.kind, 'workspace')
  assert.deepEqual(decision?.actions.map(action => action.id), ['confirm-workspace', 'download-backup', 'clear-points', 'close'])
})

test('decisions are prioritised: pairing, import, workspace, update, control, offline', () => {
  const all: DecisionInput = {
    pairing: { text: 'x', urgent: false, error: false }, unresolvedImportId: 'job', workspaceMismatch: true,
    rapUpdateRequired: true, control: { message: 'c', takeover: true }, offline: { message: 'o' },
  }
  const order: string[] = []
  let input = { ...all }
  for (const field of ['pairing', 'unresolvedImportId', 'workspaceMismatch', 'rapUpdateRequired', 'control', 'offline'] as const) {
    order.push(chooseDecision(input)!.kind)
    input = { ...input, [field]: idle[field] }
  }
  assert.deepEqual(order, ['pairing', 'import', 'workspace', 'update', 'control', 'offline'])
  assert.equal(chooseDecision(input), null)
})

test('taking control from another browser warns that it stops their capture', () => {
  const takeover = chooseDecision({ ...idle, control: { message: 'Another browser has capture control.', takeover: true } })
  const free = chooseDecision({ ...idle, control: { message: 'Capture control was released.', takeover: false } })
  assert.match(takeover?.message ?? '', /stops capture in the other browser/)
  assert.doesNotMatch(free?.message ?? '', /stops capture/)
  assert.deepEqual(takeover?.actions.map(action => action.id), ['take-control', 'close'])
})

test('connection loss waits before opening and offers Reconnect', () => {
  const decision = chooseDecision({ ...idle, offline: { message: 'RAP is offline.' } })
  assert.equal(decision?.kind, 'offline')
  assert.ok((decision?.delayMs ?? 0) >= 3000)
  assert.deepEqual(decision?.actions.map(action => action.id), ['reconnect', 'close'])
})
