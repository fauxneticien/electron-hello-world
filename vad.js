// Silero VAD (v5.1.2, vendored in assets/) on onnxruntime-web, used to trim
// utterance start/end times to where speech actually is.
//
// SileroVAD.forward() and computeSegments() are taken from the vad-check repo
// (docs/index.html: a line-for-line port of silero_vad.py's get_speech_timestamps
// hysteresis), unchanged except for being an ES module. addPadding() adds the
// speech_pad_ms step of get_speech_timestamps, which that port leaves out.
//
// Needs the global `ort` from onnxruntime-web 1.22.0 (script tag in index.html).

const ort = globalThis.ort;
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
ort.env.wasm.numThreads = 1;

const MODEL_URL = new URL('./assets/silero_vad.onnx', import.meta.url).href;
const SR = 16000;

export class SileroVAD {
  constructor(session) {
    this.session = session;
    this.samplingRate = 16000;
    this.batchSize = 1;
    this.contextSize = 64;
    this.windowSizeSamples = 512;
    this.resetStates();
  }

  static async create(modelUrl = MODEL_URL) {
    const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
    return new SileroVAD(session);
  }

  resetStates() {
    this._state = new Float32Array(2 * this.batchSize * 128);
    this._context = null;
  }

  async forward(chunk) {
    if (!this._context) this._context = new Float32Array(this.contextSize);
    const input = new Float32Array(this.contextSize + this.windowSizeSamples);
    input.set(this._context, 0);
    input.set(chunk, this.contextSize);
    const outputs = await this.session.run({
      input: new ort.Tensor('float32', input, [this.batchSize, this.contextSize + this.windowSizeSamples]),
      state: new ort.Tensor('float32', this._state, [2, this.batchSize, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
    });
    this._state = outputs.stateN.data;
    this._context = chunk.slice(chunk.length - this.contextSize);
    return outputs.output.data[0];
  }

  static computeSegments(speechProbs, audioLengthSamples, options = {}) {
    const {
      threshold = 0.5,
      minSpeechDurationMs = 250,
      maxSpeechDurationS = Infinity,
      minSilenceDurationMs = 100,
      speechPadMs = 30,
    } = options;

    const sr = 16000;
    const wss = 512;
    const minSpeechSamples = sr * minSpeechDurationMs / 1000;
    const speechPadSamples = sr * speechPadMs / 1000;
    const maxSpeechSamples = sr * maxSpeechDurationS - wss - 2 * speechPadSamples;
    const minSilenceSamples = sr * minSilenceDurationMs / 1000;
    const minSilenceSamplesAtMaxSpeech = sr * 98 / 1000;
    const negThreshold = Math.max(threshold - 0.15, 0.01);

    let triggered = false;
    let currentSpeech = {};
    const speeches = [];
    let tempEnd = 0, prevEnd = 0, nextStart = 0;

    for (let i = 0; i < speechProbs.length; i++) {
      const prob = speechProbs[i];
      if (prob >= threshold && tempEnd) {
        tempEnd = 0;
        if (nextStart < prevEnd) nextStart = wss * i;
      }
      if (prob >= threshold && !triggered) {
        triggered = true;
        currentSpeech.start = wss * i;
        continue;
      }
      if (triggered && (wss * i) - currentSpeech.start > maxSpeechSamples) {
        if (prevEnd) {
          currentSpeech.end = prevEnd;
          speeches.push(currentSpeech);
          currentSpeech = {};
          if (nextStart < prevEnd) triggered = false;
          else currentSpeech.start = nextStart;
          prevEnd = nextStart = tempEnd = 0;
        } else {
          currentSpeech.end = wss * i;
          speeches.push(currentSpeech);
          currentSpeech = {};
          prevEnd = nextStart = tempEnd = 0;
          triggered = false;
          continue;
        }
      }
      if (prob < negThreshold && triggered) {
        if (!tempEnd) tempEnd = wss * i;
        if ((wss * i) - tempEnd > minSilenceSamplesAtMaxSpeech) prevEnd = tempEnd;
        if ((wss * i) - tempEnd < minSilenceSamples) {
          continue;
        } else {
          currentSpeech.end = tempEnd;
          if ((currentSpeech.end - currentSpeech.start) > minSpeechSamples) speeches.push(currentSpeech);
          currentSpeech = {};
          prevEnd = nextStart = tempEnd = 0;
          triggered = false;
          continue;
        }
      }
    }

    if (currentSpeech.start !== undefined && (audioLengthSamples - currentSpeech.start) > minSpeechSamples) {
      currentSpeech.end = audioLengthSamples;
      speeches.push(currentSpeech);
    }
    return speeches;
  }

  /** speech_pad_ms step of silero_vad's get_speech_timestamps (samples in, samples out). */
  static addPadding(speeches, audioLengthSamples, speechPadMs = 30) {
    const pad = SR * speechPadMs / 1000;
    const out = speeches.map(s => ({ ...s }));
    out.forEach((s, i) => {
      if (i === 0) s.start = Math.max(0, s.start - pad);
      if (i < out.length - 1) {
        const silence = out[i + 1].start - s.end;
        if (silence < 2 * pad) {
          s.end += Math.floor(silence / 2);
          out[i + 1].start = Math.max(0, out[i + 1].start - Math.floor(silence / 2));
        } else {
          s.end = Math.min(audioLengthSamples, s.end + pad);
          out[i + 1].start = Math.max(0, out[i + 1].start - pad);
        }
      } else {
        s.end = Math.min(audioLengthSamples, s.end + pad);
      }
    });
    return out;
  }
}

/**
 * Speech regions of 16 kHz mono audio, in seconds: [{ start, end }].
 * onProgress(fraction) is called every ~2 s of audio.
 */
export async function detectSpeech(vad, audio, onProgress = () => {}) {
  vad.resetStates();
  const wss = vad.windowSizeSamples;
  const probs = [];
  const chunk = new Float32Array(wss);
  for (let off = 0, n = 0; off < audio.length; off += wss, n++) {
    chunk.fill(0);
    chunk.set(audio.subarray(off, Math.min(audio.length, off + wss)));
    probs.push(await vad.forward(chunk));
    if (n % 64 === 0) onProgress(off / audio.length);
  }
  onProgress(1);
  const segments = SileroVAD.addPadding(SileroVAD.computeSegments(probs, audio.length), audio.length);
  return segments.map(s => ({ start: s.start / SR, end: s.end / SR }));
}

/**
 * Trim (and where unambiguous, extend) utterance times to speech regions.
 * DTW word times have no pauses, so an utterance's end runs up to the next
 * utterance's start. The regions that count are therefore those between the
 * utterance's first word start and its LAST WORD's start (u.lastStart).
 * - Start: moves later to the first such region; moves earlier to that
 *   region's onset if the region began after the previous utterance ended.
 * - End: the end of the last such region (the one holding the last word),
 *   but never past the next utterance's start.
 * Utterances that overlap no speech region keep their times.
 */
export function trimToSpeech(utterances, speech) {
  const out = utterances.map(u => ({ ...u }));
  const TOL = 0.1; // s: DTW word starts can land a little before the VAD onset
  const overlapping = u => speech.filter(r => r.end > u.start && r.start <= (u.lastStart ?? u.end) + TOL);
  const regions = utterances.map(overlapping);
  out.forEach((u, i) => {
    const rs = regions[i];
    if (!rs.length) return;
    const first = rs[0], last = rs.at(-1);
    const prevEnd = i > 0 ? out[i - 1].end : 0;
    u.start = first.start < u.start && first.start >= prevEnd ? first.start : Math.max(u.start, first.start);
    u.end = last.end;
    // A sentence break inside continuous speech: the region runs on into the
    // next utterance, so stop at that utterance's (DTW) start instead.
    if (i + 1 < utterances.length && u.end > utterances[i + 1].start) u.end = Math.max(u.start, utterances[i + 1].start);
    if (u.end <= u.start) { u.start = utterances[i].start; u.end = utterances[i].end; } // never invert
  });
  return out;
}
