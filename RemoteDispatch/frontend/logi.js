/* ============================================================
   logi.js — Logistics Officer screen. A third view (Map / CTC /
   Logistics) focused on the cargo side: a job board, the trains
   rolling, and yard tallies. Reads the same live data main.js
   already loads (allJobData, allCarData). Shared coordination
   (claim / status / notes) is layered on in a later step.

   Depends on main.js globals at runtime (after it has executed),
   so the load order (logi.js, main.js) is safe.
   ============================================================ */

let logiInitialised = false;
let logiSort = { key: 'pay', dir: -1 }; // default: highest paying first
let logiFilter = '';

const LOGI_JOB_TYPES = {
	FH: 'Freight', LH: 'Logistics', SL: 'Shunt load', SU: 'Shunt unload',
	EH: 'Empty haul', CH: 'Cargo', PC: 'Passenger', ML: 'Mail',
};

function logiEsc(v) {
	return String(v == null ? '' : v)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function logiJobParts(jobId) {
	const p = String(jobId).split('-');
	return { origin: p[0] || '?', typeCode: p[1] || '' };
}

function logiCarCount(jobData) {
	if (!jobData || !jobData.tasks) return 0;
	return jobData.tasks.reduce((n, t) => n + ((t.cars && t.cars.length) || 0), 0);
}

const logiMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// One row of board data, normalised for sorting/rendering.
function logiRow(jobId, jobData) {
	const { origin, typeCode } = logiJobParts(jobId);
	return {
		id: jobId,
		type: LOGI_JOB_TYPES[typeCode] || typeCode || '—',
		origin,
		dest: jobData.destinationYardId || '—',
		cars: logiCarCount(jobData),
		mass: jobData.mass || 0,
		pay: jobData.basePayment || 0,
		lic: (jobData.requiredLicenses || []).join(' '),
		status: jobData.isActive ? 'Active' : 'Available',
		active: !!jobData.isActive,
	};
}

function logiMatches(row) {
	if (!logiFilter) return true;
	const f = logiFilter.toLowerCase();
	return [row.id, row.type, row.origin, row.dest, row.lic].some(s => String(s).toLowerCase().includes(f));
}

function logiRenderBoard() {
	const body = document.getElementById('logi-board-body');
	if (!body || typeof allJobData === 'undefined') return;
	const rows = [];
	allJobData.forEach((jobData, jobId) => {
		const r = logiRow(jobId, jobData);
		if (logiMatches(r)) rows.push(r);
	});
	const k = logiSort.key, dir = logiSort.dir;
	rows.sort((a, b) => {
		const va = a[k], vb = b[k];
		if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
		return String(va).localeCompare(String(vb)) * dir;
	});
	body.innerHTML = rows.map(r => `<tr class="${r.active ? 'logi-active' : ''}">`
		+ `<td class="logi-mono">${logiEsc(r.id)}</td>`
		+ `<td>${logiEsc(r.type)}</td>`
		+ `<td class="logi-route">${logiEsc(r.origin)} &rarr; ${logiEsc(r.dest)}</td>`
		+ `<td class="logi-num">${r.cars}</td>`
		+ `<td class="logi-num">${Math.round(r.mass)}t</td>`
		+ `<td class="logi-num logi-pay">${logiMoney.format(r.pay)}</td>`
		+ `<td class="logi-lic">${logiEsc(r.lic)}</td>`
		+ `<td><span class="logi-status ${r.active ? 'active' : 'avail'}">${logiEsc(r.status)}</span></td>`
		+ `</tr>`).join('');

	// reflect sort indicator on the active header
	document.querySelectorAll('#logi-board th[data-sort]').forEach(th => {
		th.classList.toggle('sorted', th.getAttribute('data-sort') === k);
		th.setAttribute('data-dir', th.getAttribute('data-sort') === k ? (dir < 0 ? 'down' : 'up') : '');
	});
	return rows.length;
}

function logiRenderTrains() {
	const el = document.getElementById('logi-trains');
	if (!el || typeof allCarData === 'undefined') return 0;
	const locos = [...allCarData.entries()]
		.filter(([id]) => id.slice(0, 2) === 'L-')
		.sort(([a], [b]) => a.localeCompare(b));
	el.innerHTML = locos.map(([id, car]) => {
		const speed = car.forwardSpeed != null ? Math.round(car.forwardSpeed) : 0;
		const job = car.jobId || 'light engine';
		const dest = car.destinationYardId ? ' &rarr;' + logiEsc(car.destinationYardId) : '';
		const moving = speed > 0;
		return `<div class="logi-train">`
			+ `<div class="logi-train-top"><span class="logi-mono">${logiEsc(id.slice(2))}</span>`
			+ `<span class="logi-speed ${moving ? 'moving' : ''}">${speed} km/h</span></div>`
			+ `<div class="logi-train-sub">${logiEsc(job)}${dest}</div></div>`;
	}).join('') || '<div class="logi-empty">No locomotives.</div>';
	return locos.length;
}

function logiRenderYards() {
	const el = document.getElementById('logi-yards');
	if (!el || typeof allJobData === 'undefined') return;
	const tally = new Map(); // dest yard -> job count
	allJobData.forEach(jobData => {
		const y = jobData.destinationYardId || '—';
		tally.set(y, (tally.get(y) || 0) + 1);
	});
	const entries = [...tally.entries()].sort((a, b) => b[1] - a[1]);
	el.innerHTML = entries.map(([y, n]) =>
		`<span class="logi-yard">${logiEsc(y)} <b>${n}</b></span>`).join('')
		|| '<div class="logi-empty">No jobs.</div>';
}

function logiRenderKpis(jobCount, trainCount) {
	const el = document.getElementById('logi-kpis');
	if (!el || typeof allJobData === 'undefined') return;
	let active = 0;
	allJobData.forEach(j => { if (j.isActive) active++; });
	const total = allJobData.size;
	el.innerHTML = `<span><b>${total}</b> jobs</span>`
		+ `<span><b class="logi-k-green">${active}</b> active</span>`
		+ `<span><b class="logi-k-amber">${trainCount}</b> locos</span>`;
}

function updateLogi() {
	if (!logiInitialised) return;
	const shown = logiRenderBoard();
	const trains = logiRenderTrains();
	logiRenderYards();
	logiRenderKpis(shown, trains);
}

function initLogi() {
	if (logiInitialised) return;
	logiInitialised = true;
	const filter = document.getElementById('logi-filter');
	if (filter) filter.addEventListener('input', e => { logiFilter = e.target.value.trim(); logiRenderBoard(); });
	document.querySelectorAll('#logi-board th[data-sort]').forEach(th => {
		th.addEventListener('click', () => {
			const key = th.getAttribute('data-sort');
			if (logiSort.key === key) logiSort.dir *= -1;
			else logiSort = { key, dir: (key === 'pay' || key === 'mass' || key === 'cars') ? -1 : 1 };
			logiRenderBoard();
		});
	});
}
