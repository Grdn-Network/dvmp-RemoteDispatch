/* ============================================================
   ctc-layout.js — builds the schematic SVG for the CTC panel.

   Approach A (algorithmic): project the geographic track/junction/
   signal coordinates already loaded by main.js into a normalized SVG
   coordinate space and draw them. This preserves the real layout
   (curves included) rather than a fully straightened schematic; true
   schematic straightening (Approach B) is a future enhancement.

   Reuses main.js globals (trackPolyLines, junctions, signalMarkers,
   junctionDisplayNames) so the diagram always matches the map and we
   avoid extra round-trips. buildSchematic() runs lazily on first CTC
   activation, well after those globals are populated.
   ============================================================ */

// Logical SVG canvas the schematic is drawn into. updateCTC() positions
// overlays in this same space via ctcProjection, so keep these in sync.
const CTC_VIEW_W = 1600;
const CTC_VIEW_H = 900;
const CTC_PADDING = 40;

// Geographic [lat,lng] -> schematic [x,y]. Set by buildSchematic(), reused by
// updateCTC() to place trains and refresh signal/junction overlays.
let ctcProjection = null;

// Build a projection from a geographic bounding box to the SVG canvas. DV coords
// are small degree values; fit them with padding and flip Y so north is up,
// using a uniform scale to preserve aspect ratio.
function makeCtcProjection(minLat, minLng, maxLat, maxLng) {
	const spanLat = Math.max(maxLat - minLat, 1e-9);
	const spanLng = Math.max(maxLng - minLng, 1e-9);
	const usableW = CTC_VIEW_W - CTC_PADDING * 2;
	const usableH = CTC_VIEW_H - CTC_PADDING * 2;
	const scale = Math.min(usableW / spanLng, usableH / spanLat);
	// Centre the (aspect-preserved) drawing within the canvas.
	const offsetX = (CTC_VIEW_W - spanLng * scale) / 2;
	const offsetY = (CTC_VIEW_H - spanLat * scale) / 2;
	return function project(lat, lng) {
		const x = offsetX + (lng - minLng) * scale;
		const y = offsetY + (maxLat - lat) * scale; // flip Y: higher lat -> top
		return [x, y];
	};
}

