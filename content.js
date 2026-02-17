(function () {
  'use strict';

  let currentActivityId = null;
  let fitData = null;
  let panel = null;
  let allLapStats = [];

  // ── ZIP Extraction ──

  async function extractFitFromZip(zipBytes) {
    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

    // Find End of Central Directory (search backwards)
    let eocdOffset = -1;
    for (let i = zipBytes.length - 22; i >= Math.max(0, zipBytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) throw new Error('Invalid ZIP file');

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdEntries = view.getUint16(eocdOffset + 10, true);

    let offset = cdOffset;
    for (let i = 0; i < cdEntries; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error('Invalid central directory');
      }

      const method = view.getUint16(offset + 10, true);
      const compSize = view.getUint32(offset + 20, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);

      const name = new TextDecoder().decode(
        zipBytes.slice(offset + 46, offset + 46 + nameLen)
      );
      offset += 46 + nameLen + extraLen + commentLen;

      if (name.toLowerCase().endsWith('.fit')) {
        const localNameLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const compressed = zipBytes.slice(dataStart, dataStart + compSize);

        if (method === 0) return compressed;
        if (method === 8) return await inflateRaw(compressed);
        throw new Error(`Unsupported compression method: ${method}`);
      }
    }
    throw new Error('No .fit file found in ZIP');
  }

  async function inflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();

    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) {
      result.set(chunk, off);
      off += chunk.length;
    }
    return result;
  }

  // ── Fetch via page context (postMessage to page-fetch.js in MAIN world) ──

  function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function fetchActivityData(activityId) {
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2);
      const handler = (event) => {
        if (event.source !== window) return;
        if (event.data?.type !== 'GLA_FETCH_RESPONSE') return;
        if (event.data.requestId !== requestId) return;
        window.removeEventListener('message', handler);
        if (event.data.success) {
          resolve({ format: event.data.format, data: event.data.data });
        } else {
          reject(new Error(event.data.error));
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'GLA_FETCH_REQUEST', activityId, requestId }, '*');
    });
  }

  function isZip(bytes) {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4B &&
           bytes[2] === 0x03 && bytes[3] === 0x04;
  }

  function isFit(bytes) {
    // FIT signature at byte 8: ".FIT"
    return bytes.length > 12 && bytes[8] === 0x2E && bytes[9] === 0x46 &&
           bytes[10] === 0x49 && bytes[11] === 0x54;
  }

  // ── Parse Garmin JSON API response into same format as FIT ──

  function parseJsonActivity(jsonStr) {
    const { details, splits } = JSON.parse(jsonStr);
    const messages = { lap: [], record: [] };

    // Parse metric descriptors to find column indices
    const descriptors = details.metricDescriptors || [];
    const idx = {};
    for (const d of descriptors) {
      idx[d.metricsIndex] = d.key;
    }

    // Parse per-second records
    const metrics = details.activityDetailMetrics || details.geoPolylineDTO?.metrics || [];
    for (const m of metrics) {
      const vals = m.metrics || [];
      const record = {};
      for (let i = 0; i < vals.length; i++) {
        const key = idx[i];
        if (key === 'directTimestamp') record.timestamp = vals[i] / 1000; // ms -> s
        if (key === 'directHeartRate') record.heart_rate = vals[i];
        if (key === 'directDistance') record.distance = vals[i]; // already in meters
        if (key === 'directSpeed') record.speed = vals[i]; // m/s
      }
      if (record.timestamp != null) messages.record.push(record);
    }

    // Parse laps from splits
    const lapSplits = splits?.lapDTOs || splits || [];
    for (const lap of lapSplits) {
      messages.lap.push({
        start_time: (lap.startTimeGMT != null)
          ? new Date(lap.startTimeGMT).getTime() / 1000
          : lap.startTimeInSeconds,
        timestamp: (lap.startTimeGMT != null)
          ? new Date(lap.startTimeGMT).getTime() / 1000 + (lap.duration || lap.elapsedDuration || 0)
          : (lap.startTimeInSeconds || 0) + (lap.duration || lap.elapsedDuration || 0),
        total_timer_time: lap.duration || lap.elapsedDuration || 0,
        total_distance: lap.distance || 0,
        avg_heart_rate: lap.averageHR || lap.averageHeartRate || null,
        max_heart_rate: lap.maxHR || lap.maxHeartRate || null,
        avg_speed: lap.averageSpeed || null,
      });
    }

    console.log('[GLA] Metric keys:', Object.values(idx).join(', '));
    if (messages.record.length > 0) {
      const r0 = messages.record[0];
      const rN = messages.record[messages.record.length - 1];
      console.log('[GLA] First record:', JSON.stringify(r0));
      console.log('[GLA] Last record:', JSON.stringify(rN));
      console.log('[GLA] Records with HR:', messages.record.filter(r => r.heart_rate != null).length);
      console.log('[GLA] Records with dist:', messages.record.filter(r => r.distance != null).length);
    }
    if (messages.lap.length > 0) {
      console.log('[GLA] First lap:', JSON.stringify(messages.lap[0]));
    }
    console.log('[GLA] JSON parsed:', messages.record.length, 'records,', messages.lap.length, 'laps');
    return messages;
  }

  // ── Stats Computation ──

  function computeLapStats(laps, records) {
    // Build cumulative distance boundaries for each lap
    let cumDist = 0;
    const lapBounds = laps.map((lap) => {
      const start = cumDist;
      cumDist += lap.total_distance || 0;
      return { start, end: cumDist };
    });

    // Sort records by distance (should already be ordered)
    const sortedRecords = records
      .filter((r) => r.distance != null)
      .sort((a, b) => a.distance - b.distance);

    return laps.map((lap, index) => {
      const bound = lapBounds[index];

      // Match records to lap by cumulative distance (tolerance of 10m)
      let lapRecords = sortedRecords.filter(
        (r) => r.distance >= bound.start - 10 && r.distance <= bound.end + 10
      );

      // Fallback: match by timestamp if distance matching found nothing
      if (lapRecords.length === 0 && lap.start_time != null && lap.timestamp != null) {
        lapRecords = records.filter(
          (r) => r.timestamp != null && r.timestamp >= lap.start_time && r.timestamp <= lap.timestamp
        );
      }

      // HR from raw records
      const hrRecords = lapRecords.filter((r) => r.heart_rate != null && r.heart_rate > 0);
      const hrValues = hrRecords.map((r) => r.heart_rate);

      let minHR, maxHR, avgHR, timeToMinHR;
      if (hrValues.length > 0) {
        minHR = Math.min(...hrValues);
        maxHR = Math.max(...hrValues);
        avgHR = Math.round(hrValues.reduce((s, v) => s + v, 0) / hrValues.length);

        // Find first record where HR equals minHR, compute seconds from lap start
        const minHRRecord = hrRecords.find((r) => r.heart_rate === minHR);
        if (minHRRecord != null && minHRRecord.timestamp != null && lap.start_time != null) {
          timeToMinHR = Math.round(minHRRecord.timestamp - lap.start_time);
        } else {
          timeToMinHR = null;
        }
      } else {
        // Fallback to lap summary (min HR unavailable from summary)
        minHR = null;
        maxHR = lap.max_heart_rate || null;
        avgHR = lap.avg_heart_rate || null;
        timeToMinHR = null;
      }

      // Distance from lap summary
      const totalDistance = lap.total_distance || 0;

      // Elapsed time — prefer total_timer_time (excludes pauses)
      const startTime = lap.start_time;
      const endTime = lap.timestamp;
      const elapsedTime = lap.total_timer_time || (endTime - startTime) || 0;

      // Avg pace (seconds per km)
      let avgPace = null;
      if (totalDistance > 0 && elapsedTime > 0) {
        avgPace = (elapsedTime / totalDistance) * 1000;
      }

      console.log(`[GLA] Lap ${index + 1}: ${lapRecords.length} records, ${hrValues.length} HR values, dist ${bound.start.toFixed(0)}-${bound.end.toFixed(0)}m`);

      return {
        lapNumber: index + 1,
        totalDistance,
        avgPace,
        minHR,
        maxHR,
        avgHR,
        timeToMinHR,
        elapsedTime,
      };
    });
  }

  function formatPace(seconds) {
    if (seconds == null || !isFinite(seconds) || seconds <= 0) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function formatDist(meters) {
    if (meters == null || meters === 0) return '  --  ';
    return (meters / 1000).toFixed(2);
  }

  function generateStatsText(stats) {
    if (stats.length === 0) return 'No laps selected.';

    const header = 'Lap  | Distance  | Avg Pace  | Min HR | Max HR | Avg HR | Min HR @';
    const sep = '-----|-----------|-----------|--------|--------|--------|----------';

    const rows = stats.map((s) => {
      const lap = s.lapNumber.toString().padStart(3);
      const dist = (formatDist(s.totalDistance) + ' km').padStart(9);
      const pace = (formatPace(s.avgPace) + '/km').padStart(9);
      const mi = (s.minHR != null ? String(s.minHR) : '--').padStart(6);
      const mx = (s.maxHR != null ? String(s.maxHR) : '--').padStart(6);
      const av = (s.avgHR != null ? String(s.avgHR) : '--').padStart(6);
      const at = (s.timeToMinHR != null ? formatPace(s.timeToMinHR) : '--:--').padStart(8);
      return ` ${lap} | ${dist} | ${pace} | ${mi} | ${mx} | ${av} | ${at}`;
    });

    return [header, sep, ...rows].join('\n');
  }

  // ── UI ──

  function createPanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.id = 'gla-panel';
    panel.innerHTML = `
      <div class="gla-panel-inner">
        <div class="gla-header">
          <h2>Lap Analyzer</h2>
          <button class="gla-close">&times;</button>
        </div>
        <div class="gla-content">
          <div class="gla-loading" id="gla-loading">
            <div class="gla-spinner"></div>
            <span id="gla-loading-text">Loading...</span>
          </div>
          <div class="gla-error" id="gla-error" style="display:none"></div>
          <div id="gla-laps" style="display:none">
            <div class="gla-lap-controls">
              <button id="gla-select-all">Select All</button>
              <button id="gla-deselect-all">Deselect All</button>
            </div>
            <div class="gla-lap-list" id="gla-lap-list"></div>
          </div>
          <div class="gla-output" id="gla-output" style="display:none">
            <h3>Stats (from raw FIT data)</h3>
            <pre id="gla-stats-text"></pre>
            <button id="gla-copy" class="gla-copy-btn">Copy to Clipboard</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector('.gla-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    panel.addEventListener('click', (e) => {
      if (e.target === panel) panel.style.display = 'none';
    });
  }

  function showLoading(text) {
    const el = (id) => document.getElementById(id);
    const loading = el('gla-loading');
    if (loading) {
      loading.style.display = 'flex';
      el('gla-loading-text').textContent = text;
    }
    const err = el('gla-error');
    if (err) err.style.display = 'none';
    const laps = el('gla-laps');
    if (laps) laps.style.display = 'none';
    const out = el('gla-output');
    if (out) out.style.display = 'none';
  }

  function showError(msg) {
    const loading = document.getElementById('gla-loading');
    if (loading) loading.style.display = 'none';
    const err = document.getElementById('gla-error');
    if (err) {
      err.style.display = 'block';
      err.textContent = msg;
    }
  }

  function displayLaps() {
    document.getElementById('gla-loading').style.display = 'none';
    document.getElementById('gla-laps').style.display = 'block';
    document.getElementById('gla-output').style.display = 'block';

    const laps = fitData.lap || [];
    const records = fitData.record || [];

    if (laps.length === 0) {
      showError('No laps found in this activity.');
      return;
    }

    allLapStats = computeLapStats(laps, records);

    const list = document.getElementById('gla-lap-list');
    list.innerHTML = '';
    allLapStats.forEach((s, i) => {
      const label = document.createElement('label');
      label.className = 'gla-lap-item';
      const duration = formatPace(s.elapsedTime);
      label.innerHTML = `
        <input type="checkbox" class="gla-lap-checkbox" data-index="${i}" checked>
        <span class="gla-lap-label">
          Lap ${s.lapNumber} &mdash; ${formatDist(s.totalDistance)} km, ${duration}
        </span>
      `;
      list.appendChild(label);
    });

    list.addEventListener('change', updateStats);

    document.getElementById('gla-select-all').addEventListener('click', () => {
      list.querySelectorAll('.gla-lap-checkbox').forEach((cb) => (cb.checked = true));
      updateStats();
    });
    document.getElementById('gla-deselect-all').addEventListener('click', () => {
      list.querySelectorAll('.gla-lap-checkbox').forEach((cb) => (cb.checked = false));
      updateStats();
    });
    document.getElementById('gla-copy').addEventListener('click', copyStats);

    updateStats();
  }

  function updateStats() {
    const checked = document.querySelectorAll('.gla-lap-checkbox:checked');
    const indices = Array.from(checked).map((cb) => parseInt(cb.dataset.index));
    const selected = indices.map((i) => allLapStats[i]);
    document.getElementById('gla-stats-text').textContent = generateStatsText(selected);
  }

  function copyStats() {
    const text = document.getElementById('gla-stats-text').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('gla-copy');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = orig), 2000);
    });
  }

  // ── FAB & Init ──

  function showFab() {
    if (document.getElementById('gla-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'gla-fab';
    fab.textContent = '\u2665 Lap Stats';
    fab.addEventListener('click', openAnalyzer);
    document.body.appendChild(fab);
  }

  function hideFab() {
    const el = document.getElementById('gla-fab');
    if (el) el.remove();
  }

  async function openAnalyzer() {
    createPanel();
    panel.style.display = 'flex';

    if (fitData) {
      displayLaps();
      return;
    }

    showLoading('Fetching activity data...');

    try {
      const result = await fetchActivityData(currentActivityId);

      if (result.format === 'json') {
        showLoading('Parsing activity data...');
        fitData = parseJsonActivity(result.data);
      } else {
        // Binary FIT/ZIP
        const rawBytes = base64ToUint8Array(result.data);
        console.log('[GLA] Downloaded', rawBytes.length, 'bytes');

        let fitBytes;
        if (isZip(rawBytes)) {
          showLoading('Extracting FIT from ZIP...');
          fitBytes = await extractFitFromZip(rawBytes);
        } else if (isFit(rawBytes)) {
          fitBytes = rawBytes;
        } else {
          const preview = new TextDecoder().decode(rawBytes.slice(0, 200));
          throw new Error(`Unexpected file format (${rawBytes.length} bytes). Preview: ${preview.slice(0, 100)}`);
        }

        showLoading('Parsing FIT file...');
        const parser = new FitParser(fitBytes);
        fitData = parser.parse();
        console.log('[GLA] FIT parsed:', Object.keys(fitData).map(k => `${k}: ${fitData[k].length}`).join(', '));
      }

      displayLaps();
    } catch (err) {
      console.error('[GLA] Error:', err);
      showError(err.message);
    }
  }

  function checkForActivity() {
    const match = window.location.href.match(/\/(?:modern\/|app\/)?activity\/(\d+)/);
    const id = match ? match[1] : null;

    if (id && id !== currentActivityId) {
      currentActivityId = id;
      fitData = null;
      allLapStats = [];
      if (panel) {
        panel.remove();
        panel = null;
      }
      showFab();
    } else if (!id && currentActivityId) {
      currentActivityId = null;
      fitData = null;
      allLapStats = [];
      hideFab();
      if (panel) {
        panel.remove();
        panel = null;
      }
    }
  }

  checkForActivity();
  setInterval(checkForActivity, 1500);
})();
