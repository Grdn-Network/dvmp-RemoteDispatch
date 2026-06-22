/* ============================================================
   ctc.js — CTC dispatch panel controller.
   Renders the schematic (via ctc-layout.js), wires the live data
   feed into it, and (in later steps) hosts the multiplayer dispatch
   UI (zones, xfer, notes, chat).

   Depends on globals from main.js (allCarData, trackPolyLines,
   signalMarkers, junctions, map). All such references happen inside
   functions called at runtime, after main.js has executed, so the
   load order (ctc-layout.js, ctc.js, main.js) is safe.
   ============================================================ */

let ctcInitialised = false;

// Cached element references, keyed by their data-* id, built once after the
// schematic SVG is injected. Avoids per-frame querySelector + CSS escaping.
const ctcTrackEls = new Map();    // trackId -> <polyline>
const ctcSignalEls = new Map();   // signalId -> <circle>
const ctcJunctionEls = new Map(); // junctionIndex(string) -> <g>

// One-time setup: render the schematic and cache element references. Safe to
// call repeatedly — only the first call does the work.
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
		return;
	}
	buildCtcElementMaps(svg);
}

function buildCtcElementMaps(svg) {
	ctcTrackEls.clear();
	ctcSignalEls.clear();
	ctcJunctionEls.clear();
	svg.querySelectorAll('[data-track-id]').forEach(el =>
		ctcTrackEls.set(el.getAttribute('data-track-id'), el));
	svg.querySelectorAll('[data-signal-id]').forEach(el =>
		ctcSignalEls.set(el.getAttribute('data-signal-id'), el));
	svg.querySelectorAll('[data-junction-id]').forEach(el =>
		ctcJunctionEls.set(el.getAttribute('data-junction-id'), el));
}

/////////////////////
// Track occupancy — spatial index

// Grid index over track vertices for fast nearest-track lookup. Vertex-based
// (not point-to-segment), which is adequate while DV tracks are densely
// sampled; segment-distance is a possible future refinement for sparse straights.
let ctcTrackIndex = null;

function buildTrackIndex() {
	const size = 0.003; // ~330 m cells
	const cells = new Map();
	if (typeof trackPolyLines !== 'undefined') {
		trackPolyLines.forEach((poly, trackId) => {
			const lls = poly.getLatLngs();
			for (const ll of lls) {
				const key = Math.floor(ll.lat / size) + '_' + Math.floor(ll.lng / size);
				let arr = cells.get(key);
				if (!arr) { arr = []; cells.set(key, arr); }
				arr.push([trackId, ll.lat, ll.lng]);
			}
		});
	}
	ctcTrackIndex = { size, cells };
}

// Returns the id of the track whose nearest vertex is closest to position, or
// null if nothing is within the match threshold.
function findClosestTrack(position) {
	if (!ctcTrackIndex) buildTrackIndex();
	const { size, cells } = ctcTrackIndex;
	const lat = position[0], lng = position[1];
	const ci = Math.floor(lat / size), cj = Math.floor(lng / size);
	let best = null, bestD = Infinity;
	for (let di = -1; di <= 1; di++) {
		for (let dj = -1; dj <= 1; dj++) {
			const arr = cells.get((ci + di) + '_' + (cj + dj));
			if (!arr) continue;
			for (const entry of arr) {
				const dlat = entry[1] - lat, dlng = entry[2] - lng;
				const d = dlat * dlat + dlng * dlng;
				if (d < bestD) { bestD = d; best = entry[0]; }
			}
		}
	}
	const maxD = 0.003 * 0.003; // ~330 m — generous; nearest still wins between tracks
	return bestD <= maxD ? best : null;
}

// Set of track ids occupied by at least one car (locos included).
function computeOccupiedTracks() {
	const occupied = new Set();
	if (typeof allCarData === 'undefined') return occupied;
	allCarData.forEach(car => {
		if (!car || !car.position) return;
		const trackId = findClosestTrack(car.position);
		if (trackId) occupied.add(trackId);
	});
	return occupied;
}

/////////////////////
// Live overlays

function updateBlockOccupancy() {
	const occupied = computeOccupiedTracks();
	ctcTrackEls.forEach((el, trackId) => {
		const isOcc = occupied.has(trackId);
		if (isOcc) el.classList.add('occupied');
		else if (el.classList.contains('occupied')) el.classList.remove('occupied');
	});
}

