/* ============================================================
   ctc-layout.js — builds the schematic SVG for the CTC panel.
   Approach A (algorithmic): project the geographic /track + /junction
   coordinates into a normalized SVG coordinate space.
   Filled in at Step 3.
   ============================================================ */

// Logical SVG canvas the schematic is drawn into. updateCTC() positions
// overlays in this same space, so keep these in sync with ctc.js.
const CTC_VIEW_W = 1600;
const CTC_VIEW_H = 900;
const CTC_PADDING = 40;

// Populated by buildSchematic(): maps geographic [lat,lng] → schematic [x,y].
// updateCTC() reuses this projection to place trains/signals.
let ctcProjection = null;

// Build a projection from a bounding box of geographic coords to the SVG canvas.
// DV coords are small degree values; we fit them to CTC_VIEW with padding and
// flip Y so north is up.
function makeCtcProjection(minLat, minLng, maxLat, maxLng) {
	const spanLat = Math.max(maxLat - minLat, 1e-9);
	const spanLng = Math.max(maxLng - minLng, 1e-9);
	const usableW = CTC_VIEW_W - CTC_PADDING * 2;
	const usableH = CTC_VIEW_H - CTC_PADDING * 2;
	// Uniform scale to preserve aspect ratio.
	const scale = Math.min(usableW / spanLng, usableH / spanLat);
	return function project(lat, lng) {
		const x = CTC_PADDING + (lng - minLng) * scale;
		// Flip Y: higher latitude → smaller y (towards top).
		const y = CTC_PADDING + (maxLat - lat) * scale;
		return [x, y];
	};
}

// Returns an SVG markup string for the schematic. Stubbed at Step 2;
// real implementation lands in Step 3.
async function buildSchematic() {
	return `<text x="${CTC_VIEW_W / 2}" y="${CTC_VIEW_H / 2}" fill="#8892a4" `
		+ `font-family="monospace" font-size="20" text-anchor="middle">`
		+ `CTC schematic — loading…</text>`;
}
