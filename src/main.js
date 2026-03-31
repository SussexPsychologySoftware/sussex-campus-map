import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../src/styles.css';
import QRious from 'qrious';
import campusStyle from './map-style.js';

// maplibre-gl-leaflet is a UMD side-effect plugin that mutates L.
// Import it via require() to avoid bun's __toESM interop issue.
const maplibregl = require('maplibre-gl');
require('@maplibre/maplibre-gl-leaflet');

// Load data at runtime so edits don't require a rebuild
(async () => {
const [buildings, accessibilityData] = await Promise.all([
    fetch('src/buildings.json').then(r => r.json()),
    fetch('src/accessibility.json').then(r => r.json()),
]);

// ── Navigation Graph ──────────────────────────────────────────
function haversine(a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Build node lookup, adjacency list, and entrance index
const navNodeMap = {};
(accessibilityData.nodes || []).forEach(n => { navNodeMap[n.id] = n; });

const adjList = {};
(accessibilityData.edges || []).forEach(raw => {
    const edge = { type: 'step_free', steps: 0, gradient: 0, ...raw };
    const from = navNodeMap[edge.from];
    const to = navNodeMap[edge.to];
    if (!from || !to) return;
    const weight = haversine(from, to);
    if (!adjList[edge.from]) adjList[edge.from] = [];
    if (!adjList[edge.to]) adjList[edge.to] = [];
    adjList[edge.from].push({ neighbor: edge.to, weight, edge });
    adjList[edge.to].push({ neighbor: edge.from, weight, edge });
});

const buildingEntrances = {};
(accessibilityData.nodes || []).filter(n => n.type === 'entrance').forEach(n => {
    if (!n.building) return;
    (buildingEntrances[n.building] = buildingEntrances[n.building] || []).push(n);
});

// Min-heap for Dijkstra
class MinHeap {
    constructor() { this.data = []; }
    push(item) {
        this.data.push(item);
        let i = this.data.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.data[p].dist <= this.data[i].dist) break;
            [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
            i = p;
        }
    }
    pop() {
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            let i = 0;
            while (true) {
                let s = i, l = 2 * i + 1, r = 2 * i + 2;
                if (l < this.data.length && this.data[l].dist < this.data[s].dist) s = l;
                if (r < this.data.length && this.data[r].dist < this.data[s].dist) s = r;
                if (s === i) break;
                [this.data[s], this.data[i]] = [this.data[i], this.data[s]];
                i = s;
            }
        }
        return top;
    }
    get size() { return this.data.length; }
}

function findStepFreeRoute(userLatLng, buildingSlug) {
    // Find nearest graph node to user
    let nearestNode = null, nearestDist = Infinity;
    for (const id in navNodeMap) {
        const n = navNodeMap[id];
        const d = haversine({ lat: userLatLng.lat, lng: userLatLng.lng }, n);
        if (d < nearestDist) { nearestDist = d; nearestNode = id; }
    }
    if (!nearestNode || nearestDist > 500) return null;

    // Find entrances for building, or fall back to closest node to building center
    const entrances = buildingEntrances[buildingSlug];
    let targetIds;
    let targetNodes;

    if (entrances && entrances.length > 0) {
        targetIds = new Set(entrances.map(e => e.id));
        targetNodes = entrances;
    } else {
        // No entrances defined — find the closest regular node to the building's coordinates
        const building = buildings.find(b => (b.slug || toSlug(b.name)) === buildingSlug);
        if (!building) return { error: 'no-entrances' };
        let closestNode = null, closestDist = Infinity;
        for (const id in navNodeMap) {
            const n = navNodeMap[id];
            const d = haversine({ lat: building.lat, lng: building.lng }, n);
            if (d < closestDist) { closestDist = d; closestNode = n; }
        }
        if (!closestNode || closestDist > 200) return { error: 'no-entrances' };
        targetIds = new Set([closestNode.id]);
        targetNodes = [closestNode];
    }

    // Dijkstra
    const dist = {};
    const prev = {};
    const visited = new Set();
    const heap = new MinHeap();

    dist[nearestNode] = 0;
    heap.push({ id: nearestNode, dist: 0 });

    let settledEntrances = 0;
    const totalTargets = targetIds.size;

    while (heap.size > 0) {
        const { id, dist: d } = heap.pop();
        if (visited.has(id)) continue;
        visited.add(id);

        if (targetIds.has(id)) {
            settledEntrances++;
            if (settledEntrances >= totalTargets) break;
        }

        const neighbors = adjList[id] || [];
        for (const { neighbor, weight, edge } of neighbors) {
            // Skip edges with stairs
            if (edge.steps > 0 || edge.type === 'steps') continue;
            const newDist = d + weight;
            if (newDist < (dist[neighbor] ?? Infinity)) {
                dist[neighbor] = newDist;
                prev[neighbor] = id;
                heap.push({ id: neighbor, dist: newDist });
            }
        }
    }

    // Find best reachable target (entrance or nearest node)
    let bestEntrance = null, bestDist = Infinity;
    for (const e of targetNodes) {
        if (dist[e.id] !== undefined && dist[e.id] < bestDist) {
            bestDist = dist[e.id];
            bestEntrance = e;
        }
    }
    if (!bestEntrance) return null;

    // Reconstruct path
    const path = [];
    let current = bestEntrance.id;
    while (current) {
        const n = navNodeMap[current];
        path.push([n.lat, n.lng]);
        current = prev[current];
    }
    path.reverse();

    return { path, distance: bestDist, entrance: bestEntrance };
}

// ── Entrance Sequence ───────────────────────────────────────────
const hasDeepLink = window.location.hash.startsWith('#building/');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Map Init ───────────────────────────────────────────────────
const map = L.map('map', {
    zoomControl: false
}).setView([50.8660, -0.0870], hasDeepLink ? 17 : 15);

L.control.zoom({ position: 'bottomright' }).addTo(map);

const campusTiles = L.maplibreGL({
    style: campusStyle,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://openfreemap.org">OpenFreeMap</a>',
});

const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
});

const illustrationBounds = [[50.8562429, -0.0988770], [50.8770442, -0.0741577]];
const illustrationLayer = L.tileLayer('tiles/{z}/{x}/{y}.png', {
    minZoom: 13,
    maxZoom: 17,
    opacity: 1,
    bounds: illustrationBounds,
    tileSize: 256
}).addTo(map);

