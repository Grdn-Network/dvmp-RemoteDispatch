const initialZoom = 20;
const earthCircumference = 40e6;
const metersToDegrees = 360 / earthCircumference;

var loggingEnabled = false;

/////////////////////
// map

const canvasRenderer = L.canvas();
const mapBounds = [[0, 0], [0.15, 0.15]];
const maxBounds = [[-0.02, -0.02], [0.17, 0.17]];
const map = L.map('map', {
	minZoom: 13,
	maxBounds: maxBounds,
	tap: false,
	zoomControl: false,
	wheelPxPerZoomLevel: 40,
})
	.fitBounds(mapBounds);
L.control.scale().addTo(map);
const zoomHome = new L.Control.ZoomHome({
	position: 'topleft',
	zoomInText: '<i class="fas fa-search-plus"></i>',
	zoomHomeText: '<i class="fas fa-user"></i>',
	zoomHomeTitle: 'Zoom to player(s)',
	zoomOutText: '<i class="fas fa-search-minus"></i>',
}).addTo(map);

// Map background — terrain image from the DV Community Map project.
// The DV world is 16384m × 16384m; metersToDegrees converts that to Leaflet coords.
const DV_WORLD_SIZE_DEG = 16384 * metersToDegrees;
const terrainBounds = [[0, 0], [DV_WORLD_SIZE_DEG, DV_WORLD_SIZE_DEG]];
const terrainOverlay = L.imageOverlay(
	'https://pyronicampt.github.io/DV-Community-Map/terrains/dvrt.jpg',
	terrainBounds,
	{ opacity: 0.55, zIndex: -10, className: 'map-terrain' }
).addTo(map);

document.getElementById('mapBackgroundCheckbox')
	.addEventListener('change', e => {
		if (e.target.checked) terrainOverlay.addTo(map);
		else terrainOverlay.remove();
	});

// Custom image overlay — file pick or URL, same world bounds as the terrain image.
let customOverlay = null;
let customOverlayBlobUrl = null;

function applyCustomOverlay() {
	if (customOverlay) { customOverlay.remove(); customOverlay = null; }
	if (!document.getElementById('customOverlayCheckbox').checked) return;
	const src = customOverlayBlobUrl || document.getElementById('customOverlayUrl').value.trim();
	if (!src) return;
	const opacity = document.getElementById('customOverlayOpacity').value / 100;
	customOverlay = L.imageOverlay(src, terrainBounds, { opacity, zIndex: -9 }).addTo(map);
}

document.getElementById('customOverlayCheckbox').addEventListener('change', applyCustomOverlay);
document.getElementById('customOverlayUrl').addEventListener('change', applyCustomOverlay);
document.getElementById('customOverlayOpacity').addEventListener('input', e => {
	if (customOverlay) customOverlay.setOpacity(e.target.value / 100);
});
document.getElementById('customOverlayFile').addEventListener('change', e => {
	if (customOverlayBlobUrl) { URL.revokeObjectURL(customOverlayBlobUrl); customOverlayBlobUrl = null; }
	const file = e.target.files[0];
	if (file) customOverlayBlobUrl = URL.createObjectURL(file);
	applyCustomOverlay();
});

// Signals are hidden when zoomed out past this level to reduce clutter.
// Raise the number to show them at a closer zoom; lower it to show them sooner.
const SIGNAL_MIN_ZOOM = 17;
const signalLayerGroup = L.layerGroup();

function updateSignalLayerVisibility() {
	const zoom = map.getZoom();
	if (zoom >= SIGNAL_MIN_ZOOM) {
		if (!map.hasLayer(signalLayerGroup)) signalLayerGroup.addTo(map);
	} else {
		if (map.hasLayer(signalLayerGroup)) signalLayerGroup.remove();
	}
}

let markerToFollow;
map.addEventListener('mousedown', stopFollowing);
map.on('drag', () => {
	map.fitBounds(map.getBounds());
});
map.on('zoomanim', () => {
	map.fitBounds(map.getBounds());
});

function setMarkerToFollow(marker) {
	markerToFollow = marker;
	map.panTo(marker.getBounds().getCenter());
}

function stopFollowing() {
	markerToFollow = undefined;
}

function zoomToAllPlayers() {
	const bounds = [];
	// Cant get bounds of the tooltip, so just get overlay
	playerMarkers.forEach(marker => { bounds.push(marker.overlay.getBounds()) });
	map.fitBounds(L.latLngBounds(bounds), { maxZoom: initialZoom });
}

map.addEventListener('zoomhome', () => {
	stopFollowing();
	zoomToAllPlayers();
});

/////////////////////
// settings

document.getElementById('themeDropdown')
	.addEventListener('input', e => {
		if (e.target.value === 'dark') {
			document.getElementById('map').classList.add('dark');
		} else {
			document.getElementById('map').classList.remove('dark');
		}
	});

function getCarColorMode() {
	return document.getElementById('carColorDropdown').value;
}

document.getElementById('carColorDropdown')
	.addEventListener('input', () => {
		updateAllCarColors();
		updateJobListColors();
	});

document.getElementById('playerScalingCheckbox')
	.addEventListener('change', e => {
		playerScalingEnabled = e.target.checked;
		// immediately reapply bounds to all player markers
		playerMarkers.forEach(({ overlay, position }) => {
			overlay.setBounds(getPlayerOverlayBounds(position));
		});
	});

document.getElementById('playerNameCheckbox')
	.addEventListener('change', e => {
		playerTooltipEnabled = e.target.checked;
		// immediately toggle tooltip visibility for all player markers
		playerMarkers.forEach(({ playerLabel }) => {
			playerLabel.getElement().style.display = playerTooltipEnabled ? '' : 'none';
		});
	});

/////////////////////
// sidebar

const sidebar = L.control.sidebar({ autopan: true, container: 'sidebar' }).addTo(map);

const tablesort = new Tablesort(document.getElementById('carList'));
const carListBody = document.getElementById('carListBody');
const locoListBody = document.getElementById('locoListBody');

function createCarRow(carId) {
	const row = document.createElement('tr');
	row.setAttribute('id', `carList-${carId}`);
	row.classList.add('interactive');
	carListBody.append(row);
	updateCarRow(carId);
	row.addEventListener('click', _ => followCar(carId, false));
}

function removeCarRow(carId) {
	const row = document.getElementById(`carList-${carId}`);
	if (row)
		row.remove();
}

function updateCarRow(carId) {
	const row = document.getElementById(`carList-${carId}`);
	if (!row)
		return;
	const jobId = carJobIds.has(carId) ? carJobIds.get(carId) : '';
	const destinationYardId = allJobData.has(jobId) ? allJobData.get(jobId).destinationYardId : '';
	row.innerHTML = `<td>${carId}</td><td>${jobId}</td><td>${destinationYardId}</td>`;
	tablesort.refresh();
}

/////////////////////
// jobs

const CarsPerRow = 3;
const allJobData = new Map();
const carJobIds = new Map();
const jobListBody = document.getElementById('jobListBody');

// https://www.npmjs.com/package/string-hash
function stringHash(str) {
	let hash = 5381, i = str.length;
	while (i) {
		hash = (hash * 33) ^ str.charCodeAt(--i);
	}
	return hash >>> 0;
}

// http://vrl.cs.brown.edu/color
const carColors = [
	'#52ef99', '#c95e9f', '#b1e632', '#7574f5', '#799d10', '#fd3fbe', '#2cf52b', '#d130ff', '#21a708', '#fd2b31',
	'#3eeaef', '#ffc4de', '#069668', '#f9793b', '#5884c9', '#e5d75e', '#96ccfe', '#bb8801', '#6a8b7b', '#a8777c',
];

function colorByHashing(str) {
	return carColors[stringHash(str) % carColors.length];
}

function colorForJobDestination(jobId) {
	const jobData = allJobData.get(jobId);
	if (!jobData)
		return 'gray';
	return colorForYardId(jobData.destinationYardId);
}

function colorForJobType(jobId) {
	const segments = jobId.split('-');
	if (segments.length == 2)
		return 'cornflowerblue';
	const jobType = segments[1];
	switch (jobType) {
		case 'FH': return 'lightgreen';
		case 'LH': return 'khaki';
		case 'PC':
		case 'PE': return 'cornflowerblue';
		case 'PR': return 'mediumpurple';
		case 'SL':
		case 'SU': return 'lightcoral';
	}
}

