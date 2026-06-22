/* ============================================================
   ctc.js — CTC dispatch panel controller.
   Renders the schematic (via ctc-layout.js), wires the live data
   feed into it, and hosts the multiplayer dispatch UI (zones,
   xfer, notes, chat).

   Depends on globals from main.js (allCarData, trackPolyLines,
   signalMarkers, junctions, map). All such references happen inside
   functions called at runtime, after main.js has executed, so the
   load order (ctc-layout.js, ctc.js, main.js) is safe.
   ============================================================ */

let ctcInitialised = false;

// One-time setup: render the schematic into #ctc-schematic. Safe to call
// repeatedly — only the first call does the work.
async function initCTC() {
	if (ctcInitialised) return;
	ctcInitialised = true;
	const svg = document.getElementById('ctc-schematic');
	if (!svg) return;
	svg.setAttribute('viewBox', `0 0 ${CTC_VIEW_W} ${CTC_VIEW_H}`);
	svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
	try {
		svg.innerHTML = await buildSchematic();
	} catch (e) {
		console.error('CTC schematic build failed:', e);
	}
}

// Refresh all live overlays on the schematic. Called whenever car / junction /
// signal data changes (only does work when CTC mode is visible). Stubbed at
// Step 2; occupancy/indicators land in Step 4.
function updateCTC() {
	if (!ctcInitialised) return;
}
