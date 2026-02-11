// Runs in MAIN world at document_start.
// Captures Garmin's CSRF token and headers from XHR requests,
// then uses /gc-api prefix + same headers for our requests.

let csrfToken = null;
let appVer = null;
let appLang = null;

// ── Intercept XHR to capture CSRF token and other headers ──
const _origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  if (name === 'Connect-Csrf-Token' && value) csrfToken = value;
  if (name === 'X-app-ver' && value) appVer = value;
  if (name === 'X-lang' && value) appLang = value;
  return _origXHRSetHeader.apply(this, arguments);
};

// ── Helpers ──
const _origFetch = window.fetch;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
}

function garminFetch(path) {
  const headers = {
    'NK': 'NT',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrfToken) headers['Connect-Csrf-Token'] = csrfToken;
  if (appVer) headers['X-app-ver'] = appVer;
  if (appLang) headers['X-lang'] = appLang;

  console.log('[GLA] Fetch:', path, '| CSRF:', !!csrfToken);
  return _origFetch(path, { headers, credentials: 'same-origin' });
}

// ── Handle requests from content script ──
window.addEventListener('message', async (event) => {
  if (event.source !== window || event.data?.type !== 'GLA_FETCH_REQUEST') return;

  const { activityId, requestId } = event.data;

  try {
    // Wait for Garmin's page to make its initial XHR calls so we capture the CSRF token
    if (!csrfToken) {
      console.log('[GLA] Waiting for CSRF token capture...');
      for (let i = 0; i < 10 && !csrfToken; i++) await new Promise(r => setTimeout(r, 500));
    }
    if (!csrfToken) {
      throw new Error('Could not capture CSRF token. Please reload the page and try again.');
    }

    console.log('[GLA] CSRF token captured, attempting download...');

    // Strategy 1: FIT file download via /gc-api
    const fitResp = await garminFetch(`/gc-api/download-service/files/activity/${activityId}`);
    const fitCt = fitResp.headers.get('content-type') || '';
    console.log('[GLA] FIT:', fitResp.status, fitCt);

    if (fitResp.ok && !fitCt.includes('html')) {
      const buf = await fitResp.arrayBuffer();
      window.postMessage({
        type: 'GLA_FETCH_RESPONSE', requestId,
        success: true, format: 'binary',
        data: toBase64(new Uint8Array(buf)),
      }, '*');
      return;
    }

    // Strategy 2: JSON API
    console.log('[GLA] FIT download failed (' + fitResp.status + '), trying JSON API...');
    const [dResp, sResp] = await Promise.all([
      garminFetch(`/gc-api/activity-service/activity/${activityId}/details?maxChartSize=100000&maxPolylineSize=100000`),
      garminFetch(`/gc-api/activity-service/activity/${activityId}/splits`),
    ]);
    console.log('[GLA] Details:', dResp.status, '| Splits:', sResp.status);

    if (!dResp.ok || !sResp.ok) {
      throw new Error(
        `API failed: FIT=${fitResp.status}, Details=${dResp.status}, Splits=${sResp.status}. ` +
        `CSRF: ${!!csrfToken}. Try refreshing the page.`
      );
    }

    const details = await dResp.json();
    const splits = await sResp.json();
    window.postMessage({
      type: 'GLA_FETCH_RESPONSE', requestId,
      success: true, format: 'json',
      data: JSON.stringify({ details, splits }),
    }, '*');
  } catch (e) {
    console.error('[GLA]', e);
    window.postMessage({
      type: 'GLA_FETCH_RESPONSE', requestId,
      success: false, error: e.message,
    }, '*');
  }
});
