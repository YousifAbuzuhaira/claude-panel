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

/** Every helper event (ready, status, chat.delta, chat.tool, chat.done, chat.error, fatal). */
export function onEvents(handler) {
  const source = new EventSource(`/api/events?token=${token}`);
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

/** Pages link to each other with the token carried along. */
export const withToken = path => `${path}#token=${token}`;
