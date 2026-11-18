# One video's script spoken into one track, with a time for every word and every visual cue.
#   python -I narrate.py <model folder> <script.json> <out> <voice>
# Writes <out>.mp3, then <out>.json (the script with its times), so <out>.json only ever exists
# with its audio beside it. Runs at low priority: it takes what the machine isn't using.
# Progress goes to stdout as JSON lines. Run with -I, so nothing near it can stand in for a module.
import json, os, re, sys
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

RATE = 24000
SENTENCE_GAP, BEAT_GAP, SCENE_GAP = 0.14, 0.26, 0.55
# The written form on screen, and what the voice is given. Each page adds its own.
ALWAYS = [('IDs', "I D's")]
SKIP = set(' ,.;:!?—–-…"()“”\'')


def clean(word):
    return re.sub(r"[^\w']", '', word, flags=re.UNICODE)


def split(text):
    return [s for s in re.split(r'(?<=[.!?])\s+', str(text).strip()) if s]


class Speaker:
    def __init__(self, model_dir, voice, pronounce):
        self.kokoro = Kokoro(os.path.join(model_dir, 'timed.onnx'), os.path.join(model_dir, 'voices-v1.0.bin'))
        # The timed export's output is "durations"; kokoro-onnx looks for "duration".
        self.kokoro.has_timings = True
        self.voice = voice
        pairs = ALWAYS + [(p['written'], p['spoken']) for p in pronounce if p.get('written') and p.get('spoken')]
        self.pairs = sorted(pairs, key=lambda pair: -len(pair[0]))
        self.pieces = []
        self.at = 0.0
        self.said = 0

    def spoken(self, text):
        for written, said in self.pairs:
            text = re.sub(r'(?<!\w)' + re.escape(written) + r'(?!\w)', said, text)
        return text

    def word_times(self, words, timed):
        """Each caption word gets its share of the sounds, in order."""
        sounds = [t for t in timed if t.phoneme not in SKIP]
        if not sounds:
            return [(0.0, 0.0)] * len(words)
        weight = []
        for word in words:
            bare = clean(word)
            sounded = self.kokoro.tokenizer.phonemize(self.spoken(bare), 'en-us') if bare else ''
            weight.append(max(1, len([c for c in sounded if c not in SKIP])))
        scale = len(sounds) / sum(weight)
        out, used = [], 0.0
        for share in weight:
            first = min(len(sounds) - 1, int(round(used)))
            used += share * scale
            last = max(first, min(len(sounds) - 1, int(round(used)) - 1))
            out.append((sounds[first].start, sounds[last].end))
        return out

    def silence(self, seconds):
        self.pieces.append(np.zeros(int(seconds * RATE), dtype=np.float32))
        self.at += seconds

    def speak(self, text):
        """Adds the text to the track; returns its words with their times in the track."""
        timed_words = []
        sentences = split(text)
        for index, sentence in enumerate(sentences):
            audio, _, timed = self.kokoro.create_timed(self.spoken(sentence), voice=self.voice, lang='en-us')
            words = sentence.split()
            for word, (start, end) in zip(words, self.word_times(words, timed)):
                timed_words.append({'w': word, 's': round(self.at + start, 3), 'e': round(self.at + end, 3)})
            self.pieces.append(np.asarray(audio, dtype=np.float32))
            self.at += len(audio) / RATE
            self.said += 1
            if self.said % 10 == 0:
                print(json.dumps({'said': self.said}), flush=True)
            if index < len(sentences) - 1:
                self.silence(SENTENCE_GAP)
        return timed_words


def cue_time(action, words, cursor, beat_start):
    """When a cue's word is said, searching on from the last cue; (time, cursor, found)."""
    if not action.get('on'):
        return beat_start, cursor, True
    wanted = clean(action['on']).lower()
    match = lambda i: clean(words[i]['w']).lower() == wanted
    hit = next((i for i in range(cursor, len(words)) if match(i)), None)
    if hit is None:
        hit = next((i for i in range(len(words)) if match(i)), None)
    if hit is None:
        return beat_start, cursor, False
    return words[hit]['s'], hit, True