// ── Custom Layer Toggle ────────────────────────────────────────
const btnIllustration = document.getElementById('layerIllustration');
const btnMapTiles = document.getElementById('layerMap');
const btnSatellite = document.getElementById('layerSatellite');
const layerButtons = [btnIllustration, btnMapTiles, btnSatellite];

function switchLayer(mode) {
    // Remove all base layers
    map.removeLayer(illustrationLayer);
    map.removeLayer(campusTiles);
    map.removeLayer(satelliteTiles);

    // Deactivate all buttons
    layerButtons.forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-checked', 'false');
    });

    // Marginalia only on illustrated layer
    if (typeof marginaliaLayer !== 'undefined') map.removeLayer(marginaliaLayer);

    if (mode === 'illustrated') {
        illustrationLayer.addTo(map);
        map.setMinZoom(13);
        btnIllustration.classList.add('active');
        btnIllustration.setAttribute('aria-checked', 'true');
        // Keep polygons for hover glow but make them invisible
        if (!map.hasLayer(polygonsLayer)) polygonsLayer.addTo(map);
        buildings.forEach(b => {
            if (b.leafletPolygon) b.leafletPolygon.setStyle({ fillOpacity: 0, opacity: 0, weight: 0 });
        });
        if (map.hasLayer(markersLayer)) map.removeLayer(markersLayer);
        if (typeof marginaliaLayer !== 'undefined') marginaliaLayer.addTo(map);
    } else if (mode === 'map') {
        map.setMinZoom(0);
        campusTiles.addTo(map);
        btnMapTiles.classList.add('active');
        btnMapTiles.setAttribute('aria-checked', 'true');
        if (!map.hasLayer(polygonsLayer)) polygonsLayer.addTo(map);
        if (!map.hasLayer(markersLayer)) markersLayer.addTo(map);
    } else if (mode === 'satellite') {
        map.setMinZoom(0);
        satelliteTiles.addTo(map);
        btnSatellite.classList.add('active');
        btnSatellite.setAttribute('aria-checked', 'true');
        if (!map.hasLayer(polygonsLayer)) polygonsLayer.addTo(map);
        if (map.hasLayer(markersLayer)) map.removeLayer(markersLayer);
    }
}

btnIllustration.addEventListener('click', () => switchLayer('illustrated'));
btnMapTiles.addEventListener('click', () => switchLayer('map'));
btnSatellite.addEventListener('click', () => switchLayer('satellite'));

// ── Marginalia — directional whispers at map edges ────────────
const marginalia = [
    {
        lat: 50.8545, lng: -0.0865,
        label: 'Brighton Beach',
        detail: '3 miles south',
        icon: '〰',
        rotation: 0,
    },
    {
        lat: 50.8800, lng: -0.0870,
        label: 'London',
        detail: '50 miles · 1 hr by train',
        icon: '↑',
        rotation: 0,
    },
];

const marginaliaLayer = L.layerGroup();
marginalia.forEach(m => {
    const rotateStyle = m.rotation ? `transform:rotate(${m.rotation}deg)` : '';
    const marker = L.marker([m.lat, m.lng], {
        interactive: false,
        pane: 'tooltipPane',
        icon: L.divIcon({
            className: 'marginalia-label',
            html: `<div class="marginalia-inner">
                <span class="marginalia-icon" style="${rotateStyle}">${m.icon}</span>
                <span class="marginalia-name">${m.label}</span>
                <span class="marginalia-detail">${m.detail}</span>
            </div>`,
            iconSize: null,
            iconAnchor: [0, 0],
        }),
    });
    marginaliaLayer.addLayer(marker);
});
marginaliaLayer.addTo(map);

// ── Category Colors (Sussex brand palette) ────────────────────
const categoryColors = {
    residence:  { color: '#5B3046', fillColor: '#7a4a60' },
    landmark:   { color: '#6F7587', fillColor: '#8c91a0' },
    default:    { color: '#033803', fillColor: '#356035' },
};

function getColors(category) {
    return categoryColors[category] || categoryColors.default;
}

// ── Markers & Polygons ─────────────────────────────────────────
const polygonsLayer = L.layerGroup();
const markersLayer = L.layerGroup();
let highlightLayer = null;
let selectedBuilding = null;

buildings.forEach(b => {
    b.center = L.latLng(b.lat, b.lng);
    const colors = getColors(b.category);

    // Circle marker — subtle by default
    const m = L.circleMarker([b.lat, b.lng], {
        radius: 4,
        color: '#033803',
        weight: 0,
        fillColor: '#033803',
        fillOpacity: 1,
        opacity: 0
    });
    m.on('click', (e) => { L.DomEvent.stopPropagation(e); selectBuilding(b); });
    b.marker = m;
    markersLayer.addLayer(m);

    // Building label — positioned above the dot
    const shortName = b.shortName || b.name;
    const labelIcon = L.divIcon({
        className: 'building-label',
        html: `<div class="building-label-inner"><span class="building-label-text">${shortName}</span><div class="building-label-arrow"></div></div>`,
        iconSize: null,
        iconAnchor: [0, 22]
    });
    const label = L.marker([b.lat, b.lng], { icon: labelIcon, interactive: false, pane: 'tooltipPane' });
    b.labelMarker = label;

    // Polygon — subtle by default
    if (b.polygon) {
        const poly = L.polygon(b.polygon, {
            color: colors.color,
            weight: 0.5,
            opacity: 0.3,
            fillColor: colors.fillColor,
            fillOpacity: 0.05
        });
        poly.on('click', (e) => { L.DomEvent.stopPropagation(e); selectBuilding(b); });
        b.leafletPolygon = poly;
        b.polyCenter = poly.getBounds().getCenter();
        polygonsLayer.addLayer(poly);
    }
});

// ── Building Labels (zoom-dependent) ──────────────────────────
const labelsLayer = L.layerGroup();

let labelsVisible = false;