function colorForJobId(jobId) {
	switch (getCarColorMode()) {
		case 'jobId': return colorByHashing(jobId);
		case 'carType':
		case 'jobType': return colorForJobType(jobId);
		case 'destination': return colorForJobDestination(jobId);
	}
}

function yardIdForTrack(trackId) {
	return trackId.split('-')[0];
}

function jobMatchesFilter(jobId, jobData) {
	const testText = document.getElementById('jobSearchText').value.toUpperCase();
	const activeOnly = document.getElementById('jobActiveOnly').checked;
	function taskFields(task) { return [task.startTrack, task.destinationTrack].concat(task.cars); }
	const fields = [jobId].concat(jobData.tasks.flatMap(taskFields));
	return fields.some(field => field.includes(testText)) && (!activeOnly || jobData.isActive);
}

function jobElem(jobId, jobData) {
	function replaceHyphens(s) { return s.replaceAll('-', '\u2011'); }

	const tbody = document.createElement('tbody');
	tbody.setAttribute('id', `jobList-${jobId}`);

	let row = document.createElement('tr');
	const jobIdCell = document.createElement('th');
	jobIdCell.setAttribute('colspan', CarsPerRow);
	jobIdCell.classList.add("jobList-jobHeader");
	jobIdCell.style.background = colorForJobId(jobId);
	jobIdCell.textContent = jobId;

	jobLicensesDiv = document.createElement('div');
	jobLicensesDiv.classList.add('jobList-licenses');
	for (const license of jobData.requiredLicenses) {
		jobLicensesDiv.innerHTML += `<span class="jobList-license"><div class="jobList-licenseBackground"></div><img src="res/licenses.${license}.png" title="${license}"></span>`;
	}
	jobIdCell.appendChild(jobLicensesDiv);

	row.appendChild(jobIdCell);
	tbody.appendChild(row);

	row = document.createElement('tr');
	jobMassCell = document.createElement('th');
	jobMassCell.textContent = `${jobData.mass.toFixed(0)} t`;
	jobLengthCell = document.createElement('th');
	jobLengthCell.textContent = `${jobData.length.toFixed(0)} m`;
	jobPaymentCell = document.createElement('th');
	jobPaymentCell.textContent =
		new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
			.format(jobData.basePayment);
	row.append(jobMassCell, jobLengthCell, jobPaymentCell);
	tbody.appendChild(row);

	jobData.tasks.forEach(task => {
		row = document.createElement('tr');
		const startTrackCell = document.createElement('th');
		startTrackCell.classList.add('interactive');
		startTrackCell.textContent = replaceHyphens(task.startTrack);
		startTrackCell.style.background = colorForYardId(yardIdForTrack(task.startTrack));
		startTrackCell.addEventListener('click', () => scrollToTrack(task.startTrack));
		row.appendChild(startTrackCell);

		const arrowCell = document.createElement('th');
		arrowCell.textContent = "\u279C";
		arrowCell.classList.add('jobList-trackSeparator');
		row.appendChild(arrowCell);

		const destinationTrackCell = document.createElement('th');
		destinationTrackCell.classList.add('interactive');
		destinationTrackCell.textContent = replaceHyphens(task.destinationTrack);
		destinationTrackCell.style.background = colorForYardId(yardIdForTrack(task.destinationTrack));
		destinationTrackCell.addEventListener('click', () => scrollToTrack(task.destinationTrack));
		row.appendChild(destinationTrackCell);

		for (let carIndex = 0; carIndex < task.cars.length; carIndex++) {
			if (carIndex % CarsPerRow == 0) {
				tbody.appendChild(row);
				row = document.createElement('tr');
			}
			const carId = task.cars[carIndex];
			const carCell = document.createElement('td');
			carCell.classList.add(`jobList-carCell-${carId}`);
			carCell.classList.add('interactive');
			carCell.textContent = carId;
			carCell.addEventListener('click', () => followCar(carId, false));
			row.appendChild(carCell);
		}
		if (row.children.length < CarsPerRow)
			// add filler cells
			for (let i = 0; i < CarsPerRow - (task.cars.length % CarsPerRow); i++)
				row.appendChild(document.createElement('td'));
		tbody.appendChild(row);
	});

	return tbody;
}

function updateCarJobs() {
	carJobIds.clear();
	allJobData.forEach((jobData, jobId) => {
		jobData.tasks.forEach(task => {
			task.cars.forEach(carId => {
				carJobIds.set(carId, jobId);
			});
		})
	});
	for ([carId, _] of allCarData) {
		updateCarRow(carId);
		updateCarMarker(carId);
	}
	updateTrainBoard();
}

function updateJobListColors() {
	for (const elem of jobListBody.querySelectorAll('th.jobList-jobHeader')) {
		elem.style.background = colorForJobId(elem.textContent);
	}
}

function updateJobList() {
	for (const elem of Array.from(jobListBody.childNodes))
		elem.remove();
	const sortedJobs = Array.from(allJobData.entries()).sort((a, b) => a[0].localeCompare(b[0]));
	sortedJobs
		.filter(([jobId, jobData]) => jobMatchesFilter(jobId, jobData))
		.forEach(([jobId, jobData]) => jobListBody.appendChild(jobElem(jobId, jobData)));
}

function updateAllJobs(jobs) {
	allJobData.clear();
	Object.entries(jobs).forEach(([jobId, jobData]) => allJobData.set(jobId, jobData));
	updateJobList();
	updateCarJobs();
}

let jobSearchTimeoutId;
function queueJobUpdate() {
	if (jobSearchTimeoutId)
		clearTimeout(jobSearchTimeoutId);
	jobSearchTimeoutId = setTimeout(updateJobList, 100);
}
document.getElementById('jobSearchText').addEventListener('input', e => {
	queueJobUpdate();
});
document.getElementById('jobActiveOnly').addEventListener('change', e => {
	queueJobUpdate();
})

/////////////////////
// track

const trackPolyLines = new Map();

function colorForYardId(yardId) {
	switch (yardId) {
		case 'CME': return '#686868';
		case 'CMS': return '#4e554e';
		case 'CP': return '#583d3d';
		case 'CS': return '#97adc2';
		case 'CW': return '#a7a7a7';
		case 'FF': return '#77a6e3';
		case 'FM': return '#ddaa4d';
		case 'FRC': return '#92b66a';
		case 'FRS': return '#609161';
		case 'GF': return '#c97fa2';
		case 'HB': return '#816c94';
		case 'HMB': return '#816c94';
		case 'IME': return '#b66861';
		case 'IMW': return '#9a5847';
		case 'MB': return '#988c5f';
		case 'MF': return '#dc885b';
		case 'MFMB': return '#dc885b';
		case 'OR': return '#935478';
		case 'OWC': return '#555a62';
		case 'OWN': return '#625d55';
		case 'SM': return '#7b8394';
		case 'SW': return '#cda888';
	}
}

function createTrackLabel(trackId, position, angle) {
	const size = 0.0002;
	const bounds = [[position[0] - size, position[1] - size], [position[0] + size, position[1] + size]];
	const rotation = `rotate(${-angle})`;

	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('id', trackId)
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', '-50 -10 100 20');
	svg.innerHTML = `<text text-anchor="middle" dominant-baseline="central" transform="${rotation}" font-family="Arial" font-weight="bold" fill="steelblue" stroke="black" stroke-width="0.25px">${trackId.slice(trackId.indexOf('-') + 1)}</text>`;
	L.svgOverlay(svg, bounds, { renderer: canvasRenderer })
		.addTo(map)
		.setZIndex(1000);
}

function pointDistance(p1, p2) {
	const d0 = p1[0] - p2[0];
	const d1 = p1[1] - p2[1];
	return Math.sqrt(d0 * d0 + d1 * d1);
}

function pointLerp(p1, p2, a) {
	return [
		(p2[0] - p1[0]) * a + p1[0],
		(p2[1] - p1[1]) * a + p1[1]
	];
}

function createLocation(start, end, mid, a) {
	return [
		(end[0] - start[0]) * a + mid[0],
		(end[1] - start[1]) * a + mid[1]
	];
}

