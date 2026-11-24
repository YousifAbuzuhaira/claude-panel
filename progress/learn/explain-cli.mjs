// The explain plugin's helper: everything /explain needs, and nothing of courses. Run through
// learn.sh (which finds Node 22), which runs this when there's no learn.mjs beside it. A leading
// `explain` is taken off, so the explain plugin calls it as the progress plugin calls learn.mjs.
//
//   learn.sh explain start --session <id> --cwd <dir> [--wiki personal|shared]   a plan on stdin: one line of JSON, the explainer started or what to fix
//   learn.sh explain run <job>                          an explainer's job, run here (start runs it on its own)
//   learn.sh explain export <id> | --all                an explainer as one file in ~/explainers (LEARN_EXPORT_DIR)
//   learn.sh explain voice                              one line of JSON: the voice ready, to set up (its size), or why it can't run here
//   learn.sh explain latest [id]                        one line of JSON: that explainer (or the newest with a clip), its file written if it's gone
//   learn.sh explain resume [id]                        one line of JSON: whether a job is making what's missing of it (started if none is); with no id, the newest with clips missing
//   learn.sh explain stop [id]                          one line of JSON: the job making it (or the newest going on) stopped, its clips kept
//   learn.sh explain wiki [id | on | off]               one line of JSON: one that asked for the wiki, sent again if it isn't there; or whether /explain asks
//   learn.sh explain model [name]                       one line of JSON: the model that writes the clips, set when a name is given
import { existsSync } from 'node:fs';
import { exportExplainer } from './export.mjs';
import { clipCounts, listExplainers, readExplainer } from './explain.mjs';
import { explainJob, runExplainJob, startExplainer } from './explain-job.mjs';
import { isJobLive, listJobs, stopJob } from './jobs.mjs';
import { MODELS, isModel, readSettings, writeSettings } from './settings.mjs';
import { openLibrary } from './status.mjs';
import { voiceStatus } from './voice.mjs';
import { wikiCommand } from './wiki.mjs';

const argv = process.argv.slice(2);
const [command, ...rest] = argv[0] === 'explain' ? argv.slice(1) : argv;
const flags = {};
const words = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  else words.push(rest[i]);
}
const line = value => console.log(JSON.stringify(value));
const fail = text => {
  console.error(`explain: ${text}`);
  process.exit(1);
};

try {
  if (command === 'start') {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    let plan;
    try {
      plan = JSON.parse(input);
    } catch {
      fail('the plan on stdin is not JSON');
    }
    const started = await startExplainer(openLibrary(), { plan, sessionId: flags.session, cwd: flags.cwd, wiki: flags.wiki });
    line(started.problems ? { ok: false, problems: started.problems } : { ok: true, id: started.id, clips: started.clips, wanted: started.wanted, depth: started.depth, wiki: started.wiki });
  } else if (command === 'run') {
    if (!words[0]) fail('run <job>');
    await runExplainJob(openLibrary(), words[0]);
  } else if (command === 'export') {
    const lib = openLibrary();
    const ids = flags.all ? listExplainers(lib).map(item => item.id) : words;
    if (!ids.length) fail('export <id> | --all');
    for (const id of ids) {
      const done = exportExplainer(lib, id);
      console.log(done ? `${id}  ${done.clips} clip${done.clips === 1 ? '' : 's'}  ${(done.bytes / 1e6).toFixed(1)} MB  ${done.file}` : `${id}  no clip made yet`);
    }
  } else if (command === 'voice') {
    line(voiceStatus());
  } else if (command === 'latest') {
    const lib = openLibrary();
    const jobs = listJobs(lib);
    const found = listExplainers(lib, jobs).find(item => (words[0] ? item.id === words[0] : item.ready > 0)) || null;
    // A file deleted, or an explainer made before files were: written now.
    const file = found?.ready ? (found.file && existsSync(found.file) ? found.file : exportExplainer(lib, found.id)?.file || null) : null;
    // Paused: stopped by hand (or by a shutdown), so opening it doesn't carry on by itself.
    const paused = jobs.find(job => job.kind === 'explain' && job.explain === found?.id)?.state === 'paused';
    line(found ? { id: found.id, title: found.title, file, ready: found.ready, clips: found.clips, paused } : null);
  } else if (command === 'resume') {
    const lib = openLibrary();
    // One with no depth waits for a pick only the progress plugin's player can ask for.
    const id = words[0] || listExplainers(lib).find(item => item.depth && item.ready < item.clips)?.id;
    const explainer = id ? readExplainer(lib, id) : null;
    if (words[0] && !explainer) fail('resume [id]: no such explainer');
    const { done, total } = explainer ? clipCounts(lib, explainer) : { done: 0, total: 0 };
    const making = Boolean(explainer?.depth) && done < total && Boolean(explainJob(lib, explainer));
    line({ making, ...(explainer ? { id, title: explainer.title, ready: done, clips: total } : {}) });
  } else if (command === 'stop') {
    const lib = openLibrary();
    const going = listJobs(lib).filter(job => job.kind === 'explain' && isJobLive(job));
    const job = going.find(item => item.explain === words[0]) || going[0];
    if (!job) line({ stopped: false });
    else {
      const ended = await stopJob(lib, job.id);
      const explainer = readExplainer(lib, job.explain);
      const { done, total } = explainer ? clipCounts(lib, explainer) : { done: job.done, total: job.total };
      line({ stopped: true, ended, job: job.id, id: job.explain, title: job.topic, ready: done, clips: total });
    }
  } else if (command === 'wiki') {
    line(await wikiCommand(openLibrary(), words[0]));
  } else if (command === 'model') {
    const name = words[0] ?? null;
    const known = name === null || isModel(name);
    if (name && known) writeSettings({ models: { video: name } });
    line({ model: readSettings().models.video, models: MODELS, known });
  } else {
    fail('start | run <job> | export <id> | voice | latest [id] | resume [id] | stop [id] | wiki [id | on | off] | model [name]');
  }
  process.exit(0);
} catch (error) {
  fail(String(error.message || error));
}