function updateLabels() {
    const zoom = map.getZoom();
    if (zoom >= 15) {
        buildings.forEach(b => {
            if (b.labelMarker && !labelsLayer.hasLayer(b.labelMarker)) {
                labelsLayer.addLayer(b.labelMarker);
            }
        });
        if (!map.hasLayer(labelsLayer)) labelsLayer.addTo(map);

        if (!labelsVisible) {
            labelsVisible = true;
            // Enable animation mode and trigger staggered pop-in after DOM renders
            document.getElementById('map').classList.add('labels-animated');
            requestAnimationFrame(() => {
                buildings.forEach((b, i) => {
                    if (b.labelMarker) {
                        const el = b.labelMarker.getElement();
                        if (el) {
                            const inner = el.querySelector('.building-label-inner');
                            if (inner) setTimeout(() => inner.classList.add('visible'), i * 15);
                        }
                    }
                });
            });
        }
    } else if (labelsVisible) {
        labelsVisible = false;
        buildings.forEach(b => {
            if (b.labelMarker) {
                const el = b.labelMarker.getElement();
                if (el) {
                    const inner = el.querySelector('.building-label-inner');
                    if (inner) inner.classList.remove('visible');
                }
            }
        });
        setTimeout(() => {
            if (map.getZoom() < 15) {
                if (map.hasLayer(labelsLayer)) map.removeLayer(labelsLayer);
                document.getElementById('map').classList.remove('labels-animated');
            }
        }, 350);
    }
}

map.on('zoomend', updateLabels);

// ── Facility Search Keywords ──────────────────────────────────
const facilitySearchTerms = {
    cafe:       ['cafe', 'café', 'coffee', 'bar', 'eatery', 'drink'],
    food_hall:  ['food hall', 'food', 'canteen', 'restaurant', 'eat', 'lunch', 'dinner', 'meal'],
    shop:       ['shop', 'store', 'buy'],
    atm:        ['atm', 'cash', 'money', 'bank'],
    post_office:['post', 'mail', 'letter', 'stamp'],
    health:     ['health', 'first aid', 'doctor', 'medical', 'nurse', 'gp'],
    pharmacy:   ['pharmacy', 'chemist', 'prescription', 'medicine'],
    info:       ['information', 'info', 'help desk', 'reception'],
    accessible: ['accessible', 'wheelchair', 'disability', 'disabled'],
    showers:    ['shower', 'changing', 'changing room', 'locker'],
    sport:      ['sport', 'gym', 'fitness', 'exercise', 'workout'],
    security:   ['security', 'emergency', 'safety', '24h', 'night'],
    emergency:  ['emergency', 'emergency point', 'emergency contact', 'help point'],
    laundry:    ['laundry', 'laundrette', 'washing', 'launderette', 'dryer'],
};

function matchingFacilities(q) {
    if (q.length < 3) return [];
    const results = [];
    for (const [key, terms] of Object.entries(facilitySearchTerms)) {
        if (terms.some(t => t.startsWith(q) || q.startsWith(t))) {
            results.push(key);
        }
    }
    return results;
}

function findNearestWithFacility(facilityKey) {
    const centre = locationMarker ? locationMarker.getLatLng() : map.getCenter();
    let nearest = null;
    let nearestDist = Infinity;
    buildings.forEach(b => {
        if (b.facilities && b.facilities.includes(facilityKey)) {
            const dist = centre.distanceTo(L.latLng(b.lat, b.lng));
            if (dist < nearestDist) {
                nearest = b;
                nearestDist = dist;
            }
        }
    });
    return nearest;
}

// ── Search & Autocomplete ──────────────────────────────────────
const searchInput = document.getElementById('searchInput');
const suggestionsEl = document.getElementById('suggestions');
const clearBtn = document.getElementById('clearBtn');
let activeIndex = -1;
let currentMatches = [];   // building objects
let facilityMatches = [];  // { key, label } objects shown before building matches

searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    clearBtn.style.display = q ? 'block' : 'none';
    searchInput.setAttribute('aria-expanded', q ? 'true' : 'false');

    if (!q) {
        suggestionsEl.style.display = 'none';
        currentMatches = [];
        facilityMatches = [];
        return;
    }

    // Facility matches
    facilityMatches = matchingFacilities(q).map(key => ({
        key,
        label: facilityMeta[key].label,
        color: facilityMeta[key].color,
    }));

    // Building matches
    currentMatches = buildings.filter(b => {
        const terms = [b.name, ...(b.aliases || [])];
        return terms.some(t => t.toLowerCase().includes(q));
    });

    currentMatches.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name);
    });

    currentMatches = currentMatches.slice(0, 12 - facilityMatches.length);

    if (currentMatches.length === 0 && facilityMatches.length === 0) {
        suggestionsEl.innerHTML = '<div class="suggestion" style="cursor:default;color:#9ca3af" role="option">No results found</div>';
        suggestionsEl.style.display = 'block';
        return;
    }

    activeIndex = -1;
    renderSuggestions(q);
});

function renderSuggestions(q) {
    const totalCount = facilityMatches.length + currentMatches.length;

    let html = '';

    // Facility "Nearest …" suggestions
    facilityMatches.forEach((f, i) => {
        const isActive = i === activeIndex;
        html += `
        <div class="suggestion suggestion-facility${isActive ? ' active' : ''}" data-facility="${f.key}" data-idx="${i}" role="option" id="suggestion-${i}" aria-selected="${isActive}">
            <div class="s-name"><span style="vertical-align:-4px;margin-right:4px;display:inline-block">${facilityIconSvg(f.key, 16)}</span>Nearest ${f.label}</div>
            <div class="s-meta">Find closest to ${locationMarker ? 'you' : 'map centre'}</div>
        </div>`;
    });

    // Building suggestions
    currentMatches.forEach((b, i) => {
        const idx = facilityMatches.length + i;
        const isActive = idx === activeIndex;
        html += `
        <div class="suggestion${isActive ? ' active' : ''}" data-idx="${idx}" role="option" id="suggestion-${idx}" aria-selected="${isActive}">
            <div class="s-name">${highlightText(b.name, q)}</div>
            <div class="s-meta">Grid ${b.grid}</div>
        </div>`;
    });

    suggestionsEl.innerHTML = html;
    suggestionsEl.style.display = 'block';

    if (activeIndex >= 0) {
        searchInput.setAttribute('aria-activedescendant', `suggestion-${activeIndex}`);
    } else {
        searchInput.removeAttribute('aria-activedescendant');
    }

    suggestionsEl.querySelectorAll('.suggestion').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx);
            if (isNaN(idx)) return;
            if (idx < facilityMatches.length) {
                const nearest = findNearestWithFacility(facilityMatches[idx].key);
                if (nearest) selectBuilding(nearest);
            } else {
                const bIdx = idx - facilityMatches.length;
                if (currentMatches[bIdx]) selectBuilding(currentMatches[bIdx]);
            }
        });
    });
}

