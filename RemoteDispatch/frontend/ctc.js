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
		parts.push(`<text class="ctc-train-label" data-train-id="${ctcEscapeAttr(carId)}" `
			+ `x="${(p[0] + 6).toFixed(1)}" y="${(p[1] - 6).toFixed(1)}">`
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
		const jg = e.target.closest('.ctc-junction');
		if (jg) {
			const idx = jg.getAttribute('data-junction-id');
			if (idx != null && typeof toggleJunction === 'function')
				toggleJunction(Number(idx));
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

	fetchWhoami();
}

// ctc.js loads after the panel markup, so the elements exist now.
initCollab();
