// The explain plugin's helper: everything /explain needs, and nothing of courses. Run through
// learn.sh (which finds Node 22), which runs this when there's no learn.mjs beside it. A leading
// `explain` is taken off, so the explain plugin calls it as the progress plugin calls learn.mjs.
//
//   learn.sh explain start --session <id> --cwd <dir>   a plan on stdin: one line of JSON, the explainer started or what to fix
//   learn.sh explain run <job>                          an explainer's job, run here (start runs it on its own)
//   learn.sh explain export <id> | --all                an explainer as one file in ~/explainers (LEARN_EXPORT_DIR)
//   learn.sh explain voice                              one line of JSON: the voice ready, to set up (its size), or why it can't run here
//   learn.sh explain latest [id]                        one line of JSON: that explainer (or the newest with a clip), its file written if it's gone
//   learn.sh explain resume <id>                        one line of JSON: whether a job is making what's missing of it (started if none is)
import { existsSync } from 'node:fs';
import { exportExplainer } from './export.mjs';
import { clipCounts, listExplainers, readExplainer } from './explain.mjs';
import { explainJob, runExplainJob, startExplainer } from './explain-job.mjs';
import { listJobs } from './jobs.mjs';
import { openLibrary } from './status.mjs';
import { voiceStatus } from './voice.mjs';

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
    const started = await startExplainer(openLibrary(), { plan, sessionId: flags.session, cwd: flags.cwd });
    line(started.problems ? { ok: false, problems: started.problems } : { ok: true, id: started.id, clips: started.clips, wanted: started.wanted, depth: started.depth });
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
    const found = listExplainers(lib, listJobs(lib)).find(item => (words[0] ? item.id === words[0] : item.ready > 0)) || null;
    // A file deleted, or an explainer made before files were: written now.
    const file = found?.ready ? (found.file && existsSync(found.file) ? found.file : exportExplainer(lib, found.id)?.file || null) : null;
    line(found ? { id: found.id, title: found.title, file, ready: found.ready, clips: found.clips } : null);
  } else if (command === 'resume') {
    const lib = openLibrary();
    const explainer = words[0] ? readExplainer(lib, words[0]) : null;
    if (!explainer) fail('resume <id>: no such explainer');
    const { done, total } = clipCounts(lib, explainer);
    // One with no depth waits for a pick only the progress plugin's player can ask for.
    line({ making: Boolean(explainer.depth) && done < total && Boolean(explainJob(lib, explainer)) });
  } else {
    fail('start | run <job> | export <id> | voice | latest [id] | resume <id>');
  }
  process.exit(0);
} catch (error) {
  fail(String(error.message || error));
}
