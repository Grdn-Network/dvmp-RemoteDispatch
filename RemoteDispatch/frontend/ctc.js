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
	wireCtcInteractions(svg);
	wireCtcPanZoom(svg);
	updateMarkerScales(svg);
}

/////////////////////
// Pan / zoom — pure client-side viewBox manipulation, no server state, so any
// number of simultaneous RD players each navigate the schematic independently.

const ctcViewBox = { x: 0, y: 0, w: CTC_VIEW_W, h: CTC_VIEW_H };
let ctcWasDragging = false;

function applyCtcViewBox(svg) {
	svg.setAttribute('viewBox',
		`${ctcViewBox.x.toFixed(2)} ${ctcViewBox.y.toFixed(2)} ${ctcViewBox.w.toFixed(2)} ${ctcViewBox.h.toFixed(2)}`);
}

function resetCtcViewBox(svg) {
	ctcViewBox.x = 0; ctcViewBox.y = 0;
	ctcViewBox.w = CTC_VIEW_W; ctcViewBox.h = CTC_VIEW_H;
	applyCtcViewBox(svg);
	updateMarkerScales(svg);
}

// Markers (signals, junctions, train labels) live in .ctc-scaled groups whose
// content is centred at the group origin. We counter-scale them by the inverse of
// the zoom so they stay a constant size on screen instead of ballooning when the
// viewBox shrinks. Only needs to run when the zoom (viewBox.w) changes, not on pan.
let ctcMarkerScale = 1;
function updateMarkerScales(svg) {
	ctcMarkerScale = ctcViewBox.w / CTC_VIEW_W;
	const s = ctcMarkerScale.toFixed(4);
	svg.querySelectorAll('.ctc-scaled').forEach(el => {
		const x = el.getAttribute('data-x');
		const y = el.getAttribute('data-y');
		if (x == null || y == null) return;
		el.setAttribute('transform', `translate(${x} ${y}) scale(${s})`);
	});
}

// Screen point -> current SVG/user coordinates, honouring preserveAspectRatio.
function ctcClientToSvg(svg, clientX, clientY) {
	const ctm = svg.getScreenCTM();
	if (!ctm) return null;
	const pt = svg.createSVGPoint();
	pt.x = clientX; pt.y = clientY;
	return pt.matrixTransform(ctm.inverse());
}