function createTrackLabels(trackId, coords) {
	const length = pointDistance(coords[0], coords[coords.length - 1]);
	const midIndex = Math.floor(coords.length / 2);
	const beforeMid = (midIndex % 2 == 1) ? coords[midIndex] : coords[midIndex - 1];
	const mid = (midIndex % 2 == 1) ? coords[midIndex] : pointLerp(coords[midIndex - 1], coords[midIndex], 0.5);
	const afterMid = (midIndex % 2 == 1) ? coords[midIndex + 1] : coords[midIndex];
	const midGap = pointDistance(beforeMid, afterMid);

	const angle = ((Math.atan2(afterMid[0] - beforeMid[0], afterMid[1] - beforeMid[1]) * 180 / Math.PI) + 270) % 180 - 90;

	if (coords.length > 5) {
		createTrackLabel(trackId, createLocation(beforeMid, afterMid, mid, length / midGap * 0.3), angle);
		createTrackLabel(trackId, createLocation(beforeMid, afterMid, mid, length / midGap * -0.3), angle);
	} else {
		createTrackLabel(trackId, mid, angle);
	}
}

const tracksReady = fetch(new URL('/track', location))
	.then(resp => resp.json())
	.then(tracks => {
		Object.entries(tracks).forEach(([trackId, coords]) => {
			const isSiding = !trackId.includes('#');
			const polyline = L.polyline(coords, {
				color: isSiding ? 'slategray' : 'lightsteelblue',
				interactive: false,
				renderer: canvasRenderer,
			}).addTo(map);
			trackPolyLines.set(trackId, polyline);
			if (isSiding)
				createTrackLabels(trackId, coords)
		});
	});

/////////////////////
// junctions

let junctions = [];
var junctionDisplayNames = new Map();

const junctionsReady = tracksReady
	.then(_ => fetch(new URL('/junction', location)))
	.then(resp => resp.json())
	.then(allJunctionData =>
		junctions = allJunctionData.map((data, index) => ({
			marker: createJunctionMarker(data.position, index, data.id), // id here is the "real" ID of the Junction, the index is just how the frontend handles them internally
			branches: data.branches,
		}))
	);

function toggleJunction(junctionId) {
	return fetch(new URL(`/junction/${junctionId}/toggle`, location), { method: 'POST' })
		.then(r => {
			if (r.status === 403) console.warn('No permission to toggle junction #' + junctionId);
			else if (r.status === 404) console.warn('Junction not found: #' + junctionId);

			return r.json();
		})
		.catch(err => {
			console.error(`Failed to toggle junction #${junctionId}:`, err);
			throw err;
		});
}

const junctionCanvasSize = 60;

function createJunctionShape(selectedBranch) {
	let branchLine = (selectedBranch) => {
		switch (selectedBranch) {
			case 0: return `<line clip-path="url(#box)" x1="${junctionCanvasSize / 2}" y1="${junctionCanvasSize}" x2="${-junctionCanvasSize / 2}" y2="${-junctionCanvasSize}" stroke="white" stroke-width="10"/>`
			case 1: return `<line clip-path="url(#box)" x1="${-junctionCanvasSize / 2}" y1="${junctionCanvasSize}" x2="${junctionCanvasSize / 2}" y2="${-junctionCanvasSize}" stroke="white" stroke-width="10"/>`
		}
		return ''
	}
	return `<g opacity="70%">
		<clipPath id="box"><rect x="${-junctionCanvasSize / 2}" y="${-junctionCanvasSize}" width="${junctionCanvasSize}" height="${junctionCanvasSize * 2}"/></clipPath>
		<rect x="${-junctionCanvasSize / 2}" y="${-junctionCanvasSize}" width="${junctionCanvasSize}" height="${junctionCanvasSize * 2}" fill="red"/>` +
		branchLine(selectedBranch) +
		`<rect x="${-junctionCanvasSize / 2}" y="${-junctionCanvasSize}" width="${junctionCanvasSize}" height="${junctionCanvasSize * 2}" fill="none" stroke="black" stroke-width="2%"/></g>`;
}

function createJunctionLabel(junctionId) {
	let displayName = junctionDisplayNames.get(junctionId) || junctionId;
	return `<rect x="${-junctionCanvasSize / 2}" y="${junctionCanvasSize - 10}" width="${junctionCanvasSize}" height="10" fill="black" opacity="60%"/>
			<text x="${-junctionCanvasSize / 2 + 2}" y="${junctionCanvasSize - 2}" font-size="8" fill="white" font-family="sans-serif">${displayName}</text>`;
}

function createJunctionOverlay(junctionId) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('id', `J-${junctionId}`)
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', `${-junctionCanvasSize / 2} ${-junctionCanvasSize} ${junctionCanvasSize} ${junctionCanvasSize * 2}`);
	svg.innerHTML = createJunctionShape(null) + createJunctionLabel(junctionId);
	return svg;
}

function updateJunctionOverlay(junctionId, selectedBranch) {
	const junction = junctions[junctionId]
	junction.marker.getElement().innerHTML = createJunctionShape(selectedBranch) + createJunctionLabel(junctionId);
	const selectedTrackId = junction.branches[selectedBranch]
	trackPolyLines.get(selectedTrackId).setStyle({ color: 'steelblue', dashArray: null });
	const unselectedTrackPolyLine = trackPolyLines.get(junction.branches[1 - selectedBranch]);
	unselectedTrackPolyLine
		.setStyle({ color: 'lightsteelblue', dashArray: "6 12" })
		.bringToBack();
}

function getJunctionOverlayBounds(position) {
	const size = metersToDegrees * 5;
	return [
		[position[0] - size, position[1] - size / 2],
		[position[0] + size, position[1] + size / 2],
	];
}

function createJunctionMarker(p, junctionId, displayName) {
	junctionDisplayNames.set(junctionId, displayName);
	return L.svgOverlay(
		createJunctionOverlay(junctionId, junctionId),
		getJunctionOverlayBounds(p),
		{ interactive: true, renderer: canvasRenderer })
		.addEventListener('click', () => toggleJunction(junctionId))
		.addTo(map)
		.setZIndex(Math.floor(p[0] * 100000 + p[1] * 100000));
}

function updateAllJunctions(states) {
	states.forEach((state, index) => updateJunctionOverlay(index, state))
}

/////////////////////
// signals

const signalMarkers = new Map();
const signalIconAnchor = [12, 12];
// Threshold for detecting signals at the same junction. Signals within this distance
// get a lateral nudge so each is individually visible and clickable.
// ~0.0002° ≈ 22 m in-game, which maps to roughly 18–20 px at zoom 17 (the signal
// minimum zoom) — enough to separate the 16 px-wide signal icons without them overlapping.
const SIGNAL_STACK_DEG = 0.0002;