// Map a signal aspect to a colour class. Aspect meanings are taken from the
// existing signal popup: S2=Clear, S4=Expect Caution, S6=Caution, S1/S1c=Stop.
// Distant (repeater) signals warn of the next signal and never show a hard stop.
function ctcSignalColorClass(aspect, type) {
	if (!aspect || aspect === 'OFF') return 'unknown';
	const a = String(aspect).toUpperCase();
	if (type === 'Distant') {
		return (a === 'DS1' || a === 'DS2') ? 'yellow' : 'green';
	}
	switch (a) {
		case 'S1':
		case 'S1C': return 'red';
		case 'S6':
		case 'S4': return 'yellow';
		case 'S2': return 'green';
		default: return 'unknown';
	}
}

function updateSignalIndicators() {
	if (typeof signalMarkers === 'undefined') return;
	signalMarkers.forEach((entry, signalId) => {
		const el = ctcSignalEls.get(signalId);
		if (!el) return;
		el.setAttribute('class', 'ctc-signal ' + ctcSignalColorClass(entry.aspect, entry.type));
	});
}

function ctcDist2(a, b) {
	const dlat = a.lat - b.lat, dlng = a.lng - b.lng;
	return dlat * dlat + dlng * dlng;
}

// Draw a short blade on each junction pointing toward its selected branch.
function updateJunctionBlades() {
	if (typeof junctions === 'undefined' || !ctcProjection) return;
	junctions.forEach((j, index) => {
		const g = ctcJunctionEls.get(String(index));
		if (!g || j == null || j.selectedBranch == null || !j.branches) return;
		const selectedTrackId = j.branches[j.selectedBranch];
		const poly = (typeof trackPolyLines !== 'undefined') && trackPolyLines.get(selectedTrackId);
		let line = g.querySelector('.ctc-junction-blade');
		const jc = j.marker.getBounds().getCenter();
		const jp = ctcProjection(jc.lat, jc.lng);
		if (!poly) { if (line) line.remove(); return; }
		const lls = poly.getLatLngs();
		if (lls.length < 2) { if (line) line.remove(); return; }
		// Step one vertex in from whichever end of the track meets the junction.
		const firstNear = ctcDist2(lls[0], jc) <= ctcDist2(lls[lls.length - 1], jc);
		const target = firstNear ? lls[1] : lls[lls.length - 2];
		const tp = ctcProjection(target.lat, target.lng);
		let dx = tp[0] - jp[0], dy = tp[1] - jp[1];
		const len = Math.hypot(dx, dy) || 1;
		dx = dx / len * 11; dy = dy / len * 11; // 11px blade
		if (!line) {
			line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('class', 'ctc-junction-blade');
			g.appendChild(line);
		}
		line.setAttribute('x1', jp[0].toFixed(1));
		line.setAttribute('y1', jp[1].toFixed(1));
		line.setAttribute('x2', (jp[0] + dx).toFixed(1));
		line.setAttribute('y2', (jp[1] + dy).toFixed(1));
	});
}

// Float each locomotive's id next to its position on the schematic. Locos are
// few, so the whole layer is rebuilt each tick.
function updateTrainLabels() {
	const layer = document.getElementById('ctc-trains');
	if (!layer || !ctcProjection || typeof allCarData === 'undefined') return;
	const parts = [];
	allCarData.forEach((car, carId) => {
		if (carId.slice(0, 2) !== 'L-' || !car || !car.position) return;
		const p = ctcProjection(car.position[0], car.position[1]);
		parts.push(`<text class="ctc-train-label" x="${(p[0] + 6).toFixed(1)}" `
			+ `y="${(p[1] - 6).toFixed(1)}">${ctcEscapeAttr(carId.slice(2))}</text>`);
	});
	layer.innerHTML = parts.join('');
}

// Refresh all live overlays on the schematic. Called whenever car / junction /
// signal data changes; the callers already gate on ctcMode being active.
function updateCTC() {
	if (!ctcInitialised) return;
	updateBlockOccupancy();
	updateSignalIndicators();
	updateJunctionBlades();
	updateTrainLabels();
}