function highlightText(text, q) {
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx))
        + '<strong>' + escapeHtml(text.slice(idx, idx + q.length)) + '</strong>'
        + escapeHtml(text.slice(idx + q.length));
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Keyboard navigation
searchInput.addEventListener('keydown', (e) => {
    const totalCount = facilityMatches.length + currentMatches.length;
    if (!totalCount) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, totalCount - 1);
        renderSuggestions(searchInput.value.trim());
        scrollActiveIntoView();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, -1);
        renderSuggestions(searchInput.value.trim());
        scrollActiveIntoView();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const idx = activeIndex >= 0 ? activeIndex : 0;
        if (idx < facilityMatches.length) {
            const nearest = findNearestWithFacility(facilityMatches[idx].key);
            if (nearest) selectBuilding(nearest);
        } else {
            const bIdx = idx - facilityMatches.length;
            if (currentMatches[bIdx]) selectBuilding(currentMatches[bIdx]);
        }
    } else if (e.key === 'Escape') {
        suggestionsEl.style.display = 'none';
        searchInput.setAttribute('aria-expanded', 'false');
        searchInput.blur();
    }
});

function scrollActiveIntoView() {
    const active = suggestionsEl.querySelector('.suggestion.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

// Clear
clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    suggestionsEl.style.display = 'none';
    searchInput.setAttribute('aria-expanded', 'false');
    currentMatches = [];
    clearSelection();
});

// ── Highlight & Selection ──────────────────────────────────────
const highlightPolyStyle = {
    color: '#32D8C5',
    weight: 4,
    opacity: 1,
    fillColor: '#32D8C5',
    fillOpacity: 0.25,
    dashArray: null,
    className: 'highlight-pulse'
};

const highlightMarkerStyle = {
    radius: 16,
    color: '#32D8C5',
    weight: 4,
    fillColor: '#32D8C5',
    fillOpacity: 0.25,
    className: 'highlight-pulse'
};