function makeSafeSignalId(id) {
	if (!id) return '';
	// Replace characters that have special meaning in CSS:
	// . (class), : (pseudo-class/attribute), [ (attribute selector),
	// # (ID), $ (data attribute), { } (content), ( ) (expression),
	// * (universal), + (adjacent sibling), > (child), space (descendant), % (percent)
	return id.replace(/[\.\:\[\]\#\$%\{\}\(\)\*\+\>\s]+/g, '_');
}

function getSignalIconUrl(aspect, mode, type) {
	if (loggingEnabled)
		console.log(`Getting signal icon for aspect ${aspect} and mode ${mode}, of type ${type}`);
	if (!aspect || aspect === 'OFF') {
		if (type == "Distant") return 'res/signals.distant_off.webp';
		return 'res/signals.off.webp';
	}

	if (type === "Distant") {
		// Distant signals do not have a manual image
		if (loggingEnabled)
			console.log("Signal is of type 'distant'")
		mode = "automatic";
	}
	const imageName = `${aspect.toLowerCase()}_${mode.toLowerCase()}`;

	// Match all known aspects by lowercasing the input
	const imageNames = [
		's1_manual', 's1c_manual', 's2_manual', 's4_manual', 's6_manual',
		's1_automatic', 's1c_automatic', 's2_automatic', 's4_automatic', 's6_automatic',
		'ds1_automatic', 'ds2_automatic', 'ds3_automatic', 'ds4_automatic'
	].map(x => x.toLowerCase());

	if (!imageNames.includes(imageName)) {
		console.log(`No valid image found for a signal with aspect ${aspect} and mode ${mode} of type ${type}. imageName var was ${imageName}`);
		return 'res/signals.all.webp';
	}

	return `res/signals.${imageName}.webp`;
}

const signalIconBaseSize = { normal: [16, 80], distant: [16, 32] };
const signalIconMaxScale = 3; // cap: icons won't grow beyond 3× their base size

function getSignalIconSize(type) {
	const base = type === "Distant" ? signalIconBaseSize.distant : signalIconBaseSize.normal;
	const zoom = map.getZoom();
	const scale = zoom < initialZoom - 4 ? 1 / (2 ** (initialZoom - 4 - zoom)) : 1;
	const minScale = 1 / signalIconMaxScale; // floor so they don't vanish entirely
	const s = Math.max(scale, minScale);
	return [Math.round(base[0] * s), Math.round(base[1] * s)];
}

function getSignalIcon(aspect, mode, type, direction) {
	const url = getSignalIconUrl(aspect, mode, type);
	const iconSize = getSignalIconSize(type);
	const [w, h] = iconSize;

	if (direction != null) {
		// Normalise to 0-360 and render a ▲ arrow rotated to show the approach direction.
		// ▲ points north (0°) by default; CSS rotation is clockwise.
		const deg = ((direction % 360) + 360) % 360;
		return L.divIcon({
			html: `<div style="position:relative;width:${w}px;height:${h}px">` +
			      `<img src="${url}" style="width:${w}px;height:${h}px;display:block">` +
			      `<div style="position:absolute;bottom:3px;left:50%;width:12px;margin-left:-6px;` +
			      `text-align:center;font-size:9px;line-height:1;color:#ffe600;` +
			      `text-shadow:0 0 2px #000,0 0 2px #000;` +
			      `transform:rotate(${deg}deg);transform-origin:center center;` +
			      `pointer-events:none">▲</div>` +
			      `</div>`,
			className: '',
			iconSize: iconSize,
			iconAnchor: signalIconAnchor,
		});
	}

	return L.icon({
		iconUrl: url,
		iconSize: iconSize,
		iconAnchor: signalIconAnchor,
	});
}

function createSignalMarker(signalId, signalData) {
	const aspect = signalData.CurrentAspectId || 'OFF';
	const mode = signalData.Mode || 'Automatic';
	const signalType = signalData.Type;
	const basePosition = signalData.Position;
	// Direction (Y-rotation degrees) from DVSignals; null when not available.
	const direction = signalData.Direction ?? null;

	// Count signals already placed at essentially the same spot (opposite-facing junction
	// signals share a coordinate). Nudge each additional one slightly north so they are
	// individually visible and clickable at dispatch zoom levels.
	let stackIndex = 0;
	signalMarkers.forEach(entry => {
		if (!entry.position) return;
		if (Math.abs(basePosition[0] - entry.position[0]) < SIGNAL_STACK_DEG &&
			Math.abs(basePosition[1] - entry.position[1]) < SIGNAL_STACK_DEG)
			stackIndex++;
	});
	const position = stackIndex === 0
		? basePosition
		: [basePosition[0] + stackIndex * SIGNAL_STACK_DEG, basePosition[1]];

	const marker = L.marker(position, {
		icon: getSignalIcon(aspect, mode, signalType, direction),
		interactive: true,
		title: signalId,
		zIndexOffset: Math.floor(position[0] * 100000 + position[1] * 100000),
	})
		.bindPopup(() => buildSignalPopup(signalId, signalType), { maxWidth: 260 })
		.addTo(signalLayerGroup);

	// Store basePosition (not the nudged position) so future stack detection
	// compares against real coordinates, not accumulated offsets.
	signalMarkers.set(signalId, { marker, aspect, mode, type: signalType, position: basePosition, direction });
}

function buildSignalPopup(signalId, signalType) {
	if (loggingEnabled) {
		console.log("buildSignalPopup called");
		console.log(`Signal ID   : ${signalId}`);
		console.log(`Signal type : ${signalType}`);
	}

	const state = signalMarkers.get(signalId);
	if (!state)
		return '';

	if (signalType == "Distant") {
		const el = document.createElement('strong');
		el.style.fontSize = '1.1em';
		el.textContent = signalId;
		return el;
	}

	// If mode is not known, assume manual
	const isManual = state.mode === 'Manual';
	// Get valid aspects
	var validTypeAspects = [
		{ "aspect": "S2", "name": "Clear" },
		{ "aspect": "S4", "name": "Expect Caution" },
		{ "aspect": "S6", "name": "Caution" },
		{ "aspect": "S1", "name": "Stop" },
		{ "aspect": "S1c", "name": "Stop, train crossing" }
	]

	const container = document.createElement('div');
	container.style.cssText = 'min-width:200px;font-family:sans-serif';
	container.innerHTML = `
		<strong style="font-size:1.1em">${signalId}</strong>
			<div style="margin:6px 0">
				Mode: <strong id="sig-mode-label-${makeSafeSignalId(signalId)}">${state.mode}</strong>
			</div>
			<label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer">
				<input type="checkbox" id="sig-manual-${makeSafeSignalId(signalId)}" ${isManual ? 'checked' : ''}>
				Manual control
			</label>
			<div id="sig-aspect-row-${makeSafeSignalId(signalId)}" style="display:${isManual ? 'block' : 'none'}">
				<div style="margin-bottom:4px">Set aspect:</div>
				<select id="sig-aspect-select-${makeSafeSignalId(signalId)}" style="width:100%;margin-bottom:8px;max-height:120px;overflow-y:auto">
					${validTypeAspects.map(a =>
		`<option value="${a.aspect}" ${a.aspect === state.aspect ? 'selected' : ''}>${a.name}</option>`
	).join('')}
				</select>
				<button id="sig-apply-${makeSafeSignalId(signalId)}"
					style="width:100%;padding:4px;background:#2a6;color:#fff;border:none;border-radius:3px;cursor:pointer">
					Apply aspect
				</button>
			</div>
			<div id="sig-status-${makeSafeSignalId(signalId)}" style="margin-top:6px;font-size:0.85em;color:gray"></div>
		`;

	const manualCheckbox = container.querySelector(`#sig-manual-${makeSafeSignalId(signalId)}`);
	if (manualCheckbox) {
		manualCheckbox.addEventListener('change', e => {
			const newMode = e.target.checked ? 'Manual' : 'Automatic';
			if (newMode === state.mode) return; // already in this mode, skip
			postSignalControl(signalId, { mode: newMode })
				.then(ok => {
					if (ok) {
						const entry = signalMarkers.get(signalId);
						if (entry) {
							entry.mode = newMode;
							entry.marker.setIcon(getSignalIcon(entry.aspect, entry.mode, signalType));
						}
						const modeLabel = container.querySelector(`#sig-mode-label-${makeSafeSignalId(signalId)}`);
						if (modeLabel) modeLabel.textContent = newMode;
						const aspectRow = container.querySelector(`#sig-aspect-row-${makeSafeSignalId(signalId)}`);
						if (aspectRow) aspectRow.style.display = e.target.checked ? 'block' : 'none';
						setSignalStatus(signalId, container, `Mode set to ${newMode}.`);
					} else {
						setSignalStatus(signalId, container, 'Failed to set mode.', true);
						e.target.checked = !e.target.checked; // revert on failure
					}
				});
		});
	}

	const applyButton = container.querySelector(`#sig-apply-${makeSafeSignalId(signalId)}`);
	if (applyButton) {
		applyButton.addEventListener('click', () => {
			const aspectSelect = container.querySelector(`#sig-aspect-select-${makeSafeSignalId(signalId)}`);
			if (!aspectSelect) return;
			const aspect = aspectSelect.value;
			postSignalControl(signalId, { aspect })
				.then(ok => {
					setSignalStatus(signalId, container,
						ok ? `Aspect set to ${aspect}.` : 'Failed to set aspect.', !ok);
					if (ok) {
						const entry = signalMarkers.get(signalId);
						if (entry) {
							entry.aspect = aspect;
							entry.marker.setIcon(getSignalIcon(entry.aspect, entry.mode, signalType));
						}
					}
				});
		});
	}

	return container;
}

function setSignalStatus(signalId, container, msg, isError = false) {
	const statusEl = container.querySelector(`#sig-status-${makeSafeSignalId(signalId)}`);
	if (statusEl) {
		statusEl.textContent = msg;
		statusEl.style.color = isError ? '#c44' : 'gray';
	}
}

function postSignalControl(signalId, params) {
	return fetch(new URL(`/signal/control`, location), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ signalId, ...params })
	})
		.then(r => {
			if (r.ok || r.status === 204) return true;

			if (r.status === 403) console.warn('No permission to control signal #' + signalId);
			else if (r.status === 404) console.warn('Signal not found: #' + signalId);
			else if (r.status === 400) console.warn('Bad request when controlling signal ' + signalId);
			else if (r.status === 401) console.warn('Unauthorized to control signal ' + signalId);
			else if (r.status >= 500) console.warn('Server error (' + r.status + ') when controlling signal ' + signalId);

			return false;
		})
		.catch(err => {
			console.error(`Failed to control signal #${signalId}:`, err);
			return false;
		});
}

