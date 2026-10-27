// Every call to Claude goes through here: a headless `claude -p` on the person's own
// subscription. The flags keep it a clean room: no plugins or hooks (so this mod doesn't
// load inside it), no CLAUDE.md, no MCP servers, no Bash, and only the tools named.
// The prompt goes in on stdin: `--tools` takes several values and would swallow it.
import { spawn } from 'node:child_process';
import { claudeBinary, readSettings } from './settings.mjs';

const BASE = ['-p', '--safe-mode', '--restricted', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--output-format', 'stream-json', '--verbose'];

export function claudeArgs({ model, tools = [], schema = null, resume = null, systemFile = null, addDirs = [], stream = false, persist = false }) {
  const args = [...BASE, '--model', model];
  for (const dir of addDirs) args.push('--add-dir', dir);
  // Named in --tools to exist, in --allowedTools to run without asking.
  args.push('--tools', tools.join(','));
  if (tools.length) args.push('--allowedTools', tools.join(','));
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (resume) args.push('--resume', resume);
  else if (systemFile) args.push('--append-system-prompt-file', systemFile);
  if (stream) args.push('--include-partial-messages');
  if (!persist) args.push('--no-session-persistence');
  return args;
}

/** One stream-json line, reduced to what Learn uses; null for the rest. */
export function readStreamLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'stream_event') {
    const delta = value.event?.type === 'content_block_delta' ? value.event.delta : null;
    return delta?.type === 'text_delta' && delta.text ? { delta: delta.text } : null;
  }
  if (value.type === 'system' && value.subtype === 'init') return { sessionId: value.session_id, model: value.model };
  if (value.type === 'rate_limit_event') return { rateLimit: value.rate_limit_info || null };
  if (value.type === 'assistant') {
    const uses = (value.message?.content || []).filter(part => part.type === 'tool_use' && part.name !== 'StructuredOutput');
    return uses.length ? { tools: uses.map(part => ({ name: part.name, input: part.input || {} })) } : null;
  }
  if (value.type === 'result') {
    const isError = Boolean(value.is_error) || value.subtype !== 'success';
    return {
      result: {
        isError,
        text: typeof value.result === 'string' ? value.result : '',
        structured: value.structured_output ?? null,
        sessionId: value.session_id || null,
        error: isError ? (typeof value.result === 'string' && value.result) || value.subtype || 'Claude failed' : null,
      },
    };
  }
  return null;
}

/** What a tool call is doing, in a few words, for a progress line. */
export function describeTool({ name, input }) {
  if (name === 'WebSearch') return `Searching: ${String(input.query || '').slice(0, 60)}`;
  if (name === 'WebFetch') return `Reading ${String(input.url || '').replace(/^https?:\/\//, '').slice(0, 60)}`;
  if (name === 'Read' || name === 'Glob' || name === 'Grep') return `Looking at ${String(input.file_path || input.pattern || input.path || '').split('/').slice(-2).join('/').slice(0, 60)}`;
  return name;
}

/** Every run still going in this process, so a cancel can stop them all. */
export const running = new Set();

export function stopAll() {
  for (const run of running) run.stop();
}

/**
 * Runs one Claude turn. Returns `{ done, stop }`: `done` resolves to the result
 * (`{ text, structured, sessionId }`) or rejects with Claude's own error text.
 */
export function runClaude(options) {
  const run = startClaude(options);
  running.add(run);
  run.done.then(() => running.delete(run), () => running.delete(run));
  return run;
}

function startClaude({ prompt, model, tools, schema, resume, systemFile, addDirs, cwd, stream, persist, timeoutMs = 20 * 60_000, onDelta, onTool, onRateLimit }) {
  const settings = readSettings();
  const args = claudeArgs({ model: model || settings.models.build, tools, schema, resume, systemFile, addDirs, stream, persist });
  const child = spawn(claudeBinary(settings), args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, CLAUDE_PROGRESS_OFF: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stopped = false;
  const done = new Promise((resolve, reject) => {
    let pending = '';
    let stderr = '';
    let result = null;
    let sessionId = null;
    const timer = setTimeout(() => {
      stopped = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const take = line => {
      const read = readStreamLine(line);
      if (!read) return;
      if (read.sessionId) sessionId = read.sessionId;
      if (read.delta && onDelta) onDelta(read.delta);
      if (read.tools && onTool) for (const tool of read.tools) onTool(tool);
      if (read.rateLimit && onRateLimit) onRateLimit(read.rateLimit);
      if (read.result) result = read.result;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      const lines = (pending + text).split('\n');
      pending = lines.pop();
      for (const line of lines) if (line.trim()) take(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { stderr = (stderr + text).slice(-4000); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`can't start claude: ${error.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (pending.trim()) take(pending);
      if (result && !result.isError) return resolve({ ...result, sessionId: result.sessionId || sessionId });
      if (stopped) return reject(Object.assign(new Error('stopped'), { stopped: true }));
      const message = result?.error || stderr.trim().split('\n').pop() || 'claude exited without an answer';
      reject(new Error(message));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
  return {
    done,
    stop() {
      stopped = true;
      child.kill('SIGTERM');
    },
  };
}

/** A structured call: the schema's object, or an error. */
export async function askStructured(options) {
  const { structured, text } = await runClaude({ ...options, tools: options.tools || [] }).done;
  if (structured && typeof structured === 'object') return structured;
  // Some answers arrive as JSON text instead.
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Claude did not return the expected structure');
  }
}
