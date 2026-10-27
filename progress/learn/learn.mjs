// Learn's helper, run in WSL (through learn.sh, which finds Node and claude).
//
//   learn.sh serve                                   the window's JSON-lines channel
//   learn.sh build start --topic "DevOps" --category DevOps [--mode pick|auto] | --link <url>
//   learn.sh build run|pick|resume|cancel <job> [s1,s3]
//   learn.sh build list
//   learn.sh settings get | set key=value ...        (library=, build=, chat=, work=a:b)
//   learn.sh deps install                             yt-dlp, fetched and checked
//   learn.sh library | status | transcript <url> | ping
import { cancelJob, createJob, listJobs, pickSources, resumeJob, runJob, startDaemon } from './build.mjs';
import { runClaude } from './claude.mjs';
import { ensureYtDlp } from './deps.mjs';
import { courseSummary, listCourses, openLibrary, readCatalogue, readStatus } from './library.mjs';
import { serve } from './serve.mjs';
import { readSettings, writeSettings } from './settings.mjs';
import { transcriptText, youTubeId, ytCaptions } from './sources.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [command, sub, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
}
const print = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

function fail(message) {
  console.error(`learn: ${message}`);
  process.exit(1);
}

try {
  if (command === 'serve') {
    serve();
  } else if (command === 'build') {
    const lib = openLibrary();
    if (sub === 'start') {
      const job = createJob(lib, { topic: flags.topic, category: flags.category, mode: flags.mode, link: flags.link });
      startDaemon(lib, job.id);
      print(job.id);
    } else if (sub === 'run') {
      await runJob(lib, rest[0]);
      process.exit(0);
    } else if (sub === 'pick') {
      pickSources(lib, rest[0], String(rest[1] || '').split(','));
    } else if (sub === 'resume') {
      resumeJob(lib, rest[0]);
    } else if (sub === 'cancel') {
      cancelJob(lib, rest[0]);
    } else if (sub === 'list') {
      for (const job of listJobs(lib)) print(`${job.id}  ${job.state.padEnd(13)} ${job.step.padEnd(9)} ${job.done}/${job.total}  ${job.topic}  ${job.message || ''}`);
    } else fail('build start|run|pick|resume|cancel|list');
  } else if (command === 'settings') {
    if (sub === 'set') {
      const change = {};
      for (const pair of rest) {
        const [key, ...value] = pair.split('=');
        const text = value.join('=');
        if (key === 'library') change.library = text;
        else if (key === 'build' || key === 'chat') change.models = { ...(change.models || {}), [key]: text };
        else if (key === 'work') change.workFolders = text ? text.split(':') : [];
        else if (key === 'claude') change.claudePath = text || null;
        else fail(`unknown setting ${key}`);
      }
      print(writeSettings(change));
    } else print(readSettings());
  } else if (command === 'deps') {
    print(await ensureYtDlp({ force: sub === 'install', onProgress: console.log }));
  } else if (command === 'library') {
    const lib = openLibrary();
    const catalogue = readCatalogue(lib);
    print({ library: lib.root, categories: catalogue.categories, concepts: catalogue.concepts.length, courses: listCourses(lib).map(course => courseSummary(course, catalogue)) });
  } else if (command === 'status') {
    print(readStatus());
  } else if (command === 'transcript') {
    const id = youTubeId(sub);
    if (!id) fail('transcript <youtube url>');
    const result = await ytCaptions(id, join(tmpdir(), 'claude-learn-captions'));
    print(result.chunks ? transcriptText(result.chunks.slice(0, 20)) : `no transcript: ${result.reason}`);
  } else if (command === 'ping') {
    const result = await runClaude({ prompt: 'Reply with the single word: pong', model: readSettings().models.chat, tools: [] }).done;
    print({ text: result.text, sessionId: result.sessionId });
  } else {
    fail('serve | build | settings | deps | library | status | transcript | ping');
  }
} catch (error) {
  fail(error.message || String(error));
}