function updateAllSignals(signalsData) {
	Object.entries(signalsData).forEach(([signalId, signalData]) => {
		if (loggingEnabled)
			console.log(`Updating signal ${signalId} with aspect ${signalData.CurrentAspectId} and mode ${signalData.Mode}`);
		const existing = signalMarkers.get(signalId);
		if (!existing)
			return;

		const aspect = signalData.CurrentAspectId || 'OFF';
		const mode = signalData.Mode ?? existing.mode;

		const aspectChanged = existing.aspect !== aspect;
		const modeChanged = existing.mode !== mode;

		// Update state first so setIcon uses the correct aspect+mode combination
		if (aspectChanged) existing.aspect = aspect;
		if (modeChanged) existing.mode = mode;

		// Regenerate icon whenever aspect OR mode changes (both affect the icon URL)
		if (aspectChanged || modeChanged) {
			existing.marker.setIcon(getSignalIcon(existing.aspect, existing.mode, signalData.Type, existing.direction));
		}

		// If the popup is currently open, patch the DOM directly so it stays live
		if ((aspectChanged || modeChanged) && existing.marker.isPopupOpen()) {
			const modeLabel = document.getElementById(`sig-mode-label-${makeSafeSignalId(signalId)}`);
			const manualCb = document.getElementById(`sig-manual-${makeSafeSignalId(signalId)}`);
			const aspectSel = document.getElementById(`sig-aspect-select-${makeSafeSignalId(signalId)}`);
			const aspectRow = document.getElementById(`sig-aspect-row-${makeSafeSignalId(signalId)}`);

			if (modeLabel) modeLabel.textContent = mode;
			if (manualCb) manualCb.checked = mode === 'Manual';
			if (aspectRow) aspectRow.style.display = mode === 'Manual' ? 'block' : 'none';
			if (aspectSel) aspectSel.value = aspect;
		}
	});
}

/////////////////////
// following

function followCar(carId, shouldScroll) {
	setMarkerToFollow(carMarkers.get(carId));

	for (const row of carListBody.querySelectorAll('.following'))
		row.classList.remove('following');
	const carListRow = document.getElementById(`carList-${carId}`)
	carListRow.classList.add('following');
	if (shouldScroll)
		carListRow.scrollIntoView({ block: 'center' });

	for (const elem of jobListBody.querySelectorAll('.following'))
		elem.classList.remove('following');
	const jobListElems = jobListBody.querySelectorAll(`.jobList-carCell-${carId}`);
	for (const elem of jobListElems) {
		elem.classList.add('following');
		elem.closest('tbody').classList.add('following');
	}
	if (shouldScroll && jobListElems.length > 0)
		jobListElems[0].scrollIntoView({ block: 'center' });
}

/////////////////////
// player

const playerMarkers = new Map();
let playerScalingEnabled = true;

// Loco proximity: track which loco (by number) each player is closest to.
// Used to prefix display names with e.g. "[032] Guardian".
const playerLocoLabels = new Map();   // playerId → locoNum string, or null
const LOCO_PROXIMITY_METERS = 15;
const LOCO_PROXIMITY_DEG = LOCO_PROXIMITY_METERS * metersToDegrees;

function getPlayerDisplayName(playerId) {
	const locoNum = playerLocoLabels.get(playerId);
	return locoNum ? `[${locoNum}] ${playerId}` : playerId;
}

function updatePlayerLocoAssignments() {
	playerMarkers.forEach((marker, playerId) => {
		const pos = marker.position;
		if (!pos) return;

		let closestLocoNum = null;
		let closestDist = LOCO_PROXIMITY_DEG;

		for (const [carId, data] of allCarData) {
			if (!data.canBeControlled || !data.position) continue;
			const dLat = pos[0] - data.position[0];
			const dLon = pos[1] - data.position[1];
			const dist = Math.sqrt(dLat * dLat + dLon * dLon);
			if (dist < closestDist) {
				closestDist = dist;
				const m = carId.match(/(\d+)$/);   // "L-032" → "032"
				closestLocoNum = m ? m[1] : carId;
			}
		}

		const prev = playerLocoLabels.get(playerId);
		playerLocoLabels.set(playerId, closestLocoNum);

		if (prev !== closestLocoNum) {
			console.debug(`[RD] ${playerId} loco: ${prev ?? 'none'} → ${closestLocoNum ?? 'none'}`);
			const el = marker.playerLabel.getElement();
			if (el) {
				const div = el.querySelector('div');
				if (div) div.textContent = getPlayerDisplayName(playerId);
			}
		}
	});
}

function getPlayerOverlayBounds(position) {
	const playerScaleFactor = playerScalingEnabled ? scaleMarkerFactor : 1;
	const size = metersToDegrees * 2 * playerScaleFactor;
	return [[position[0] - size, position[1] - size], [position[0] + size, position[1] + size]];
}

function updatePlayerOverlays(data) {
	const existingPlayerIds = Array.from(playerMarkers.keys());
	// Remove markers from disconnected players
	existingPlayerIds
		.filter(id => !data.hasOwnProperty(id))
		.forEach(id => {
			removePlayerOverlay(id);
		});
	// Add markers for new players
	Object.entries(data)
		.filter(([id]) => !existingPlayerIds.includes(id))
		.forEach(([id, playerData]) => {
			createPlayerMarker(id, playerData);
		});
	Object.entries(data).forEach(([id, playerData]) => {
		const polygonElem = document.getElementById(`playerPolygon-${id}`);
		polygonElem.setAttribute('transform', `rotate(${playerData.rotation})`);
		const marker = playerMarkers.get(id);
		marker.position = playerData.position;
		marker.overlay.setBounds(getPlayerOverlayBounds(playerData.position));
		marker.playerLabel.setLatLng(playerData.position);
	});
	updatePlayerLocoAssignments();
}

function removePlayerOverlay(id) {
	document.getElementById(`playerPolygon-${id}`)?.remove();
	const marker = playerMarkers.get(id);
	if (marker) {
		// cleanup
		marker.overlay.remove();
		marker.playerLabel.remove();
	}
	playerMarkers.delete(id);
	playerLocoLabels.delete(id);
}

function createPlayerOverlay(id, playerData) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '-15 -15 30 30');
	const polygon = document.createElementNS(svg.namespaceURI, 'polygon');
	polygon.setAttribute('id', `playerPolygon-${id}`);
	polygon.setAttribute('fill', playerData.color);
	polygon.setAttribute('fill-opacity', '70%');
	polygon.setAttribute('stroke', 'black');
	polygon.setAttribute('stroke-width', '1%');
	polygon.setAttribute('points', '0,-10 10,10 0,5 -10,10');
	svg.appendChild(polygon);
	return svg;
}

function createPlayerMarker(id, playerData) {
	const overlay = L.svgOverlay(
		createPlayerOverlay(id, playerData),
		getPlayerOverlayBounds(playerData.position),
		{ interactive: true, bubblingMouseEvents: false }
	)
		.addEventListener('click', e => setMarkerToFollow(e.target))
		.addTo(map);

	// If a tooltip is used, it cannot be bound properly to the overlay as the overlay doesnt have a latlng, so create a separate marker just for the tooltip
	const playerLabel = L.marker(playerData.position, {
		icon: L.divIcon({
			html: `<div style="background: rgba(0,0,0,0.7); color: white; padding: 2px 6px; border-radius: 3px; font-weight: bold; white-space: nowrap; opacity: 0.7;">${getPlayerDisplayName(id)}</div>`,
			iconSize: null, // let size scale with content
			iconAnchor: [0, -20]
		})
	})
		.addEventListener('click', () => setMarkerToFollow(overlay))
		.addTo(map);

	playerMarkers.set(id, { overlay, playerLabel, position: playerData.position });
}

function scrollToTrack(trackId) {
	stopFollowing();
	const polyLine = trackPolyLines.get(trackId);
	if (polyLine)
		map.panTo(polyLine.getCenter());
}

fetch(new URL('/player', location))
	.then(resp => resp.json())
	.then(data => {
		updatePlayerOverlays(data);
		zoomToAllPlayers();
	}
	);

/////////////////////
// loco control

const locoIdSelect = document.getElementById('locoControlLocoId');
function updateLocoList() {
	for (const elem of Array.from(locoIdSelect.children))
		elem.remove();
	const locoIds = Array.from(allCarData.entries())
		.filter(([_, carData]) => carData.canBeControlled)
		.map(([id, _]) => id.slice(2));
	locoIds.sort();
	for (const id of locoIds) {
		const option = document.createElement('option');
		option.textContent = id;
		locoIdSelect.appendChild(option);
	}
}