function wireCtcPanZoom(svg) {
	const ASPECT = CTC_VIEW_H / CTC_VIEW_W;
	const MIN_W = CTC_VIEW_W / 14;   // deepest zoom-in
	const MAX_W = CTC_VIEW_W * 1.2;  // furthest zoom-out
	const INTERACTIVE = '.ctc-junction, .ctc-signal, .ctc-train-label';

	// Wheel = zoom toward the cursor (the point under the cursor stays put).
	svg.addEventListener('wheel', e => {
		e.preventDefault();
		const p = ctcClientToSvg(svg, e.clientX, e.clientY);
		if (!p) return;
		const factor = e.deltaY < 0 ? 0.85 : 1.18;
		const newW = Math.min(MAX_W, Math.max(MIN_W, ctcViewBox.w * factor));
		const newH = newW * ASPECT;
		const fx = (p.x - ctcViewBox.x) / ctcViewBox.w;
		const fy = (p.y - ctcViewBox.y) / ctcViewBox.h;
		ctcViewBox.x = p.x - fx * newW;
		ctcViewBox.y = p.y - fy * newH;
		ctcViewBox.w = newW;
		ctcViewBox.h = newH;
		applyCtcViewBox(svg);
		updateMarkerScales(svg); // zoom changed → keep markers a constant screen size
	}, { passive: false });

	// Drag empty space = pan. A real drag (>4px) sets ctcWasDragging so the
	// click handler skips the junction-toggle/signal-popup that would otherwise
	// fire at pointerup.
	let panning = false, startCX = 0, startCY = 0, startVBx = 0, startVBy = 0, sa = 1, sd = 1, moved = 0;
	svg.addEventListener('pointerdown', e => {
		if (e.button !== 0) return;
		if (e.target.closest(INTERACTIVE)) return;
		const ctm = svg.getScreenCTM();
		if (!ctm) return;
		panning = true; moved = 0;
		startCX = e.clientX; startCY = e.clientY;
		startVBx = ctcViewBox.x; startVBy = ctcViewBox.y;
		sa = ctm.a || 1; sd = ctm.d || 1;
		try { svg.setPointerCapture(e.pointerId); } catch (_) { }
		svg.style.cursor = 'grabbing';
	});
	svg.addEventListener('pointermove', e => {
		if (!panning) return;
		const dxC = e.clientX - startCX, dyC = e.clientY - startCY;
		moved = Math.max(moved, Math.abs(dxC) + Math.abs(dyC));
		ctcViewBox.x = startVBx - dxC / sa;
		ctcViewBox.y = startVBy - dyC / sd;
		applyCtcViewBox(svg);
	});
	function endPan(e) {
		if (!panning) return;
		panning = false;
		svg.style.cursor = '';
		try { svg.releasePointerCapture(e.pointerId); } catch (_) { }
		if (moved > 4) ctcWasDragging = true;
	}
	svg.addEventListener('pointerup', endPan);
	svg.addEventListener('pointercancel', endPan);

	// Double-click empty space resets to full view.
	svg.addEventListener('dblclick', e => {
		if (e.target.closest(INTERACTIVE)) return;
		e.preventDefault();
		resetCtcViewBox(svg);
	});
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

// Map a signal aspect to a colour class, per the GRDN OPS signal chart:
//   S2/S3/S4/S5 = proceed (green), S6/S7 = caution (yellow), S1/S1c = stop (red).
//   S0 = "controlled by dispatch" (white in-game) — in CTC we never show white;
//        a controlled signal reads as held-at-stop (red).
//   Distant (repeater) signals are advisory — always amber, never green/red/white,
//        so they read distinctly from controllable main signals.
//   Anything unreported/OFF defaults to red (safe).
function ctcSignalColorClass(aspect, type) {
	if (type === 'Distant') return 'yellow';
	const a = String(aspect || '').toUpperCase();
	switch (a) {
		case 'S2':
		case 'S3':
		case 'S4':
		case 'S5': return 'green';
		case 'S6':
		case 'S7': return 'yellow';
		case 'S1':
		case 'S1C': return 'red';
		case 'S0': return 'red'; // controlled by dispatch — held, not white
		default: return 'red';   // OFF / unknown → stop
	}
}

function updateSignalIndicators() {
	if (typeof signalMarkers === 'undefined') return;
	signalMarkers.forEach((entry, signalId) => {
		const el = ctcSignalEls.get(signalId);
		if (!el) return;
		// Keep ctc-scaled so the zoom-compensating transform is preserved.
		el.setAttribute('class', 'ctc-signal ctc-scaled ' + ctcSignalColorClass(entry.aspect, entry.type));
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
		dx = dx / len * 11; dy = dy / len * 11; // local units; the group scale keeps it constant on screen
		if (!line) {
			line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('class', 'ctc-junction-blade');
			g.appendChild(line);
		}
		// Drawn from the junction's group origin (the group is translate + scale).
		line.setAttribute('x1', '0');
		line.setAttribute('y1', '0');
		line.setAttribute('x2', dx.toFixed(1));
		line.setAttribute('y2', dy.toFixed(1));
	});
}

// Float each locomotive's id next to its position on the schematic. Locos are
// few, so the whole layer is rebuilt each tick.
function updateTrainLabels() {
	const layer = document.getElementById('ctc-trains');
	if (!layer || !ctcProjection || typeof allCarData === 'undefined') return;
	const s = ctcMarkerScale.toFixed(4);
	const parts = [];
	allCarData.forEach((car, carId) => {
		if (carId.slice(0, 2) !== 'L-' || !car || !car.position) return;
		const p = ctcProjection(car.position[0], car.position[1]);
		// Constant on-screen size: the label is drawn at a small local offset and
		// the group transform applies the zoom-compensating scale (like the markers).
		parts.push(`<text class="ctc-train-label ctc-scaled" data-train-id="${ctcEscapeAttr(carId)}" `
			+ `data-x="${p[0].toFixed(1)}" data-y="${p[1].toFixed(1)}" x="6" y="-6" `
			+ `transform="translate(${p[0].toFixed(1)} ${p[1].toFixed(1)}) scale(${s})">`
			+ `${ctcEscapeAttr(carId.slice(2))}</text>`);
	});
	layer.innerHTML = parts.join('');
}

/////////////////////
// Control — throw junctions, set signal aspects from the panel

// Single delegated click handler on the schematic: junctions toggle, signals
// open an aspect popup, clicks elsewhere dismiss the popup. Reuses main.js's
// toggleJunction() and buildSignalPopup() so behaviour matches the map exactly.
function wireCtcInteractions(svg) {
	svg.addEventListener('click', e => {
		// A click that ends a pan-drag shouldn't throw a switch / open a popup.
		if (ctcWasDragging) { ctcWasDragging = false; return; }
		const jg = e.target.closest('.ctc-junction');
		if (jg) {
			const idx = jg.getAttribute('data-junction-id');
			if (idx == null) return;
			if (ctcRouteMode) {
				onRouteJunctionClick(Number(idx)); // pick origin/destination
			} else if (typeof toggleJunction === 'function') {
				toggleJunction(Number(idx));
			}
			closeCtcSignalPopup();
			return;
		}
		const sig = e.target.closest('.ctc-signal');
		if (sig) {
			openCtcSignalPopup(sig.getAttribute('data-signal-id'), e);
			return;
		}
		const train = e.target.closest('.ctc-train-label');
		if (train) {
			openXferOffer(train.getAttribute('data-train-id'), e);
			return;
		}
		closeCtcSignalPopup();
		closeXferOffer();
	});
}

let ctcSignalPopupEl = null;

function openCtcSignalPopup(signalId, evt) {
	closeCtcSignalPopup();
	if (!signalId || typeof signalMarkers === 'undefined') return;
	const entry = signalMarkers.get(signalId);
	if (!entry) return;
	// buildSignalPopup returns '' (no state), a <strong> (Distant), or a wired
	// container <div> with the manual-control + aspect-apply listeners attached.
	const content = (typeof buildSignalPopup === 'function')
		? buildSignalPopup(signalId, entry.type) : '';
	if (!content) return;
	const wrap = document.createElement('div');
	wrap.id = 'ctc-signal-popup';
	if (typeof content === 'string') wrap.innerHTML = content;
	else wrap.appendChild(content);
	const panel = document.getElementById('ctc-panel');
	const rect = panel.getBoundingClientRect();
	// Keep the popup inside the panel near the click point.
	const x = Math.min(evt.clientX - rect.left + 12, rect.width - 280);
	const y = Math.min(evt.clientY - rect.top + 12, rect.height - 200);
	wrap.style.left = Math.max(8, x) + 'px';
	wrap.style.top = Math.max(8, y) + 'px';
	panel.appendChild(wrap);
	ctcSignalPopupEl = wrap;
}

function closeCtcSignalPopup() {
	if (ctcSignalPopupEl) {
		ctcSignalPopupEl.remove();
		ctcSignalPopupEl = null;
	}
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

/////////////////////
// Bulk signal control — take all / a section (current view) / none under manual

function ctcAllSignalIds() {
	return [...ctcSignalEls.keys()];
}

// Signals whose dot currently falls inside the visible viewBox.
function ctcSignalIdsInView() {
	const ids = [];
	ctcSignalEls.forEach((el, id) => {
		const dot = el.querySelector('.ctc-signal-dot');
		if (!dot) return;
		const cx = parseFloat(dot.getAttribute('cx'));
		const cy = parseFloat(dot.getAttribute('cy'));
		if (cx >= ctcViewBox.x && cx <= ctcViewBox.x + ctcViewBox.w
			&& cy >= ctcViewBox.y && cy <= ctcViewBox.y + ctcViewBox.h)
			ids.push(id);
	});
	return ids;
}

// POST a bulk mode/aspect change and report how many the API actually applied.
function ctcBulkSignals(ids, mode, aspect) {
	if (!ids.length) { ctcToolbarStatus('no signals'); return; }
	const body = { signalIds: ids, mode };
	if (aspect) body.aspect = aspect;
	fetch(new URL('/signals/bulk', location), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
		.then(r => r.ok ? r.json() : null)
		.then(d => {
			if (!d) { ctcToolbarStatus('failed'); return; }
			const verb = mode === 'Manual' ? 'held' : 'released';
			ctcToolbarStatus(`${verb} ${d.applied}/${d.requested}`);
		})
		.catch(err => { console.error('Bulk signals failed:', err); ctcToolbarStatus('failed'); });
}

let ctcToolbarStatusTimer = null;
function ctcToolbarStatus(msg) {
	const el = document.getElementById('ctc-toolbar-status');
	if (!el) return;
	el.textContent = msg;
	clearTimeout(ctcToolbarStatusTimer);
	ctcToolbarStatusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

function initCtcToolbar() {
	const all = document.getElementById('ctc-sig-all');
	const view = document.getElementById('ctc-sig-view');
	const release = document.getElementById('ctc-sig-release');
	if (all) all.addEventListener('click', () => ctcBulkSignals(ctcAllSignalIds(), 'Manual', 'S1'));
	if (view) view.addEventListener('click', () => ctcBulkSignals(ctcSignalIdsInView(), 'Manual', 'S1'));
	if (release) release.addEventListener('click', () => ctcBulkSignals(ctcAllSignalIds(), 'Automatic', null));

	const routeBtn = document.getElementById('ctc-route-btn');
	if (routeBtn) routeBtn.addEventListener('click', toggleRouteMode);
	const clearBtn = document.getElementById('ctc-route-clear');
	if (clearBtn) clearBtn.addEventListener('click', clearRoutes);
	const setBtn = document.getElementById('ctc-route-set');
	if (setBtn) setBtn.addEventListener('click', confirmRoute);
	const cancelBtn = document.getElementById('ctc-route-cancel');
	if (cancelBtn) cancelBtn.addEventListener('click', cancelRoute);
}

/////////////////////
// Route-setting (NX-style): click junction A then B; the software pathfinds on a
// track graph built from the geometry, previews the route, and on confirm throws
// the switches along it and greens the signals on the path.
//
// NOTE: the graph is built by snapping coincident track endpoints (epsilon grid).
// The epsilon and junction→node snapping should be validated against real DV
// topology in-game. The mandatory preview+confirm means a wrong path is shown
// before anything is thrown.

let ctcGraph = null;        // { adj: Map<node,[{track,to}]>, nodePos: Map<node,[lat,lng]> }
let ctcRouteMode = false;
let ctcRouteA = null;       // first picked junction index
let ctcRoutePath = null;    // { a, b, tracks:[...] }
const ctcReservedTracks = new Set(); // tracks held by an active route — new routes can't cross them
const ctcRouteSignals = new Set();   // signals greened by active routes (restored to red on clear)

const CTC_NODE_Q = 1e-5;    // ~1.1 m endpoint-merge grid
function ctcNodeKey(lat, lng) {
	return Math.round(lat / CTC_NODE_Q) + ',' + Math.round(lng / CTC_NODE_Q);
}

function buildTrackGraph() {
	const adj = new Map();
	const nodePos = new Map();
	const addNode = (lat, lng) => {
		const k = ctcNodeKey(lat, lng);
		if (!adj.has(k)) { adj.set(k, []); nodePos.set(k, [lat, lng]); }
		return k;
	};
	if (typeof trackPolyLines !== 'undefined') {
		trackPolyLines.forEach((poly, trackId) => {
			const lls = poly.getLatLngs();
			if (!lls || lls.length < 2) return;
			const a = lls[0], b = lls[lls.length - 1];
			const ka = addNode(a.lat, a.lng), kb = addNode(b.lat, b.lng);
			if (ka === kb) return;
			adj.get(ka).push({ track: trackId, to: kb });
			adj.get(kb).push({ track: trackId, to: ka });
		});
	}
	ctcGraph = { adj, nodePos };
}

// Graph node for a junction: its exact endpoint node, else the nearest node
// (junction markers can sit slightly off the shared track endpoint).
function ctcJunctionNode(index) {
	const j = (typeof junctions !== 'undefined') && junctions[index];
	if (!j || !j.marker) return null;
	const c = j.marker.getBounds().getCenter();
	const exact = ctcNodeKey(c.lat, c.lng);
	if (ctcGraph.adj.has(exact)) return exact;
	let best = null, bd = Infinity;
	ctcGraph.nodePos.forEach((p, k) => {
		const d = (p[0] - c.lat) ** 2 + (p[1] - c.lng) ** 2;
		if (d < bd) { bd = d; best = k; }
	});
	return best;
}

// BFS over the track graph; returns the ordered list of trackIds, or null.
function findRoute(aIndex, bIndex) {
	if (!ctcGraph) buildTrackGraph();
	const start = ctcJunctionNode(aIndex), goal = ctcJunctionNode(bIndex);
	if (start == null || goal == null || !ctcGraph.adj.has(start) || !ctcGraph.adj.has(goal)) return null;
	const prev = new Map();
	const queue = [start];
	const seen = new Set([start]);
	while (queue.length) {
		const n = queue.shift();
		if (n === goal) break;
		for (const e of ctcGraph.adj.get(n) || []) {
			if (ctcReservedTracks.has(e.track)) continue; // can't cross another active route
			if (seen.has(e.to)) continue;
			seen.add(e.to);
			prev.set(e.to, { from: n, track: e.track });
			queue.push(e.to);
		}
	}
	if (!seen.has(goal)) return null;
	const tracks = [];
	let cur = goal;
	while (cur !== start) {
		const p = prev.get(cur);
		if (!p) return null;
		tracks.push(p.track);
		cur = p.from;
	}
	return tracks.reverse();
}

function toggleRouteMode() {
	ctcRouteMode = !ctcRouteMode;
	ctcRouteA = null;
	ctcRoutePath = null;
	clearRouteHighlight();
	hideRouteConfirm();
	const btn = document.getElementById('ctc-route-btn');
	if (btn) btn.classList.toggle('active', ctcRouteMode);
	const svg = document.getElementById('ctc-schematic');
	if (svg) svg.classList.toggle('route-mode', ctcRouteMode);
	ctcToolbarStatus(ctcRouteMode ? 'pick origin junction' : '');
}

// Called from the junction click path when route mode is active.
function onRouteJunctionClick(idx) {
	if (ctcRouteA == null) {
		ctcRouteA = idx;
		markRouteEndpoint(idx);
		ctcToolbarStatus('pick destination junction');
		return;
	}
	if (idx === ctcRouteA) return;
	const path = findRoute(ctcRouteA, idx);
	if (!path || !path.length) { ctcToolbarStatus('no route found'); return; }
	ctcRoutePath = { a: ctcRouteA, b: idx, tracks: path };
	highlightRoute(path);
	showRouteConfirm(path.length);
}

function clearRouteHighlight() {
	const svg = document.getElementById('ctc-schematic');
	if (!svg) return;
	svg.querySelectorAll('.ctc-track.ctc-route').forEach(el => el.classList.remove('ctc-route'));
	svg.querySelectorAll('.ctc-junction.ctc-route-end').forEach(el => el.classList.remove('ctc-route-end'));
}

function markRouteEndpoint(idx) {
	const g = ctcJunctionEls.get(String(idx));
	if (g) g.classList.add('ctc-route-end');
}

function highlightRoute(tracks) {
	for (const t of tracks) {
		const el = ctcTrackEls.get(t);
		if (el) el.classList.add('ctc-route');
	}
}

function showRouteConfirm(len) {
	const bar = document.getElementById('ctc-route-confirm');
	const txt = document.getElementById('ctc-route-confirm-text');
	if (txt) txt.textContent = `Set route over ${len} track${len === 1 ? '' : 's'}?`;
	if (bar) bar.classList.add('visible');
}

function hideRouteConfirm() {
	const bar = document.getElementById('ctc-route-confirm');
	if (bar) bar.classList.remove('visible');
}

function confirmRoute() {
	if (ctcRoutePath) applyRoute(ctcRoutePath.tracks);
	cancelRoute();
}

function cancelRoute() {
	ctcRouteA = null;
	ctcRoutePath = null;
	clearRouteHighlight();
	hideRouteConfirm();
	if (ctcRouteMode) ctcToolbarStatus('pick origin junction');
}

// Throw the switches along the path and green its signals.
function applyRoute(tracks) {
	const pathSet = new Set(tracks);
	let thrown = 0;
	if (typeof junctions !== 'undefined') {
		junctions.forEach((j, idx) => {
			if (!j || !j.branches || j.selectedBranch == null) return;
			const want = pathSet.has(j.branches[0]) ? 0
				: (pathSet.has(j.branches[1]) ? 1 : -1);
			if (want !== -1 && want !== j.selectedBranch && typeof toggleJunction === 'function') {
				toggleJunction(idx);
				thrown++;
			}
		});
	}
	const sigIds = [];
	if (typeof signalMarkers !== 'undefined') {
		signalMarkers.forEach((entry, id) => {
			if (!entry || !entry.position) return;
			const tk = findClosestTrack(entry.position);
			if (tk && pathSet.has(tk)) sigIds.push(id);
		});
	}
	if (sigIds.length) ctcBulkSignals(sigIds, 'Manual', 'S2');
	// Reserve the route: hold its tracks (so a conflicting route can't cross them —
	// it will terminate at the boundary, where the off-route signal stays red) and
	// show them green; remember the greened signals so Clear can restore them.
	for (const t of tracks) {
		ctcReservedTracks.add(t);
		const el = ctcTrackEls.get(t);
		if (el) el.classList.add('reserved');
	}
	sigIds.forEach(id => ctcRouteSignals.add(id));
	ctcToolbarStatus(`route set: ${thrown} switch${thrown === 1 ? '' : 'es'}, ${sigIds.length} signals`);
}

// Release all active routes: drop reservations, un-green the tracks, and put their
// signals back to red (stop).
function clearRoutes() {
	if (!ctcReservedTracks.size && !ctcRouteSignals.size) {
		ctcToolbarStatus('no active routes');
		return;
	}
	ctcTrackEls.forEach(el => el.classList.remove('reserved'));
	ctcReservedTracks.clear();
	const sigs = [...ctcRouteSignals];
	ctcRouteSignals.clear();
	if (sigs.length) ctcBulkSignals(sigs, 'Manual', 'S1');
	ctcToolbarStatus(`cleared ${sigs.length} signal${sigs.length === 1 ? '' : 's'}`);
}

/////////////////////
// Collaboration — identity, shared notes, chat

// This client's authenticated name, used for "owned-by-me" and xfer targeting.
// The server enforces those anyway; this is only for UI.
let myUsername = '';

function fetchWhoami() {
	fetch(new URL('/whoami', location))
		.then(r => r.ok ? r.json() : null)
		.then(d => {
			if (d && d.username) {
				myUsername = d.username;
				// Zone state may have arrived before we knew our name; re-render so
				// the owned-by-me highlight is correct.
				renderZoneBar();
			}
		})
		.catch(() => {});
}

// Notes: the server broadcasts the whole notepad; apply it unless this client is
// mid-edit (so a remote update doesn't clobber what the user is typing).
function handleNotesUpdate(data) {
	const el = document.getElementById('ctc-notes-area');
	if (!el || !data) return;
	if (document.activeElement === el) return;
	if (typeof data.content === 'string') el.value = data.content;
}

// Chat: the server broadcasts the full recent log; rebuild it, keeping the view
// pinned to the bottom if it already was.
function handleChat(data) {
	const log = document.getElementById('ctc-chat-log');
	if (!log || !data || !Array.isArray(data.messages)) return;
	const atBottom = Math.abs(log.scrollHeight - log.clientHeight - log.scrollTop) < 30;
	log.innerHTML = data.messages
		.map(m => `<div><b>${ctcEscapeAttr(m.user)}</b>: ${ctcEscapeAttr(m.text)}</div>`)
		.join('');
	if (atBottom) log.scrollTop = log.scrollHeight;
}

/////////////////////
// Zones — claim / release control territory

let ctcZoneState = {}; // zoneId -> { name, color, owner }

function handleZoneState(data) {
	if (!data || !data.zones) return;
	ctcZoneState = data.zones;
	renderZoneBar();
}

function renderZoneBar() {
	const bar = document.getElementById('ctc-zonebar');
	if (!bar) return;
	const ids = Object.keys(ctcZoneState).sort();
	bar.innerHTML = ids.map(id => {
		const z = ctcZoneState[id];
		const mine = z.owner && z.owner === myUsername;
		const ownerLabel = z.owner ? (mine ? 'you' : z.owner) : 'free';
		return `<div class="ctc-zone-chip${mine ? ' owned-by-me' : ''}" data-zone-id="${ctcEscapeAttr(id)}">`
			+ `<span class="ctc-zone-dot" style="background:${ctcEscapeAttr(z.color || '#888')}"></span>`
			+ `<span>${ctcEscapeAttr(z.name || id)}</span>`
			+ `<span class="ctc-zone-chip-owner">${ctcEscapeAttr(ownerLabel)}</span></div>`;
	}).join('');
}

// Click a chip: claim if free, release if it's mine, ignore if someone else owns it.
function onZoneBarClick(e) {
	const chip = e.target.closest('.ctc-zone-chip');
	if (!chip) return;
	const id = chip.getAttribute('data-zone-id');
	const z = ctcZoneState[id];
	if (!z) return;
	if (z.owner && z.owner === myUsername) {
		fetch(new URL(`/zone/${encodeURIComponent(id)}/release`, location), { method: 'POST' })
			.catch(err => console.error('Zone release failed:', err));
	} else if (!z.owner) {
		fetch(new URL(`/zone/${encodeURIComponent(id)}/claim`, location), { method: 'POST' })
			.then(r => { if (r.status === 409) console.warn('Zone already claimed'); })
			.catch(err => console.error('Zone claim failed:', err));
	}
	// Owned by someone else: no-op.
}

/////////////////////
// Xfer — receive offers (banner) and send offers (train click)

let ctcPendingXferId = null;

function handleXfer(data) {
	if (!data || !Array.isArray(data.offers)) { hideXferBanner(); return; }
	const now = Date.now();
	// Show the first still-valid offer addressed to me.
	const mine = data.offers.find(o =>
		o.toUser === myUsername && (!o.expiresAt || o.expiresAt > now));
	if (mine) showXferBanner(mine);
	else hideXferBanner();
}

function showXferBanner(offer) {
	ctcPendingXferId = offer.offerId;
	const text = document.getElementById('ctc-xfer-text');
	const banner = document.getElementById('ctc-xfer-banner');
	if (text) {
		const zone = (ctcZoneState[offer.toZone] && ctcZoneState[offer.toZone].name) || offer.toZone || '?';
		text.textContent = `${offer.fromUser || '?'} offers ${offer.trainId} → ${zone}`;
	}
	if (banner) banner.classList.add('visible');
}

function hideXferBanner() {
	ctcPendingXferId = null;
	const banner = document.getElementById('ctc-xfer-banner');
	if (banner) banner.classList.remove('visible');
}

// Offer a train to another dispatcher: pick one of their zones, then POST the offer.
let ctcXferOfferEl = null;

function openXferOffer(trainId, evt) {
	closeXferOffer();
	if (!trainId) return;
	// Valid recipients are zones owned by someone other than me.
	const targets = Object.keys(ctcZoneState)
		.filter(id => {
			const o = ctcZoneState[id].owner;
			return o && o !== myUsername;
		})
		.sort();

	const wrap = document.createElement('div');
	wrap.id = 'ctc-xfer-offer';
	if (targets.length === 0) {
		wrap.innerHTML = `<div class="ctc-xfer-offer-title">Offer ${ctcEscapeAttr(trainId)}</div>`
			+ `<div class="ctc-xfer-offer-empty">No other dispatcher is holding a zone to receive it.</div>`
			+ `<div class="ctc-xfer-offer-actions"><button id="ctc-xfer-cancel">Close</button></div>`;
	} else {
		const options = targets.map(id => {
			const z = ctcZoneState[id];
			return `<option value="${ctcEscapeAttr(id)}">${ctcEscapeAttr(z.name || id)} — ${ctcEscapeAttr(z.owner)}</option>`;
		}).join('');
		wrap.innerHTML = `<div class="ctc-xfer-offer-title">Offer ${ctcEscapeAttr(trainId)}</div>`
			+ `<select id="ctc-xfer-zone">${options}</select>`
			+ `<div class="ctc-xfer-offer-actions">`
			+ `<button id="ctc-xfer-send">Offer</button>`
			+ `<button id="ctc-xfer-cancel">Cancel</button></div>`;
	}

	const panel = document.getElementById('ctc-panel');
	const rect = panel.getBoundingClientRect();
	const x = Math.min(evt.clientX - rect.left + 12, rect.width - 240);
	const y = Math.min(evt.clientY - rect.top + 12, rect.height - 140);
	wrap.style.left = Math.max(8, x) + 'px';
	wrap.style.top = Math.max(8, y) + 'px';
	panel.appendChild(wrap);
	ctcXferOfferEl = wrap;

	const sendBtn = document.getElementById('ctc-xfer-send');
	if (sendBtn) {
		sendBtn.addEventListener('click', () => {
			const zoneId = document.getElementById('ctc-xfer-zone').value;
			const z = ctcZoneState[zoneId];
			if (!z || !z.owner) return;
			fetch(new URL('/xfer/offer', location), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ trainId, toZone: zoneId, toUser: z.owner }),
			}).catch(err => console.error('Xfer offer failed:', err));
			closeXferOffer();
		});
	}
	const cancelBtn = document.getElementById('ctc-xfer-cancel');
	if (cancelBtn) cancelBtn.addEventListener('click', closeXferOffer);
}

function closeXferOffer() {
	if (ctcXferOfferEl) {
		ctcXferOfferEl.remove();
		ctcXferOfferEl = null;
	}
}

let ctcNotesSyncTimer = null;

function initCollab() {
	const notes = document.getElementById('ctc-notes-area');
	if (notes) {
		notes.addEventListener('input', e => {
			clearTimeout(ctcNotesSyncTimer);
			const value = e.target.value;
			ctcNotesSyncTimer = setTimeout(() => {
				fetch(new URL('/notes', location), { method: 'POST', body: value })
					.catch(err => console.error('Notes sync failed:', err));
			}, 500);
		});
	}

	const chatInput = document.getElementById('ctc-chat-input');
	if (chatInput) {
		chatInput.addEventListener('keydown', e => {
			if (e.key === 'Enter' && e.target.value.trim()) {
				fetch(new URL('/chat', location), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ text: e.target.value.trim() }),
				}).catch(err => console.error('Chat send failed:', err));
				e.target.value = '';
			}
		});
	}

	// Notes / Chat tab switch within the collab panel.
	const tabs = document.getElementById('ctc-collab-tabs');
	const collab = document.getElementById('ctc-collab');
	if (tabs && collab) {
		tabs.addEventListener('click', e => {
			const btn = e.target.closest('.ctc-tab');
			if (!btn) return;
			tabs.querySelectorAll('.ctc-tab').forEach(t => t.classList.remove('active'));
			btn.classList.add('active');
			collab.classList.toggle('chat-mode', btn.dataset.tab === 'chat');
		});
	}

	// Zone claim/release.
	const zonebar = document.getElementById('ctc-zonebar');
	if (zonebar) zonebar.addEventListener('click', onZoneBarClick);

	// Xfer accept / reject.
	const acc = document.getElementById('ctc-xfer-accept');
	if (acc) acc.addEventListener('click', () => {
		if (ctcPendingXferId)
			fetch(new URL(`/xfer/accept/${ctcPendingXferId}`, location), { method: 'POST' })
				.catch(err => console.error('Xfer accept failed:', err));
	});
	const rej = document.getElementById('ctc-xfer-reject');
	if (rej) rej.addEventListener('click', () => {
		if (ctcPendingXferId)
			fetch(new URL(`/xfer/reject/${ctcPendingXferId}`, location), { method: 'POST' })
				.catch(err => console.error('Xfer reject failed:', err));
	});

	initCtcToolbar();
	fetchWhoami();
}

// ctc.js loads after the panel markup, so the elements exist now.
initCollab();