// ── Facility Icons (Lucide) ────────────────────────────────────
const facilityMeta = {
    cafe:       { label: 'Café / Bar',        color: '#d6368b', icon: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>' },
    food_hall:  { label: 'Food Hall',        color: '#d6368b', icon: '<path d="m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8"/><path d="M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7"/><path d="m2.1 21.8 6.4-6.3"/><path d="m19 5-7 7"/>' },
    shop:       { label: 'Shop',             color: '#d6368b', icon: '<path d="M16 10a4 4 0 0 1-8 0"/><path d="M3.103 6.034h17.794"/><path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z"/>' },
    atm:        { label: 'ATM',              color: '#d6368b', icon: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>' },
    post_office:{ label: 'Post Office',      color: '#d6368b', icon: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>' },
    health:     { label: 'Health',           color: '#2fa84f', icon: '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/><path d="M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>' },
    pharmacy:   { label: 'Pharmacy',         color: '#2fa84f', icon: '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>' },
    info:       { label: 'Information',      color: '#00868b', icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>' },
    accessible: { label: 'Accessible',       color: '#00868b', icon: '<circle cx="16" cy="4" r="1"/><path d="m18 19 1-7-6 1"/><path d="m5 8 3-3 5.5 3-2.36 3.5"/><path d="M4.24 14.5a5 5 0 0 0 6.88 6"/><path d="M13.76 17.5a5 5 0 0 0-6.88-6"/>' },
    showers:    { label: 'Showers',          color: '#00868b', icon: '<path d="m4 4 2.5 2.5"/><path d="M13.5 6.5a4.95 4.95 0 0 0-7 7"/><path d="M15 5 5 15"/><path d="M14 17v.01"/><path d="M10 16v.01"/><path d="M13 13v.01"/><path d="M16 10v.01"/><path d="M11 20v.01"/><path d="M17 14v.01"/><path d="M20 11v.01"/>' },
    sport:      { label: 'Sport / Gym',      color: '#00868b', icon: '<path d="M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z"/><path d="m2.5 21.5 1.4-1.4"/><path d="m20.1 3.9 1.4-1.4"/><path d="M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z"/><path d="m9.6 14.4 4.8-4.8"/>' },
    security:   { label: '24h Security',     color: '#3d4152', icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' },
    emergency:  { label: 'Emergency Point',  color: '#e94560', icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>' },
    laundry:    { label: 'Laundrette',       color: '#00868b', icon: '<path d="M3 6h3"/><path d="M17 6h.01"/><rect width="18" height="20" x="3" y="2" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M12 18a2.5 2.5 0 0 0 0-5 2.5 2.5 0 0 1 0-5"/>' },
};

const toiletIcon = '<path d="M7 12h13a1 1 0 0 1 1 1 5 5 0 0 1-5 5h-.598a.5.5 0 0 0-.424.765l1.544 2.47a.5.5 0 0 1-.424.765H5.402a.5.5 0 0 1-.424-.765L7 18"/><path d="M8 18a5 5 0 0 1-5-5V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8"/>';

function facilityIconSvg(key, size) {
    const f = facilityMeta[key];
    if (!f) return '';
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${f.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${f.icon}</svg>`;
}

function renderFacilityIcon(key) {
    const f = facilityMeta[key];
    if (!f) return '';
    return `<span class="facility-icon" title="${f.label}" aria-label="${f.label}">${facilityIconSvg(key, 24)}<span class="facility-label">${f.label}</span></span>`;
}

// ── Facility Quick-Access Bar ─────────────────────────────────
const facilityBar = document.getElementById('facilityBar');
const barFacilities = ['cafe', 'food_hall', 'shop', 'atm', 'health', 'pharmacy', 'sport', 'showers', 'laundry', 'info', 'security'];

facilityBar.innerHTML = barFacilities.map(key => {
    const f = facilityMeta[key];
    return `<button class="facility-bar-btn" data-facility="${key}" title="Nearest ${f.label}" aria-label="Find nearest ${f.label}">${facilityIconSvg(key, 20)}<span>${f.label}</span></button>`;
}).join('');

let activeFacility = null;
let facilityHighlights = [];

facilityBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.facility-bar-btn');
    if (!btn) return;
    const key = btn.dataset.facility;

    // Toggle off if same facility tapped again
    if (activeFacility === key) {
        clearFacilityMode();
        return;
    }
    selectFacility(key);
});

function selectFacility(key) {
    clearHighlight();
    clearFacilityHighlights();
    selectedBuilding = null;
    activeFacility = key;

    // Highlight active button
    facilityBar.querySelectorAll('.facility-bar-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.facility === key);
    });

    const f = facilityMeta[key];
    const centre = locationMarker ? locationMarker.getLatLng() : map.getCenter();

    // Find all buildings with this facility, sorted by distance
    const matches = buildings
        .filter(b => b.facilities && b.facilities.includes(key))
        .map(b => ({ building: b, dist: centre.distanceTo(L.latLng(b.lat, b.lng)) }))
        .sort((a, b) => a.dist - b.dist);

    if (!matches.length) return;

    const nearest = matches[0].building;

    // Highlight all matching buildings on map
    matches.forEach(({ building: b }, i) => {
        const isNearest = i === 0;
        let highlight;
        if (b.leafletPolygon) {
            highlight = L.polygon(b.leafletPolygon.getLatLngs(), {
                color: f.color,
                weight: isNearest ? 3 : 2,
                opacity: 1,
                fillColor: f.color,
                fillOpacity: isNearest ? 0.35 : 0.2,
                className: isNearest ? 'highlight-pulse' : ''
            }).addTo(map);
        } else {
            highlight = L.circleMarker([b.lat, b.lng], {
                radius: isNearest ? 14 : 10,
                color: f.color,
                weight: isNearest ? 3 : 2,
                fillColor: f.color,
                fillOpacity: isNearest ? 0.35 : 0.2,
                className: isNearest ? 'highlight-pulse' : ''
            }).addTo(map);
        }
        highlight.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            selectBuilding(b);
        });
        facilityHighlights.push(highlight);
    });

    // Show facility list panel
    showFacilityPanel(key, matches);

    // Fit map to show all matches
    const group = L.featureGroup(facilityHighlights);
    setTimeout(() => {
        map.invalidateSize();
        map.fitBounds(group.getBounds().pad(0.3), { maxZoom: 17, animate: true });
    }, 50);

    searchInput.value = '';
    clearBtn.style.display = 'none';
    suggestionsEl.style.display = 'none';
}

function showFacilityPanel(key, matches) {
    const f = facilityMeta[key];
    const centre = locationMarker ? locationMarker.getLatLng() : map.getCenter();

    document.getElementById('panelName').innerHTML = `${facilityIconSvg(key, 22)} ${f.label}`;

    const catEl = document.getElementById('panelCategory');
    catEl.textContent = `${matches.length} location${matches.length !== 1 ? 's' : ''}`;
    catEl.setAttribute('data-cat', '');

    document.getElementById('panelDescription').textContent = '';
    document.getElementById('panelGrid').textContent = locationMarker ? 'Sorted by distance from you' : 'Sorted by distance from map centre';

    // Facility list
    const facilitiesEl = document.getElementById('panelFacilities');
    let html = '<div class="facility-list">';
    matches.forEach(({ building: b, dist }, i) => {
        const distText = dist < 1000 ? `${Math.round(dist)}m` : `${(dist / 1000).toFixed(1)}km`;
        const isNearest = i === 0;
        html += `<button class="facility-list-item${isNearest ? ' nearest' : ''}" data-slug="${b.slug || toSlug(b.name)}">
            <span class="facility-list-name">${isNearest ? '<span class="nearest-badge">Nearest</span> ' : ''}${b.name}</span>
            <span class="facility-list-dist">${distText}</span>
        </button>`;
    });
    html += '</div>';
    facilitiesEl.innerHTML = html;
    facilitiesEl.style.display = 'block';

    // Click handlers for list items
    facilitiesEl.querySelectorAll('.facility-list-item').forEach(el => {
        el.addEventListener('click', () => {
            const slug = el.dataset.slug;
            const building = buildings.find(b => (b.slug || toSlug(b.name)) === slug);
            if (building) {
                clearFacilityHighlights();
                activeFacility = null;
                facilityBar.querySelectorAll('.facility-bar-btn').forEach(b => b.classList.remove('active'));
                selectBuilding(building);
            }
        });
    });

    // Hide share/maps/QR for facility mode
    document.querySelector('.panel-actions').style.display = 'none';
    document.querySelector('.panel-qr').style.display = 'none';

    infoPanel.classList.add('open');
    infoPanel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('panel-open');
    srAnnounce.textContent = `${f.label}: ${matches.length} locations found.`;
    setTimeout(() => map.invalidateSize(), 50);
}

function clearFacilityHighlights() {
    facilityHighlights.forEach(m => map.removeLayer(m));
    facilityHighlights = [];
}

function clearFacilityMode() {
    clearFacilityHighlights();
    activeFacility = null;
    facilityBar.querySelectorAll('.facility-bar-btn').forEach(b => b.classList.remove('active'));
    closePanel();
    history.replaceState(null, '', window.location.pathname);
}

// ── Accessibility Overlay ──────────────────────────────────────
const accessibilityLayer = L.layerGroup();
let accessibilityVisible = false;
const btnAccessibility = document.getElementById('btnAccessibility');

function renderAccessibilityOverlay() {
    accessibilityLayer.clearLayers();

    const nodes = accessibilityData.nodes || [];
    const edges = accessibilityData.edges || [];

    // Build node lookup
    const nodeMap = {};
    nodes.forEach(n => { nodeMap[n.id] = n; });

    // Edge styles by type
    const routeBlue = '#3F77CA';
    const edgeStyles = {
        step_free: { color: routeBlue, weight: 4, opacity: 1, dashArray: null },
        slope:     { color: routeBlue, weight: 4, opacity: 1, dashArray: '8 6' },
        steps:     { color: routeBlue, weight: 3, opacity: 1, dashArray: '6 4' },
        path:      { color: routeBlue, weight: 4, opacity: 1, dashArray: null },
    };

    // Draw edges
    edges.forEach(edge => {
        const from = nodeMap[edge.from];
        const to = nodeMap[edge.to];
        if (!from || !to) return;

        const style = edgeStyles[edge.type] || edgeStyles.path;
        const line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], style);

        accessibilityLayer.addLayer(line);

        // Midpoint label for slopes and steps
        const midLat = (from.lat + to.lat) / 2;
        const midLng = (from.lng + to.lng) / 2;
        if (edge.type === 'slope' && edge.gradient) {
            accessibilityLayer.addLayer(L.marker([midLat, midLng], {
                icon: L.divIcon({
                    className: 'slope-label',
                    html: `<span>${edge.gradient}°</span>`,
                    iconSize: null, iconAnchor: [14, 10]
                }), interactive: false
            }));
        } else if (edge.type === 'steps' && edge.steps) {
            accessibilityLayer.addLayer(L.marker([midLat, midLng], {
                icon: L.divIcon({
                    className: 'steps-marker',
                    html: `<span class="steps-label"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="10" height="4" x="2" y="16"/><rect width="10" height="4" x="4" y="12"/><rect width="10" height="4" x="6" y="8"/><rect width="10" height="4" x="8" y="4"/><path d="M12 20h10V4h-4"/></svg>${edge.steps}</span>`,
                    iconSize: null, iconAnchor: [14, 8]
                }), interactive: false
            }));
        }
    });

    // Draw nodes
    const entranceColors = { general: '#22c55e', wheelchair_accessible: '#3b82f6', wheelchair_inaccessible: '#ef4444' };
    const edgeCounts = {};
    edges.forEach(e => {
        edgeCounts[e.from] = (edgeCounts[e.from] || 0) + 1;
        edgeCounts[e.to] = (edgeCounts[e.to] || 0) + 1;
    });

    nodes.forEach(n => {
        if (n.type === 'entrance') {
            const color = entranceColors[n.entranceType] || '#22c55e';
            const bearing = n.bearing || 0;
            const bName = n.building ? (buildings.find(b => (b.slug || toSlug(b.name)) === n.building) || {}).name || n.building : '';
            const marker = L.marker([n.lat, n.lng], {
                icon: L.divIcon({
                    className: 'entrance-icon',
                    html: `<div style="transform:rotate(${bearing}deg);color:${color};font-size:20px;line-height:1;text-shadow:0 1px 3px rgba(0,0,0,0.5);text-align:center">&#x25B2;</div>`,
                    iconSize: [20, 20], iconAnchor: [10, 10]
                }), interactive: false
            });
            const typeLabel = (n.entranceType || 'general').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            marker.bindTooltip(`${bName} — ${typeLabel}`, { direction: 'top', offset: [0, -10] });
            accessibilityLayer.addLayer(marker);
        } else if ((edgeCounts[n.id] || 0) >= 3) {
            accessibilityLayer.addLayer(L.circleMarker([n.lat, n.lng], {
                radius: 1.5, color: routeBlue, fillColor: routeBlue,
                fillOpacity: 1, weight: 1
            }));
        }
    });
}