function isReverserButtonActive(faButton) {
	return faButton.querySelector('svg').getAttribute('data-prefix') == 'fas';
}

function updateReverserButtons(reverser) {
	const reverseButton = document.querySelector('#locoControlReverserReverseButton svg');
	const newReverseStyle = reverser < 0.5 ? 'fas' : 'far';
	if (reverseButton.getAttribute('data-prefix') != newReverseStyle)
		reverseButton.setAttribute('data-prefix', newReverseStyle);

	const forwardButton = document.querySelector('#locoControlReverserForwardButton svg');
	const newForwardStyle = reverser > 0.5 ? 'fas' : 'far';
	if (forwardButton.getAttribute('data-prefix') != newForwardStyle)
		forwardButton.setAttribute('data-prefix', newForwardStyle);
}

const locoBrakePipeDisplay = document.getElementById('locoControlBrakePipe');
const locoSpeedDisplay = document.getElementById('locoControlForwardSpeed');
const locoTrainBrakeInput = document.getElementById('locoControlTrainBrakeInput');
const locoIndependentBrakeInput = document.getElementById('locoControlIndependentBrakeInput');
const locoReverserReverseButton = document.getElementById('locoControlReverserReverseButton');
const locoReverserForwardButton = document.getElementById('locoControlReverserForwardButton');
const locoThrottleInput = document.getElementById('locoControlThrottleInput');
const locoControlCoupleButton = document.getElementById('locoControlCoupleButton');
const locoControlUncoupleButton = document.getElementById('locoControlUncoupleButton');
const locoControlUncoupleSelect = document.getElementById('locoControlUncoupleSelect');

function updateCouplingControls(carData) {
	const canCouple = carData.canCouple;
	const carsInFront = carData.carsInFront;
	const carsInRear = carData.carsInRear;

	locoControlCoupleButton.disabled = !canCouple;
	locoControlUncoupleButton.disabled = carsInFront === 0 && carsInRear === 0;

	if (locoControlUncoupleSelect.childElementCount == carsInFront + carsInRear) {
		return;
	}

	const options = [];
	for (let i = carsInFront; i >= 1; i--)
		options.push(i);
	for (let i = 1; i <= carsInRear; i++)
		options.push(-i);
	locoControlUncoupleSelect.replaceChildren(...options.map(i => {
		const option = document.createElement('option');
		option.setAttribute('value', i);
		option.textContent = i >= 0 ? `\u002b${i}` : `\u2212${-i}`;
		return option;
	}));
}

function getControlledLocoGuid() {
	return allCarData.get(`L-${locoIdSelect.value}`)?.guid;
}

function getControlledLocoData() {
	const guid = getControlledLocoGuid();
	if (guid) {
		return fetch(`/car/${guid}`, location)
			.then(resp => resp.json());
	}
}

let locoTrainBrakeEditing = false;
let locoIndependentBrakeEditing = false;
let locoThrottleEditing = false;

function updateLocoTrainBrakeInput(carData) {
	if (locoTrainBrakeEditing)
		return;
	locoTrainBrakeInput.value = carData.trainBrake * 100;
}

function updateLocoIndependentBrakeInput(carData) {
	if (locoIndependentBrakeEditing)
		return;
	locoIndependentBrakeInput.value = carData.independentBrake * 100;
}

function updateLocoThrottleInput(carData) {
	if (locoThrottleEditing)
		return;
	locoThrottleInput.value = carData.throttle * 100;
}

function updateLocoDisplay() {
	getControlledLocoData()
		.then(carData => {
			locoBrakePipeDisplay.textContent = carData.brakePipe.toFixed(1);
			locoSpeedDisplay.textContent = carData.forwardSpeed.toFixed(0);
			updateLocoTrainBrakeInput(carData);
			updateLocoIndependentBrakeInput(carData);
			updateReverserButtons(carData.reverser);
			updateLocoThrottleInput(carData);
			updateCouplingControls(carData);
		});
}

let locoControlRefreshIntervalId;
locoIdSelect.addEventListener('change', updateLocoDisplay);
sidebar.on("content", e => {
	clearInterval(locoControlRefreshIntervalId);
	if (e.id == "locoControlTab") {
		locoControlRefreshIntervalId = setInterval(updateLocoDisplay, 1000 / 9);
	}
});
sidebar.on("closing", e => {
	clearInterval(locoControlRefreshIntervalId);
	locoControlRefreshIntervalId = undefined;
})

function sendLocoCommand(command) {
	const guid = getControlledLocoGuid();
	if (guid) {
		fetch(new URL(`/car/${guid}/control?${command}`, location), { method: 'POST' });
	}
}

function rangeCommandSender(parameter) {
	return e => sendLocoCommand(`${parameter}=${e.target.value / 100}`);
}

locoTrainBrakeInput.addEventListener('input', rangeCommandSender('trainBrake'));
locoIndependentBrakeInput.addEventListener('input', rangeCommandSender('independentBrake'));
locoReverserReverseButton.addEventListener('click', e =>
	sendLocoCommand(`reverser=${isReverserButtonActive(locoReverserReverseButton) ? 0.5 : 0}`));
locoReverserForwardButton.addEventListener('click', e =>
	sendLocoCommand(`reverser=${isReverserButtonActive(locoReverserForwardButton) ? 0.5 : 1}`));
locoThrottleInput.addEventListener('input', rangeCommandSender('throttle'));
locoControlCoupleButton.addEventListener('click', e =>
	sendLocoCommand('couple=0'));
locoControlUncoupleButton.addEventListener('click', e =>
	sendLocoCommand(`uncouple=${locoControlUncoupleSelect.value}`));

locoTrainBrakeInput.addEventListener("mousedown", () => locoTrainBrakeEditing = true);
locoTrainBrakeInput.addEventListener("mouseup", () => {
	locoTrainBrakeEditing = false;
	updateLocoDisplay();
});
locoIndependentBrakeInput.addEventListener("mousedown", () => locoIndependentBrakeEditing = true);
locoIndependentBrakeInput.addEventListener("mouseup", () => {
	locoIndependentBrakeEditing = false;
	updateLocoDisplay();
});
locoThrottleInput.addEventListener("mousedown", () => locoThrottleEditing = true);
locoThrottleInput.addEventListener("mouseup", () => {
	locoThrottleEditing = false;
	updateLocoDisplay();
});


/////////////////////
// cars

const carWidthMeters = 3;
const carWidthPx = 20;
const svgPixelsPerMeter = carWidthPx / 3;

const allCarData = new Map();
const carMarkers = new Map();
// selected locos for zoom-based scaling
const selectedLocos = new Set();

function getCarColor(carId) {
	const jobId = carJobIds.get(carId);

	switch (getCarColorMode()) {
		case 'jobId':
			return jobId ? colorByHashing(jobId) : 'gray';
		case 'jobType':
			return jobId ? colorForJobType(jobId) : 'gray';
		case 'destination':
			return jobId ? colorForJobDestination(jobId) : 'gray';
		case 'carType':
			return colorByHashing(carId.slice(0, 3));
	}
}

function updateCarColor(carId) {
	const carMarker = carMarkers.get(carId);
	const rect = carMarker.getElement().querySelector('rect');
	if (rect)
		rect.setAttribute('fill', getCarColor(carId));
}

function updateAllCarColors() {
	carMarkers.forEach((_, carId) => updateCarColor(carId));
}

const locoShapeNoseDepth = 10;

function createCarShape(carId, carData) {
	const isLoco = carId.slice(0, 2) == 'L-';
	const lengthPx = carData.length * svgPixelsPerMeter;
	const highlighted = isLoco && selectedLocos.has(carId);
	const locoStroke = highlighted ? 'white' : 'black';
	const locoStrokeW = highlighted ? '3%' : '1%';
	const svg = isLoco
		? `<polygon points="${-lengthPx / 2},-${carWidthPx / 2} ${-lengthPx / 2},${carWidthPx / 2} ${lengthPx / 2 - locoShapeNoseDepth},${carWidthPx / 2} ${lengthPx / 2},0 ${lengthPx / 2 - locoShapeNoseDepth},-${carWidthPx / 2}" fill="goldenrod" fill-opacity="70%" stroke="${locoStroke}" stroke-width="${locoStrokeW}"/>`
		: `<rect x="${-lengthPx / 2}" y="-10" width="${lengthPx}" height="20" fill-opacity="70%" stroke="black" stroke-width="1%"/>`;
	return svg;
}

