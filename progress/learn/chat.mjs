// The chats: one thread per page (resumed with `claude -p --resume`, so the page stays in
// Claude's context), and the Advisor (a fresh run each time with the learner's current
// state, since a resumed session keeps the system prompt it started with).
import { stateOf } from './catalogue.mjs';
import { runClaude } from './claude.mjs';
import { courseSummary, listCourses, readCatalogue, readCourse, readPage } from './library.mjs';
import { advisorSystem, pageChatSystem } from './prompts.mjs';
import { readJson, withLock, writeJson, writeText } from './store.mjs';

const PAGE_TOOLS = ['WebSearch', 'WebFetch', 'Read'];
const ADVISOR_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const ADVISOR_HISTORY = 12;

export const chatKey = target => (target.advisor ? 'advisor' : `${target.courseId}:${target.n}`);

const chatFile = (lib, target) => (target.advisor ? lib.paths.advisorChat : lib.paths.chat(target.courseId, target.n));

export const readChat = (lib, target) => readJson(chatFile(lib, target)) || { v: 1, sessionId: null, messages: [] };

function saveChat(lib, target, chat) {
  withLock(lib.root, () => writeJson(chatFile(lib, target), chat));
}

export function clearChat(lib, target) {
  saveChat(lib, target, { v: 1, sessionId: null, messages: [] });
}

const MARK = /\[\[\s*mark-learned\s*:\s*([^\]]*)\]\]/gi;
const BUILD = /\[\[\s*build\s*:\s*([^|\]]+?)\s*(?:\|\s*([^\]]+?))?\s*\]\]/gi;

/** The `[[...]]` lines taken out of a reply and returned as buttons. */
export function readMarkers(text, allowedIds = null) {
  const offers = [];
  const builds = [];
  let clean = String(text).replace(MARK, (whole, ids) => {
    for (const id of ids.split(/[,\s]+/).map(item => item.trim()).filter(Boolean)) {
      if ((!allowedIds || allowedIds.includes(id)) && !offers.includes(id)) offers.push(id);
    }
    return '';
  });
  clean = clean.replace(BUILD, (whole, topic, category) => {
    builds.push({ topic: topic.trim().slice(0, 200), category: (category || '').trim().slice(0, 60) || 'General' });
    return '';
  });
  return { text: clean.replace(/\n{3,}/g, '\n\n').trim(), offers, builds };
}

function advisorState(lib) {
  const catalogue = readCatalogue(lib);
  const categoryName = id => catalogue.categories.find(category => category.id === id)?.name || id;
  const line = concept => `${concept.name} (${categoryName(concept.category)})`;
  return {
    categories: catalogue.categories.map(category => category.name),
    courses: listCourses(lib).map(course => ({ ...courseSummary(course, catalogue), category: categoryName(course.category) })),
    learned: catalogue.concepts.filter(concept => stateOf(concept) === 'learned').map(line).slice(0, 400),
    seen: catalogue.concepts.filter(concept => stateOf(concept) === 'seen').map(line).slice(0, 300),
    workFolders: lib.settings.workFolders,
  };
}

const transcript = messages => messages.map(message => `${message.role === 'user' ? 'Learner' : 'You'}: ${message.text}`).join('\n\n');

/**
 * Sends one message. Returns `{ done, stop }`; `done` resolves to the saved reply.
 * The question is saved first, so it is there even if the window closes mid-answer.
 */
export function sendChat(lib, target, text, { onDelta, onTool, onRateLimit } = {}) {
  const question = String(text || '').trim().slice(0, 20_000);
  if (!question) throw new Error('type a message first');
  const chat = readChat(lib, target);
  chat.messages.push({ role: 'user', text: question, at: new Date().toISOString() });
  saveChat(lib, target, chat);
  let current = null;
  let stopped = false;
  const model = lib.settings.models.chat;
  const done = (async () => {
    let allowed = null;
    let reply;
    if (target.advisor) {
      writeText(lib.paths.advisorSystem, advisorSystem(advisorState(lib)));
      const history = chat.messages.slice(-ADVISOR_HISTORY - 1, -1);
      const prompt = history.length ? `Our conversation so far:\n\n${transcript(history)}\n\nLearner: ${question}` : question;
      current = runClaude({ prompt, model, tools: ADVISOR_TOOLS, systemFile: lib.paths.advisorSystem, addDirs: lib.settings.workFolders, cwd: lib.root, stream: true, onDelta, onTool, onRateLimit });
      reply = await current.done;
    } else {
      const course = readCourse(lib, target.courseId);
      const page = readPage(lib, target.courseId, target.n);
      if (!course || !page) throw new Error('that page is not written yet');
      allowed = page.concepts;
      const catalogue = readCatalogue(lib);
      const concepts = page.concepts.map(id => catalogue.concepts.find(concept => concept.id === id)).filter(Boolean);
      const systemFile = lib.paths.chatSystem(target.courseId, target.n);
      const links = [page.source.url, ...(page.support || []).map(item => item.url)].filter(Boolean);
      const fresh = async prompt => {
        writeText(systemFile, pageChatSystem({ course, page, concepts, sourceLinks: links }));
        current = runClaude({ prompt, model, tools: PAGE_TOOLS, systemFile, cwd: lib.root, stream: true, persist: true, onDelta, onTool, onRateLimit });
        return current.done;
      };
      if (chat.sessionId) {
        try {
          current = runClaude({ prompt: question, model, tools: PAGE_TOOLS, resume: chat.sessionId, cwd: lib.root, stream: true, persist: true, onDelta, onTool, onRateLimit });
          reply = await current.done;
        } catch (error) {
          if (stopped) throw error;
          // The session is gone (another machine, cleared history): start again with the thread so far.
          const history = chat.messages.slice(0, -1);
          reply = await fresh(history.length ? `Our conversation so far:\n\n${transcript(history)}\n\nLearner: ${question}` : question);
        }
      } else {
        reply = await fresh(question);
      }
    }
    const markers = readMarkers(reply.text, allowed);
    const saved = readChat(lib, target);
    if (!target.advisor && reply.sessionId) saved.sessionId = reply.sessionId;
    const message = { role: 'assistant', text: markers.text, offers: markers.offers, builds: markers.builds, at: new Date().toISOString() };
    saved.messages.push(message);
    saveChat(lib, target, saved);
    return message;
  })();
  return {
    done,
    stop() {
      stopped = true;
      current?.stop();
    },
  };
}