renderAccessibilityOverlay();

function toggleAccessibility() {
    accessibilityVisible = !accessibilityVisible;
    if (accessibilityVisible) {
        switchLayer('map');
        accessibilityLayer.addTo(map);
        btnAccessibility.classList.add('active');
        btnAccessibility.setAttribute('aria-pressed', 'true');
    } else {
        map.removeLayer(accessibilityLayer);
        btnAccessibility.classList.remove('active');
        btnAccessibility.setAttribute('aria-pressed', 'false');
    }
    // Keep route layer on top
    if (routeLayer) routeLayer.bringToFront();
}

btnAccessibility.addEventListener('click', toggleAccessibility);

// ── Info Panel ─────────────────────────────────────────────────
const infoPanel = document.getElementById('infoPanel');
const panelClose = document.getElementById('panelClose');
const srAnnounce = document.getElementById('srAnnounce');

panelClose.addEventListener('click', clearSelection);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && infoPanel.classList.contains('open')) clearSelection();
});

function showPanel(building) {
    // Restore sections that facility mode may have hidden
    document.querySelector('.panel-actions').style.display = '';
    document.querySelector('.panel-qr').style.display = '';

    // Clear facility mode state
    if (activeFacility) {
        activeFacility = null;
        facilityBar.querySelectorAll('.facility-bar-btn').forEach(b => b.classList.remove('active'));
    }

    const lat = building.lat.toFixed(6);
    const lng = building.lng.toFixed(6);
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

    document.getElementById('panelName').textContent = building.name;

    const catEl = document.getElementById('panelCategory');
    catEl.textContent = building.category || 'building';
    catEl.setAttribute('data-cat', building.category || '');

    document.getElementById('panelDescription').textContent = building.description || '';
    document.getElementById('panelGrid').textContent = `Grid reference: ${building.grid}`;

    // Facilities
    const facilitiesEl = document.getElementById('panelFacilities');
    const facilities = building.facilities || [];
    const isAcademic = building.category === 'academic' || building.category === 'science';
    if (facilities.length > 0 || isAcademic) {
        let html = '<div class="facilities-title">Facilities</div><div class="facilities-grid">';
        facilities.forEach(f => { html += renderFacilityIcon(f); });
        if (isAcademic) {
            html += `<span class="facility-icon" title="Toilets" aria-label="Toilets"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6F7587" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${toiletIcon}</svg><span class="facility-label">Toilets</span></span>`;
        }
        html += '</div>';
        facilitiesEl.innerHTML = html;
        facilitiesEl.style.display = 'block';
    } else {
        facilitiesEl.innerHTML = '';
        facilitiesEl.style.display = 'none';
    }

    const link = document.getElementById('panelMapsLink');
    link.href = mapsUrl;

    // QR code
    const canvas = document.getElementById('qrCanvas');
    new QRious({
        element: canvas,
        value: mapsUrl,
        size: 100,
        foreground: '#033803',
        background: '#ffffff',
        level: 'M'
    });

    // Reset share button and navigation state
    document.getElementById('shareText').textContent = 'Share';
    document.getElementById('navigateText').textContent = 'Step-free navigation';
    clearRoute();

    infoPanel.classList.add('open');
    infoPanel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('panel-open');

    // Screen reader announcement
    srAnnounce.textContent = `${building.name} selected. ${building.category || 'Building'}. ${building.description || ''}`;

    // Resize map for desktop sidebar
    setTimeout(() => map.invalidateSize(), 50);
}

function closePanel() {
    // Move focus out before hiding to avoid aria-hidden-on-focused warning
    if (infoPanel.contains(document.activeElement)) {
        searchInput.focus();
    }
    infoPanel.classList.remove('open');
    infoPanel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('panel-open');
    setTimeout(() => map.invalidateSize(), 50);
}

// ── Share Button ───────────────────────────────────────────────
const panelShare = document.getElementById('panelShare');
const toast = document.getElementById('toast');

panelShare.addEventListener('click', () => {
    if (!selectedBuilding) return;
    const slug = selectedBuilding.slug || toSlug(selectedBuilding.name);
    const url = `${window.location.origin}${window.location.pathname}#building/${slug}`;

    if (navigator.share) {
        navigator.share({
            title: `${selectedBuilding.name} — Sussex Campus Map`,
            url: url
        }).catch(() => {});
    } else {
        navigator.clipboard.writeText(url).then(() => {
            const shareText = document.getElementById('shareText');
            shareText.textContent = 'Copied!';
            setTimeout(() => { shareText.textContent = 'Share'; }, 2000);
        }).catch(() => {
            showToast('Could not copy link');
        });
    }
});

