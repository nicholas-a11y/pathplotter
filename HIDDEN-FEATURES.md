# Hidden UI features

## Live update toggle
**Hidden in:** `src/main.ts` — `<label class="switch" ... hidden>` (the Live update toggle in the toolbar)

**To restore:** Remove the `hidden` attribute from the `<label class="switch">` element containing `#liveUpdateToggle`.

**How it works:** Live update sends each captured point to LightBurn immediately instead of waiting for a bulk Send. The toggle starts off and must be explicitly enabled. The user confirms a warning dialog before first use. All queue, handover, and journal code remains wired and functional — the toggle is purely a visibility change.

## Backup button
**Hidden in:** `src/main.ts` — `<button id="sessionBtn" ... hidden>` (in the export bar footer)

**To restore:** Remove the `hidden` attribute from the `<button id="sessionBtn">` element.

**How it works:** Opens the Backup dialog (sessionDialog) where users can export a JSON backup of all captured points/settings and restore one from file. The dialog DOM, save/load handlers, and all underlying session persistence code remain fully wired.

## Hidden status rows
**Hidden in:** `src/main.ts` — `#liveText`, `#statusSummary`, and `#captureBlockHint` elements were removed from the HTML entirely. `#exportStatus` was also removed from the footer.

**Now consolidated:** All status information flows through a single `#statusText` element in `.workspace-status`. Connection state is shown by the `#connectionState` chip in the header.

**To restore separate status rows:** Re-add `<p id="liveText">`, `<span id="statusSummary">`, `<p id="captureBlockHint">`, and `<p id="exportStatus">` to the HTML, restore their JS references (`liveTextEl`, `statusSummaryEl`, `captureHint`, `exportStatusEl`), and revert `renderControls()` to write to each element independently.

## Resume button (removed)
**Was:** The Finish button toggled between "Finish" and "Resume". After finishing a group, the user had to click Resume to start the next group.

**Now:** Capture point auto-resumes. After finishing, clicking Capture point sets `state.finished = false` and captures the first point of the new group. The Finish button stays permanently as "Finish" and is disabled when the group is finished or has too few points.

**To restore Resume button:** Revert the `finishBtn.textContent` line in `renderControls()` to `state.finished ? 'Resume' : 'Finish'`, revert the `finishBtn.disabled` line, and remove the auto-resume block from `capturePoint()` (lines `if (state.finished) { ... }` near the top of the function).