function createCarLabel(carId, carData) {
	const isLoco = carId.slice(0, 2) == 'L-';
	const jobId = carJobIds.get(carId);
	const lengthPx = carData.length * svgPixelsPerMeter;
	const rotation = carData.rotation >= 180 ? 'rotate(180)' : '';
	if (isLoco)
		return `<text transform="translate(-3 0) ${rotation}" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="bold">${carId}</text>`;
	const jobIdLabel =
		!jobId ? ""
			: jobId.split('-').length == 3 ? jobId.slice(-5, -3) + jobId.slice(-2)
				: jobId.split('-').join('');
	const jobIdText = `<text x="${-lengthPx / 2 + 5}" transform="${rotation}" dominant-baseline="central" font-size="16">${jobIdLabel}</text>`
	const carIdText =
		`<text y="-0.5em" y="1" transform="${rotation} translate(${lengthPx / 2 - 5})" dominant-baseline="central" text-anchor="end" font-size="8" font-family="monospace" font-weight="bold">` +
		`<tspan x="0">${carId.slice(0, -3).replaceAll('-', '')}</tspan>` +
		`<tspan x="0" dy="1em">${carId.slice(-3)}</tspan>` +
		'</text>';
	return jobIdText + carIdText;
}

function createCarOverlay(carId, carData) {
	const lengthPx = carData.length * svgPixelsPerMeter;
	const carCanvasMajor = Math.sqrt(lengthPx / 2 * lengthPx / 2 + carWidthPx / 2 * carWidthPx / 2);
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('id', carId);
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', `${-carCanvasMajor} ${-carWidthPx / 2} ${carCanvasMajor * 2} ${carWidthPx}`);
	return svg
}

function updateCarMarker(carId) {
	const marker = carMarkers.get(carId);
	if (!marker)
		return;
	const carData = allCarData.get(carId);
	marker.setBounds(getCarOverlayBounds(carId, carData));
	marker.setRotationAngle(carData.rotation - 90);
	marker.getElement().innerHTML = createCarShape(carId, carData) + createCarLabel(carId, carData);
	updateCarColor(carId);
}

function getCarOverlayBounds(carId, carData) {
	const position = carData.position;
	// Selected/highlighted locos scale up so they're easy to spot, but cap at 3×
	// so they don't balloon to absurd sizes when zoomed all the way out.
	const factor = selectedLocos.has(carId) ? Math.min(scaleMarkerFactor, 3) : 1;
	const length = metersToDegrees * carData.length * factor;
	const width = metersToDegrees * carWidthMeters * factor;
	return [[position[0] - width / 2, position[1] - length / 2], [position[0] + width / 2, position[1] + length / 2]];
}

function createNewCar(carId, carData) {
	allCarData.set(carId, carData);
	createCarRow(carId);
	const overlay = L.svgOverlay(
		createCarOverlay(carId, carData),
		getCarOverlayBounds(carId, carData),
		{ interactive: true, bubblingMouseEvents: false })
		.addEventListener('mouseup', e => followCar(carId, true))
		.addTo(map);
	carMarkers.set(carId, overlay);
	updateCarMarker(carId);
}

function updateCar(carId, carData) {
	allCarData.set(carId, carData);
	updateCarRow(carId);
	updateCarMarker(carId);
}

function removeCar(carId) {
	removeCarRow(carId);
	const marker = carMarkers.get(carId);
	if (marker) {
		marker.remove();
		carMarkers.delete(carId);
	}
	allCarData.delete(carId);
}

function updateAllCars(updateCarData) {
	Object.entries(updateCarData).forEach(([carId, carData]) => {
		if (!carMarkers.has(carId))
			createNewCar(carId, carData);
		else
			updateCar(carId, carData);
	});
	for ([carId, _] of carMarkers)
		if (!updateCarData[carId])
			removeCar(carId);
	updateLocoList();
	updateLocoListSidebar();
	updateTrainBoard();
	// Remove any selected locos that are no longer present
	for (const id of Array.from(selectedLocos))
		if (!allCarData.has(id))
			selectedLocos.delete(id);
	updatePlayerLocoAssignments();
}

function updateCars(cars) {
	Object.entries(cars).forEach(([carId, carData]) =>
		updateCar(carId, carData));
	updatePlayerLocoAssignments();
	updateTrainBoard();
}

/////////////////////
// locos

let scaleMarkerFactor = 1;
map.on('zoomend', function () {
	updatescaleMarkerFactor();
});

function updatescaleMarkerFactor() {
	const zoom = map.getZoom();
	// Note, after _much fiddling_ with different formulas, (including bitwise operators)
	// Simple 2 to the power of "zoom difference" seemed the best
	scaleMarkerFactor = zoom > initialZoom ? 1 : (2 ** (initialZoom - zoom));
	if (loggingEnabled)
		console.info('Map Zoom:', zoom, 'Scale Factor:', scaleMarkerFactor);

	// update bounds only for selected locos to minimize work and avoid changing non-selected markers
	Array.from(selectedLocos).forEach(id => {
		const marker = carMarkers.get(id);
		const carData = allCarData.get(id);
		if (marker && carData)
			marker.setBounds(getCarOverlayBounds(id, carData));
	});

	if (playerScalingEnabled) {
		playerMarkers.forEach(({ overlay, position }) => {
			overlay.setBounds(getPlayerOverlayBounds(position));
		});
	}

	// Show/hide signal layer based on zoom, then refresh icon sizes for visible ones
	updateSignalLayerVisibility();
	signalMarkers.forEach(({ marker, aspect, mode, type, direction }) => {
		marker.setIcon(getSignalIcon(aspect, mode, type, direction));
	});
}

// Update the loco selection sidebar. Shows ordered list of L- IDs with checkboxes.
function updateTrainBoard() {
	const body = document.getElementById('trainBoardBody');
	if (!body) return;

	// Reverse map: locoNum string → playerId (e.g. "032" → "Guardian")
	const locoNumToPlayer = new Map();
	playerLocoLabels.forEach((locoNum, playerId) => {
		if (locoNum) locoNumToPlayer.set(locoNum, playerId);
	});

	const locos = [...allCarData.entries()]
		.filter(([_, d]) => d.canBeControlled)
		.sort(([a], [b]) => a.localeCompare(b));

	const frag = document.createDocumentFragment();
	for (const [carId, data] of locos) {
		// L-DE2-014 → type "DE2", num "014"
		const parts = carId.split('-');
		const locoNum = parts[parts.length - 1];
		const locoType = parts.length >= 3 ? parts.slice(1, -1).join('-') : '?';

		const crew = locoNumToPlayer.get(locoNum) || '-';
		// jobId and destinationYardId come directly from the car's JSON payload;
		// the C# side walks the trainset to find the job when the loco has no direct one.
		const jobLabel = data.jobId || '-';
		const dest = data.destinationYardId || '-';
		const cars = (data.carsInFront ?? 0) + (data.carsInRear ?? 0);
		const speed = data.forwardSpeed != null ? Math.round(data.forwardSpeed) : 0;

		const row = document.createElement('tr');
		row.innerHTML =
			`<td>${locoNum}</td><td>${crew}</td><td>${locoType}</td>` +
			`<td>${cars}</td><td>${jobLabel}</td><td>${dest}</td><td>${speed}</td>`;
		frag.appendChild(row);
	}
	body.replaceChildren(frag);
}

function updateLocoListSidebar() {
	if (!locoListBody)
		return;
	// clear existing
	locoListBody.replaceChildren();

	const locoIds = Array.from(allCarData.keys())
		.filter(id => id.slice(0, 2) == 'L-')
		.sort((a, b) => a.localeCompare(b));
	// build rows using simple HTML to keep logic concise
	const frag = document.createDocumentFragment();
	for (const locoId of locoIds) {
		const row = document.createElement('tr');
		const idCell = document.createElement('td');
		idCell.textContent = locoId;
		const selectCell = document.createElement('td');
		selectCell.innerHTML = `<input type="checkbox" data-loco-id="${locoId}" ${selectedLocos.has(locoId) ? 'checked' : ''}>`;
		row.appendChild(idCell);
		row.appendChild(selectCell);
		frag.appendChild(row);
	}
	locoListBody.appendChild(frag);

	// use event delegation for checkbox changes (single listener)
	if (!locoListBody._hasDelegatedLocoListener) {
		locoListBody.addEventListener('change', e => {
			const target = e.target;
			if (target && target.matches('input[type=checkbox][data-loco-id]')) {
				const locoId = target.getAttribute('data-loco-id');
				if (target.checked) selectedLocos.add(locoId); else selectedLocos.delete(locoId);
				if (loggingEnabled) console.info('Loco highlight:', locoId, target.checked);
				updateCarMarker(locoId);
			}
		});
		locoListBody._hasDelegatedLocoListener = true;
	}
}

