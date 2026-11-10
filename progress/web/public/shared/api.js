// The pages' one way to the server (web/server.mjs): the token from the URL's #hash,
// kept in sessionStorage so a reload or an in-app link still has it.
const TOKEN_KEY = 'claude-panel-token';

function readToken() {
  const match = /(?:^#|&)token=([0-9a-f]{64})/.exec(location.hash);
  if (match) {
    try { sessionStorage.setItem(TOKEN_KEY, match[1]); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    return match[1];
  }
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export const token = readToken();

/** One contract-2 request (no rid): resolves the result, rejects with the helper's error. */
export async function rpc(cmd, args = {}) {
  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Learn-Token': token },
    body: JSON.stringify({ ...args, cmd }),
  });
  const answer = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!answer.ok) throw new Error(answer.error || `HTTP ${response.status}`);
  return answer.result;
}

/** A document for a new course, sent as it is: resolves `{ path, name, size }` on the server. */
export async function upload(file) {
  const response = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'X-Learn-Token': token, 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const answer = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!answer.ok) throw new Error(answer.error || `HTTP ${response.status}`);
  return answer;
}

/** A small JSON answer from the server (GET), or null. */
export async function getJson(path) {
  try {
    const response = await fetch(path, { headers: { 'X-Learn-Token': token } });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * Every helper event (ready, status, chat.delta, chat.tool, chat.done, chat.error, fatal), and
 * the server's own: `server` (its version, first on every connection) and, for Learn, `navigate`.
 * `page` names this page ('learn'), so the server can send an open Learn where it's asked to go.
 */
export function onEvents(handler, page = '') {
  const source = new EventSource(`/api/events?token=${token}${page ? `&page=${encodeURIComponent(page)}` : ''}`);
  source.onmessage = message => {
    try { handler(JSON.parse(message.data)); } catch {}
  };
  return source;
}

/** A game's save, or null. */
export async function loadSave(game) {
  try {
    const response = await fetch(`/api/save/${game}`, { headers: { 'X-Learn-Token': token } });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function writeSave(game, value) {
  try {
    await fetch(`/api/save/${game}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Learn-Token': token },
      body: JSON.stringify(value),
    });
  } catch {}
}

/**
 * In the macOS window app: opens another page ('learn', 'games', 'games/chess') in a window of
 * its own, or brings it forward. False where there's no window app; the page then links.
 * `from` is this page ('learn', 'games/chess'), so the new window follows this one's terminal.
 */
export async function openWindow(page, extra = {}) {
  const from = location.pathname.replace(/^\/+|\/+$/g, '');
  try {
    const response = await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Learn-Token': token },
      body: JSON.stringify({ ...extra, page, from }),
    });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

/** Pages link to each other with the token carried along. */
export const withToken = path => `${path}#token=${token}`;