function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

// ── Navigation Route ──────────────────────────────────────────
let routeLayer = null;
const routeInfo = document.getElementById('routeInfo');
const routeDistance = document.getElementById('routeDistance');
const routeClear = document.getElementById('routeClear');
const panelNavigate = document.getElementById('panelNavigate');

function drawRoute(result) {
    clearRoute();
    routeLayer = L.polyline(result.path, {
        color: '#3F77CA', weight: 10, opacity: 0.85,
        lineCap: 'round'
    }).addTo(map);

    const distText = result.distance >= 1000
        ? `${(result.distance / 1000).toFixed(1)} km`
        : `${Math.round(result.distance)} m`;
    routeDistance.textContent = distText;
    routeInfo.style.display = 'flex';
    document.getElementById('navigateText').textContent = 'Clear route';

    map.fitBounds(routeLayer.getBounds().pad(0.15), { animate: true });
}

function clearRoute() {
    if (routeLayer) {
        map.removeLayer(routeLayer);
        routeLayer = null;
    }
    if (routeInfo) routeInfo.style.display = 'none';
    const navText = document.getElementById('navigateText');
    if (navText) navText.textContent = 'Step-free navigation';
}

panelNavigate.addEventListener('click', () => {
    if (routeLayer) { clearRoute(); return; }

    if (!locationMarker) {
        if (locationDenied) {
            showToast('Location not granted. Please enable location in your browser settings.');
        } else {
            showToast('Requesting your location…');
        }
        map.locate({ watch: true, enableHighAccuracy: true, maxZoom: 18 });
        return;
    }

    // Check if user is near campus
    const campusBounds = L.latLngBounds(illustrationBounds);
    const paddedBounds = campusBounds.pad(0.5);
    if (!paddedBounds.contains(locationMarker.getLatLng())) {
        showToast('You are not on or near campus');
        return;
    }

    if (!selectedBuilding) return;

    const slug = selectedBuilding.slug || toSlug(selectedBuilding.name);
    const userLatLng = locationMarker.getLatLng();
    const result = findStepFreeRoute(userLatLng, slug);

    if (!result) {
        showToast('No step-free route found');
        return;
    }
    if (result.error === 'no-entrances') {
        showToast('No entrances found for this building');
        return;
    }

    switchLayer('map');
    drawRoute(result);
});

routeClear.addEventListener('click', clearRoute);

// ── Building Selection ─────────────────────────────────────────
function selectBuilding(building) {
    clearHighlight();

    selectedBuilding = building;
    searchInput.value = building.name;
    clearBtn.style.display = 'block';
    suggestionsEl.style.display = 'none';
    searchInput.setAttribute('aria-expanded', 'false');

    if (building.leafletPolygon) {
        highlightLayer = L.polygon(building.leafletPolygon.getLatLngs(), highlightPolyStyle).addTo(map);
        highlightLayer.on('click', (e) => { L.DomEvent.stopPropagation(e); });
    } else {
        highlightLayer = L.circleMarker(building.center, highlightMarkerStyle).addTo(map);
        highlightLayer.on('click', (e) => { L.DomEvent.stopPropagation(e); });
    }

    // Update URL hash
    const slug = building.slug || toSlug(building.name);
    history.replaceState(null, '', `#building/${slug}`);

    // Open panel first, then do a single map movement after resize
    showPanel(building);

    setTimeout(() => {
        map.invalidateSize();
        if (building.leafletPolygon) {
            map.fitBounds(building.leafletPolygon.getBounds().pad(0.5), { maxZoom: 17, animate: true });
        } else {
            map.setView(building.center, 17, { animate: true });
        }
    }, 50);
}

function panToBuildingVisible(building) {
    const targetLatLng = building.polyCenter || building.center;
    const isDesktop = window.innerWidth > 1024;

    if (isDesktop) {
        // Desktop: offset left to account for right sidebar
        const mapWidth = map.getContainer().offsetWidth;
        const point = map.latLngToContainerPoint(targetLatLng);
        const offsetPoint = L.point(point.x - 190, point.y);
        const offsetLatLng = map.containerPointToLatLng(offsetPoint);
        map.panTo(offsetLatLng, { animate: true, duration: 0.3 });
    } else {
        // Mobile/tablet: offset up to keep building above bottom sheet
        const containerHeight = map.getContainer().offsetHeight;
        const point = map.latLngToContainerPoint(targetLatLng);
        const offsetPoint = L.point(point.x, point.y + containerHeight / 8);
        const offsetLatLng = map.containerPointToLatLng(offsetPoint);
        map.panTo(offsetLatLng, { animate: true, duration: 0.3 });
    }
}

function clearHighlight() {
    if (highlightLayer) {
        map.removeLayer(highlightLayer);
        highlightLayer = null;
    }
}

function clearSelection() {
    clearHighlight();
    clearFacilityHighlights();
    clearRoute();
    activeFacility = null;
    facilityBar.querySelectorAll('.facility-bar-btn').forEach(b => b.classList.remove('active'));
    selectedBuilding = null;
    closePanel();
    history.replaceState(null, '', window.location.pathname);
}

// ── "What's here?" + Map Click ─────────────────────────────────
map.on('click', (e) => {
    if (map.getZoom() < 15) {
        clearSelection();
        return;
    }

    // Find nearest building within 50m
    let nearest = null;
    let nearestDist = Infinity;

    buildings.forEach(b => {
        const dist = e.latlng.distanceTo(b.center);
        if (dist < 50 && dist < nearestDist) {
            nearest = b;
            nearestDist = dist;
        }
    });

    if (nearest) {
        selectBuilding(nearest);
    } else {
        clearSelection();
    }
});