/////////////////////
// junction + signal + loco search

function searchAll(query) {
	const q = query.toLowerCase();
	const results = [];

	// Junctions — search by displayName
	for (const [junctionId, name] of junctionDisplayNames) {
		if (name.toLowerCase().includes(q))
			results.push({
				label: `[J] ${name}`,
				go() {
					stopFollowing();
					const center = junctions[junctionId].marker.getBounds().getCenter();
					map.setView(center, initialZoom);
				}
			});
	}

	// Signals — search by signal ID
	for (const [signalId] of signalMarkers) {
		if (signalId.toLowerCase().includes(q))
			results.push({
				label: `[S] ${signalId}`,
				go() {
					stopFollowing();
					map.setView(signalMarkers.get(signalId).marker.getLatLng(), initialZoom);
				}
			});
	}

	// Locos — search by loco ID (L- prefix)
	for (const [carId, carData] of allCarData) {
		if (carId.startsWith('L-') && carId.toLowerCase().includes(q))
			results.push({
				label: `[L] ${carId}`,
				go() {
					followCar(carId, false);
				}
			});
	}

	return results.sort((a, b) => a.label.localeCompare(b.label)).slice(0, 15);
}

const input = document.getElementById('searchInput');
const resultsList = document.getElementById('searchResults');

function buildSuggestions(query) {
	resultsList.innerHTML = '';
	if (!query) return;

	for (const result of searchAll(query)) {
		const li = document.createElement('li');
		li.textContent = result.label;
		li.addEventListener('mousedown', e => {
			e.preventDefault();
			input.value = result.label;
			resultsList.innerHTML = '';
			result.go();
		});
		resultsList.appendChild(li);
	}
}

input.addEventListener('input', () => buildSuggestions(input.value));

input.addEventListener('keydown', e => {
	if (e.key === 'Enter') {
		const first = searchAll(input.value)[0];
		if (first) { first.go(); resultsList.innerHTML = ''; input.blur(); }
	}
	if (e.key === 'Escape') {
		resultsList.innerHTML = '';
		input.blur();
	}
});

input.addEventListener('blur', () => {
	setTimeout(() => { resultsList.innerHTML = ''; }, 150);
});

/////////////////////
// events

function uuidv4() {
	return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
		(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
	);
}
const sessionId = uuidv4();
const updateInterval = 100;
let updateStart;

function updateOnce() {
	updateStart = performance.now();
	return fetch(new URL(`/updates/${sessionId}`, location))
		.then(resp => {
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			return resp.json();
		})
		.then(updateData => {
			Object.entries(updateData).forEach(([tag, data]) => {
				switch (tag) {
					case 'cars':
						updateAllCars(data);
						break;
					case 'jobs':
						updateAllJobs(data);
						break;
					case 'junctions':
						updateAllJunctions(data);
						break;
					case 'player':
						updatePlayerOverlays(data);
						break;
					case 'signals':
						updateAllSignals(data);
						break;
					default:
						const segments = tag.split('-');
						switch (segments[0]) {
							case 'trainset': updateCars(data); break;
							case 'carguid': updateCar(data.id, data); break;
						}
				}
			});
		})
		.then(_ => {
			if (markerToFollow)
				map.panTo(markerToFollow.getBounds().getCenter());
		});
}

function updateLoop() {
	updateOnce()
		.catch(err => {
			console.error('Update failed:', err);
		})
		.then(_ => {
			const timeToNextUpdate = (updateStart + updateInterval) - performance.now();
			setTimeout(updateLoop, timeToNextUpdate);
		});
}

/////////////////////
// signal visibility

const validYards = new Set([
	'IMW', 'MF', 'CP', 'CW', 'SW', 'FRS', 'OWC', 'FM', 'SM', 'FRC',
	'OR', 'FF', 'IME', 'MB', 'OWN', 'GF', 'CME', 'HB', 'CS', 'CMS'
]);

const signalVisibility = {
	show: true,
	all: true,
	distant: true,
	yards: {}
};

function yardFromSignalId(signalId) {
	const stripped = signalId.startsWith('#') ? signalId.slice(1) : signalId;
	const part = stripped.split('-')[2];
	return part ? part.split(':')[0] : null;
}

function applySignalVisibility() {
	signalMarkers.forEach(({ marker, type }, signalId) => {
		const yard = yardFromSignalId(signalId);
		const yardVisible = yard ? (signalVisibility.yards[yard] ?? true) : true;
		const distantVisible = type === 'Distant' ? signalVisibility.distant : true;
		const visible = signalVisibility.show
			&& signalVisibility.all
			&& yardVisible
			&& distantVisible;

		if (visible) {
			if (!signalLayerGroup.hasLayer(marker)) marker.addTo(signalLayerGroup);
		} else {
			if (signalLayerGroup.hasLayer(marker)) signalLayerGroup.removeLayer(marker);
		}
	});
}

function buildSignalsSidebar(installed) {
	const content = document.getElementById('signals-sidebar-content');
	if (!content) return;

	if (!installed) {
		content.innerHTML = '<p style="margin:12px 16px;color:#888;font-style:italic;">Signals mod not installed.</p>';
		return;
	}

	const presentYards = [...new Set(
		[...signalMarkers.keys()].map(yardFromSignalId).filter(y => y && validYards.has(y))
	)].sort();

	presentYards.forEach(yard => { signalVisibility.yards[yard] = true; });

	const yardCheckboxes = presentYards.map(yard => `
		<label class="sig-filter-label">
			<input type="checkbox" class="sig-filter-yard" data-yard="${yard}" checked>
			<span>${yard}</span>
		</label>`).join('');

	content.innerHTML = `
		<div class="sig-filter-section">
			<label class="sig-filter-label sig-filter-master">
				<input type="checkbox" id="sig-filter-show" checked>
				<span>Show all signals</span>
			</label>
		</div>
		<div id="sig-filter-sub" class="sig-filter-section">
			<label class="sig-filter-label">
				<input type="checkbox" id="sig-filter-distant" checked>
				<span>Show Distant signals</span>
			</label>
			<div class="sig-filter-divider">Yards</div>
			<div class="sig-filter-yard-grid">
				${yardCheckboxes}
			</div>
		</div>`;

	const subSection = content.querySelector('#sig-filter-sub');
	const allSubInputs = () => subSection.querySelectorAll('input');

	const showCb = content.querySelector('#sig-filter-show');
	showCb.addEventListener('change', e => {
		signalVisibility.show = e.target.checked;
		allSubInputs().forEach(el => { el.disabled = !e.target.checked; });
		subSection.style.opacity = e.target.checked ? '' : '0.4';
		applySignalVisibility();
	});

	const distantCb = content.querySelector('#sig-filter-distant');
	distantCb.addEventListener('change', e => {
		signalVisibility.distant = e.target.checked;
		applySignalVisibility();
	});

	const yardGrid = content.querySelector('.sig-filter-yard-grid');
	yardGrid.addEventListener('change', e => {
		const cb = e.target;
		if (!cb.matches('.sig-filter-yard')) return;
		signalVisibility.yards[cb.dataset.yard] = cb.checked;
		applySignalVisibility();
	});
}

let signalsInstalled = false;

const signalsReady = junctionsReady
	.then(_ => fetch(new URL('/signals', location)))
	.then(resp => {
		if (!resp.ok) throw new Error(`Signals endpoint failed: HTTP ${resp.status} ${resp.statusText}`);
		return resp.json();
	})
	.catch(err => {
		console.error('Failed to load signal data:', err);
		return null;
	})
	.then(allSignalsData => {
		if (allSignalsData !== null) {
			signalsInstalled = true;
			Object.entries(allSignalsData).forEach(([signalId, signalData]) =>
				createSignalMarker(signalId, signalData));
		}
	});

signalsReady.then(_ => {
	buildSignalsSidebar(signalsInstalled);
	updateSignalLayerVisibility(); // apply zoom filter immediately after signals load
	updateLoop();
});
