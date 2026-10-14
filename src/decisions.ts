export type DecisionKind = 'pairing' | 'unpaired' | 'import' | 'workspace' | 'update' | 'control' | 'offline'

export type DecisionActionId =
  | 'cancel-pairing' | 'close' | 'check-import' | 'acknowledge-import' | 'confirm-workspace'
  | 'download-backup' | 'clear-points' | 'take-control' | 'reconnect' | 'forget-pairing'

export interface DecisionAction {
  id: DecisionActionId
  label: string
  style: 'primary' | 'secondary' | 'danger'
}

export interface Decision {
  kind: DecisionKind
  // Changes when the situation changes, so a dismissed modal stays closed until then.
  key: string
  title: string
  message: string
  // Large bold message for steps the user must do elsewhere (RAP approval).
  urgent: boolean
  actions: DecisionAction[]
  // Time the situation must persist before the modal opens by itself.
  delayMs: number
  // Escape and clicking away may not dismiss it.
  mandatory: boolean
}

export interface DecisionInput {
  pairing: { text: string; urgent: boolean; error: boolean } | null
  // RAP no longer accepts this browser's saved pairing.
  unpaired: boolean
  unresolvedImportId: string | null
  workspaceMismatch: boolean
  rapUpdateRequired: boolean
  control: { message: string; takeover: boolean } | null
  offline: { message: string } | null
}

const close: DecisionAction = { id: 'close', label: 'Close', style: 'secondary' }

// One modal at a time, most pressing first. Anything that needs the relay comes after pairing and local recovery.
export function chooseDecision(input: DecisionInput): Decision | null {
  if (input.pairing) {
    const { text, urgent, error } = input.pairing
    return {
      kind: 'pairing', key: 'pairing', title: error ? 'Could not connect to RAP' : 'Connecting to RAP',
      message: text, urgent: urgent && !error, delayMs: 0, mandatory: !error,
      actions: error ? [close] : [{ id: 'cancel-pairing', label: 'Cancel', style: 'secondary' }],
    }
  }
  if (input.unpaired) {
    return {
      kind: 'unpaired', key: 'unpaired', title: 'This browser is no longer paired with RAP', urgent: false, delayMs: 1500, mandatory: false,
      message: 'RAP no longer accepts this browser: it was disconnected in RAP, or RAP was reset. Reconnecting cannot fix that. To pair again, click Open PathPlotter in RAP (or use Pair phone).',
      actions: [{ id: 'forget-pairing', label: 'Forget this pairing', style: 'primary' }, close],
    }
  }
  if (input.unresolvedImportId !== null) {
    const id = input.unresolvedImportId
    return {
      kind: 'import', key: `import:${id}`, title: 'Check the last import', urgent: false, delayMs: 1500, mandatory: false,
      message: id === 'unreadable-journal'
        ? 'The saved import record could not be read, so the last import to LightBurn may or may not have happened. Check LightBurn before sending more geometry, then acknowledge the outcome.'
        : `The outcome of import ${id} is not known. Check RAP and LightBurn, then acknowledge the outcome. Sending again may duplicate artwork, so no import is retried automatically.`,
      actions: [
        { id: 'check-import', label: 'Check import', style: 'primary' },
        { id: 'acknowledge-import', label: 'Acknowledge outcome…', style: 'secondary' },
        close,
      ],
    }
  }
  if (input.workspaceMismatch) {
    return {
      kind: 'workspace', key: 'workspace', title: 'Saved points belong to a different workspace', urgent: false, delayMs: 1500, mandatory: false,
      message: 'The saved points were captured on an unknown or different machine or workpiece origin. If they belong to the machine RAP is reporting now, confirm them (nothing is moved or changed). Otherwise download a backup and clear them.',
      actions: [
        { id: 'confirm-workspace', label: 'They belong to this workspace', style: 'primary' },
        { id: 'download-backup', label: 'Download backup', style: 'secondary' },
        { id: 'clear-points', label: 'Clear points…', style: 'danger' },
        { id: 'close', label: 'Not now', style: 'secondary' },
      ],
    }
  }
  if (input.rapUpdateRequired) {
    return {
      kind: 'update', key: 'update', title: 'Update RAP', urgent: false, delayMs: 1500, mandatory: false,
      message: 'This RAP version is too old for the relay. Open RAP and click Update now. This closes by itself once RAP is updated.',
      actions: [close],
    }
  }
  if (input.control) {
    return {
      kind: 'control', key: `control:${input.control.takeover}`, title: 'Take capture control?', urgent: false, delayMs: 1500, mandatory: false,
      message: input.control.takeover
        ? `${input.control.message} Taking control stops capture in the other browser. Pending or unresolved imports must be reconciled first.`
        : input.control.message,
      actions: [{ id: 'take-control', label: 'Take control', style: 'primary' }, { id: 'close', label: 'Not now', style: 'secondary' }],
    }
  }
  if (input.offline) {
    return {
      kind: 'offline', key: 'offline', title: 'RAP is not connected', urgent: false, delayMs: 4000, mandatory: false,
      message: input.offline.message,
      actions: [{ id: 'reconnect', label: 'Reconnect now', style: 'primary' }, close],
    }
  }
  return null
}