def tell(speaker, scene, all_words):
    """A teaching scene into the track: its start, its cues on their words, its end. Returns the cues missed."""
    missed = 0
    scene['start'] = round(speaker.at, 3)
    scene['cues'] = []
    for beat in scene['beats']:
        beat_start = speaker.at
        words = speaker.speak(beat['say'])
        all_words.extend(words)
        cursor = 0
        for action in beat.get('do') or []:
            t, cursor, found = cue_time(action, words, cursor, beat_start)
            missed += 0 if found else 1
            cue = {key: action[key] for key in ('show', 'hide', 'set', 'camera') if action.get(key)}
            cue['t'] = round(max(beat_start, t - 0.1), 3)
            scene['cues'].append(cue)
        # A plain scene's code or table stays up long enough to be read.
        speaker.silence(BEAT_GAP + float(beat.get('hold') or 0))
    scene['cues'].sort(key=lambda cue: cue['t'])
    scene['end'] = round(speaker.at, 3)
    return missed


def main():
    model_dir, script_file, out, voice = sys.argv[1:5]
    # Low priority where there is nice; on Windows the helper lowers this process itself.
    if hasattr(os, 'nice'):
        try:
            os.nice(15)
        except OSError:
            pass
    with open(script_file, encoding='utf-8') as f:
        script = json.load(f)
    questions = {q['id']: q for q in script['quiz']}
    total = sum(len(split(b['say'])) for s in script['scenes'] for b in s.get('beats') or [])
    total += sum(len(split(q['q'])) for q in script['quiz'])
    # What follows an answer is said too, so a percentage of this is a true percentage.
    total += sum(len(split(f"Right. {o['why']}")) + len(split(f"Not quite. The answer is: {o['text'].rstrip('.')}. {o['why']}")) for q in script['quiz'] for o in q['options'] if o['right'])
    openers = script.get('openers') or {}
    total += sum(len(split(b['say'])) for by_option in openers.values() for s in by_option.values() for b in s.get('beats') or [])
    print(json.dumps({'sentences': total}), flush=True)
    speaker = Speaker(model_dir, voice, script.get('pronounce') or [])
    all_words = []
    missed = 0
    speaker.silence(0.4)
    for scene in script['scenes']:
        scene['start'] = round(speaker.at, 3)
        scene['cues'] = []
        if scene.get('check'):
            speaker.speak(questions[scene['check']]['q'])
            scene['end'] = round(speaker.at, 3)
            speaker.silence(SCENE_GAP)
            continue
        missed += tell(speaker, scene, all_words)
        speaker.silence(SCENE_GAP - BEAT_GAP)
    main_end = speaker.at
    # What follows an answer: heard only by someone who answered, past the end of the main track.
    extras = {}
    for question in script['quiz']:
        right = next(option for option in question['options'] if option['right'])
        answer = right['text'].rstrip('.')
        parts = {}
        for name, text in (('right', f"Right. {right['why']}"), ('wrong', f"Not quite. The answer is: {answer}. {right['why']}")):
            start = speaker.at
            speaker.speak(text)
            parts[name] = {'start': round(start, 3), 'end': round(speaker.at, 3)}
            speaker.silence(0.2)
        extras[question['id']] = parts
    # A wrong guess played out, picture and all: also past the main track, played only for that pick.
    for by_option in openers.values():
        for scene in by_option.values():
            speaker.silence(0.3)
            missed += tell(speaker, scene, all_words)
    audio_file = out + '.mp3'
    # Constant bitrate: the player seeks by time, and a variable one seeks only roughly.
    sf.write(audio_file + '.tmp', np.concatenate(speaker.pieces), RATE, format='MP3', subtype='MPEG_LAYER_III', compression_level=0.6, bitrate_mode='CONSTANT')
    os.replace(audio_file + '.tmp', audio_file)
    script['words'] = all_words
    script['audio'] = {'mainEnd': round(main_end, 3), 'extras': extras, 'voice': voice, 'seconds': round(speaker.at, 3)}
    script['stats'] = {**(script.get('stats') or {}), 'cueWordsMissed': missed, 'sentences': speaker.said}
    with open(out + '.json.tmp', 'w', encoding='utf-8') as f:
        json.dump(script, f)
    os.replace(out + '.json.tmp', out + '.json')
    print(json.dumps({'done': True, 'seconds': round(speaker.at, 1), 'missed': missed}), flush=True)


main()