// ── Hash Routing (deep links) ──────────────────────────────────
function toSlug(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function handleHash() {
    const hash = window.location.hash;
    if (!hash.startsWith('#building/')) return;

    const slug = hash.slice('#building/'.length);
    const building = buildings.find(b => {
        const bSlug = b.slug || toSlug(b.name);
        return bSlug === slug;
    });

    if (building) {
        selectBuilding(building);
    } else {
        // Invalid slug — clear hash silently
        history.replaceState(null, '', window.location.pathname);
    }
}

window.addEventListener('hashchange', handleHash);

// ── Geolocation ────────────────────────────────────────────────
let locationMarker = null;
let locationDenied = false;

function startGeolocation() {
    map.locate({ watch: true, enableHighAccuracy: true, maxZoom: 18 });

    map.on('locationfound', (e) => {
        locationDenied = false;
        if (locationMarker) {
            locationMarker.setLatLng(e.latlng);
        } else {
            const dotIcon = L.divIcon({
                className: 'geolocation-dot',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });
            locationMarker = L.marker(e.latlng, { icon: dotIcon, interactive: false }).addTo(map);
        }
    });

    map.on('locationerror', (e) => {
        if (e.code === 1) locationDenied = true;
    });
}

startGeolocation();

// ── Close suggestions on outside click ─────────────────────────
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
        suggestionsEl.style.display = 'none';
        searchInput.setAttribute('aria-expanded', 'false');
    }
});

// ── Entrance Sequence ─────────────────────────────────────────
function playEntranceSequence() {
    if (hasDeepLink || prefersReducedMotion) {
        // Skip entrance — show everything immediately
        document.querySelectorAll('.search-container, .facility-bar, .layer-toggle, .accessibility-toggle, .leaflet-control-zoom').forEach(el => el.classList.add('ui-revealed'));
        handleHash();
        return;
    }

    // 1. Show title card
    const titleCard = document.createElement('div');
    titleCard.className = 'title-card';
    titleCard.setAttribute('aria-hidden', 'true');
    titleCard.innerHTML = '<div class="title-card-content"><img class="title-card-logo" src="https://upload.wikimedia.org/wikipedia/commons/3/34/University_of_Sussex_Logo.svg" alt="University of Sussex" /><div class="title-card-rule"></div><div class="title-card-sub">Online Campus Map</div></div>';
    document.body.appendChild(titleCard);

    // Fade in
    requestAnimationFrame(() => {
        titleCard.classList.add('visible');
    });

    // 2. After 0.8s visible, fade out title + start flyTo
    setTimeout(() => {
        titleCard.classList.remove('visible');
        titleCard.classList.add('fading');

        // Start flyTo as title fades
        setTimeout(() => {
            map.flyTo([50.8660, -0.0870], 17, { duration: 1.5 });
            titleCard.remove();
        }, 300);

        // 3. Staggered UI reveal after flyTo begins
        const delays = [
            { sel: '.search-container', delay: 800 },
            { sel: '.facility-bar', delay: 1000 },
            { sel: '.layer-toggle', delay: 1200 },
            { sel: '.accessibility-toggle', delay: 1200 },
            { sel: '.leaflet-control-zoom', delay: 1200 },
        ];

        delays.forEach(({ sel, delay }) => {
            setTimeout(() => {
                const el = document.querySelector(sel);
                if (el) el.classList.add('ui-revealed');
            }, delay);
        });
    }, 800);
}

// ── Building Hover Glow ──────────────────────────────────────
function setupHoverGlow() {
    buildings.forEach(b => {
        if (!b.leafletPolygon) return;

        b.leafletPolygon.on('mouseover', () => {
            if (selectedBuilding === b) return; // Already selected
            b.leafletPolygon.setStyle({ fillOpacity: 0.2, weight: 1.5, opacity: 0.6 });
            // Show label on hover (illustrated layer)
            if (b.labelMarker && !labelsLayer.hasLayer(b.labelMarker) && map.getZoom() < 15) {
                b._hoverLabel = true;
                labelsLayer.addLayer(b.labelMarker);
                if (!map.hasLayer(labelsLayer)) labelsLayer.addTo(map);
            }
        });

        b.leafletPolygon.on('mouseout', () => {
            if (selectedBuilding === b) return;
            const colors = getColors(b.category);
            b.leafletPolygon.setStyle({ fillOpacity: 0.05, weight: 0.5, opacity: 0.3 });
            // Remove hover label
            if (b._hoverLabel) {
                b._hoverLabel = false;
                if (map.getZoom() < 15) labelsLayer.removeLayer(b.labelMarker);
            }
        });
    });
}

// ── Search Spotlight ─────────────────────────────────────────
let spotlightOverlay = null;

function showSpotlight(building) {
    removeSpotlight();
    if (!building.polygon || prefersReducedMotion) return;

    // Create SVG mask with building polygon cutout
    const bounds = map.getBounds();
    const nw = map.latLngToLayerPoint(bounds.getNorthWest());
    const se = map.latLngToLayerPoint(bounds.getSouthEast());

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spotlight-svg');
    svg.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:401;`;

    // Convert polygon coords to pixel points
    const points = building.polygon.map(([lat, lng]) => {
        const p = map.latLngToContainerPoint(L.latLng(lat, lng));
        return `${p.x},${p.y}`;
    }).join(' ');

    svg.innerHTML = `
        <defs>
            <mask id="spotlight-mask">
                <rect width="100%" height="100%" fill="white"/>
                <polygon points="${points}" fill="black"/>
            </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.35)" mask="url(#spotlight-mask)" class="spotlight-dim"/>
    `;

    map.getContainer().appendChild(svg);
    spotlightOverlay = svg;

    // Fade in
    requestAnimationFrame(() => svg.classList.add('active'));

    // Update mask on map movement
    const updateMask = () => {
        if (!spotlightOverlay || !building.polygon) return;
        const pts = building.polygon.map(([lat, lng]) => {
            const p = map.latLngToContainerPoint(L.latLng(lat, lng));
            return `${p.x},${p.y}`;
        }).join(' ');
        const poly = svg.querySelector('polygon');
        if (poly) poly.setAttribute('points', pts);
    };
    map.on('move zoom viewreset', updateMask);
    svg._updateMask = updateMask;
    svg._mapRef = map;
}

function removeSpotlight() {
    if (spotlightOverlay) {
        spotlightOverlay._mapRef.off('move zoom viewreset', spotlightOverlay._updateMask);
        spotlightOverlay.remove();
        spotlightOverlay = null;
    }
}

// Patch selectBuilding to add spotlight
const _origSelectBuilding = selectBuilding;
selectBuilding = function(building) {
    _origSelectBuilding(building);
    showSpotlight(building);
};

// Patch clearSelection to remove spotlight
const _origClearSelection = clearSelection;
clearSelection = function() {
    removeSpotlight();
    _origClearSelection();
};

// ── Init: handle deep link on page load ────────────────────────
playEntranceSequence();
if (hasDeepLink) handleHash();
setupHoverGlow();
})();