// Minimal escaping for values placed inside double-quoted SVG attributes.
function ctcEscapeAttr(v) {
	return String(v)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// Fan the n-th co-located schematic signal onto a small ring (pixel space) so
// even many signals sharing a junction never sit on top of each other.
function fanSchematicSignal(x, y, n) {
	if (n === 0) return [x, y];
	const perRing = 6;
	const k = n - 1;
	const ring = 1 + Math.floor(k / perRing);
	const angle = (k % perRing) * (Math.PI * 2 / perRing) + ring * 0.6;
	const r = 11 * ring;
	return [x + r * Math.cos(angle), y + r * Math.sin(angle)];
}

// Gather geometry from the already-loaded map layers.
function ctcCollectGeometry() {
	const tracks = []; // { id, coords: [[lat,lng],...], siding }
	if (typeof trackPolyLines !== 'undefined') {
		trackPolyLines.forEach((poly, trackId) => {
			const latlngs = poly.getLatLngs();
			if (!latlngs || latlngs.length < 2) return;
			tracks.push({
				id: trackId,
				coords: latlngs.map(ll => [ll.lat, ll.lng]),
				siding: !trackId.includes('#'),
			});
		});
	}

	const juncs = []; // { index, name, lat, lng }
	if (typeof junctions !== 'undefined') {
		junctions.forEach((j, index) => {
			if (!j || !j.marker) return;
			const c = j.marker.getBounds().getCenter();
			const name = (typeof junctionDisplayNames !== 'undefined'
				&& junctionDisplayNames.get(index)) || String(index);
			juncs.push({ index, name, lat: c.lat, lng: c.lng });
		});
	}

	const sigs = []; // { id, lat, lng, direction }
	if (typeof signalMarkers !== 'undefined') {
		signalMarkers.forEach((entry, signalId) => {
			if (!entry || !entry.position) return;
			sigs.push({
				id: signalId,
				lat: entry.position[0],
				lng: entry.position[1],
				direction: entry.direction ?? null,
			});
		});
	}

	return { tracks, juncs, sigs };
}

// Returns an SVG markup string for the schematic, and sets ctcProjection.
async function buildSchematic() {
	const { tracks, juncs, sigs } = ctcCollectGeometry();

	// Bounding box over all geometry.
	let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
	const extend = (lat, lng) => {
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
		if (lng < minLng) minLng = lng;
		if (lng > maxLng) maxLng = lng;
	};
	tracks.forEach(t => t.coords.forEach(([la, ln]) => extend(la, ln)));
	juncs.forEach(j => extend(j.lat, j.lng));

	if (!isFinite(minLat)) {
		return `<text x="${CTC_VIEW_W / 2}" y="${CTC_VIEW_H / 2}" fill="#8892a4" `
			+ `font-family="monospace" font-size="20" text-anchor="middle">`
			+ `No track data available</text>`;
	}

	ctcProjection = makeCtcProjection(minLat, minLng, maxLat, maxLng);

	const parts = [];

	// Track layer.
	parts.push('<g id="ctc-tracks">');
	for (const t of tracks) {
		const pts = t.coords
			.map(([la, ln]) => {
				const [x, y] = ctcProjection(la, ln);
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
		const cls = 'ctc-track' + (t.siding ? ' ctc-track-siding' : '');
		parts.push(`<polyline class="${cls}" data-track-id="${ctcEscapeAttr(t.id)}" points="${pts}" />`);
	}
	parts.push('</g>');

	// Signal layer. Each signal is a group: a transparent hit-circle (big click
	// target), an optional facing-direction tick, and the coloured dot. Co-located
	// signals are fanned apart in pixel space so none hides under another.
	// Colour is applied to the group class by updateSignalIndicators().
	parts.push('<g id="ctc-signals">');
	const sigBaseSeen = []; // projected base points, to detect co-location
	for (const s of sigs) {
		const [bx, by] = ctcProjection(s.lat, s.lng);
		const n = sigBaseSeen.filter(p => Math.hypot(p[0] - bx, p[1] - by) < 8).length;
		sigBaseSeen.push([bx, by]);
		const [x, y] = fanSchematicSignal(bx, by, n);
		const esc = ctcEscapeAttr(s.id);
		let tick = '';
		if (s.direction != null) {
			// North-up, Y-flipped screen vector: (sin θ, −cos θ).
			const th = s.direction * Math.PI / 180;
			const L = 9;
			const x2 = (x + L * Math.sin(th)).toFixed(1);
			const y2 = (y - L * Math.cos(th)).toFixed(1);
			tick = `<line class="ctc-signal-tick" x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2}" y2="${y2}"/>`;
		}
		parts.push(`<g class="ctc-signal unknown" data-signal-id="${esc}">`
			+ `<circle class="ctc-signal-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11"/>`
			+ tick
			+ `<circle class="ctc-signal-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5"/>`
			+ `<title>${esc}</title></g>`);
	}
	parts.push('</g>');

	// Junction layer (data-junction-id is the array index used by toggleJunction).
	parts.push('<g id="ctc-junctions">');
	for (const j of juncs) {
		const [x, y] = ctcProjection(j.lat, j.lng);
		parts.push(`<g class="ctc-junction" data-junction-id="${j.index}">`
			+ `<circle class="ctc-junction-node" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5">`
			+ `<title>${ctcEscapeAttr(j.name)}</title></circle></g>`);
	}
	parts.push('</g>');

	// Train label layer — populated by updateCTC().
	parts.push('<g id="ctc-trains"></g>');

	return parts.join('\n');
}
