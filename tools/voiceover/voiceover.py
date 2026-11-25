#!/usr/bin/env python3
"""
Rohan's approved voice-over recipe ("Voice B"), honed on the Event Pal promoter video (Nov 2026).

  python3 voiceover.py "Alright, so this is Event Pal ..." out.mp3
  python3 voiceover.py --file script.txt out.mp3 [--voice F] [--snappy-opener]

Needs: piper-tts (pip install piper-tts), ffmpeg, numpy, and the Piper voice
"en_US-libritts-high" (en-us-libritts-high.onnx + .onnx.json, from the rhasspy/piper-voices
collection). Set PIPER_MODEL to its path.

THE RULES (each one was learned the hard way, keep them):
  1. Pronunciation: AVA is "AY-vuh" like the name Ava. "live" (a live show, livestream) rhymes with
     "five", never "liv". VIP / NDI / QR / LED / EC$ are spelled out. "Event Pal" is two clear words.
  2. Record each passage as ONE take. Never split a sentence at commas: comma-ended pieces lift in
     pitch at the end, which sounds unnatural. Never pitch-shift words for expression.
  3. Steadier delivery: noise_scale 0.45, noise_w 0.5 (fewer rising phrase endings).
  4. Pace: synthesize at length_scale 1.03, then lengthen the natural pauses (small gaps +40-80 ms,
     phrase breaks up to +220 ms) and slow the whole take 8% with atempo 0.92 (pitch untouched).
     Never push lines faster than natural conversation.
  5. Expression comes from phrasing, pace and punctuation. A quick interjection ("Alright,") can be
     tightened ~20% with atempo 1.22 (--snappy-opener), keeping its natural short gap.
  6. Sound: dead booth with a hint (~10% wet) of short reverb, like a Top 40 radio announcer.
     No bass boost (it went muddy). Rumble filtered, low-mid mud cut, light presence and air,
     dynamic de-esser at medium strength, room tail gated, gentle compression.
  7. Always send a preview before re-recording a whole piece, and when revising keep the approved
     take: only change what was asked.
"""
import argparse, os, re, subprocess, sys, tempfile, wave
import numpy as np

MODEL = os.environ.get('PIPER_MODEL', '/tmp/voice/lt/en-us-libritts-high.onnx')
VOICES = {'B': '847', 'F': '784', 'AVA': '408', 'X': '408'}   # approved: B (main male), F (alternate male), AVA = female voice X

PRON = [(r'\b[Ll]ivestream\b', '[[ lˈaːɪvstɹiːm ]]'), (r'\b[Ll]ive\b', '[[ lˈaːɪv ]]'),
        (r"\bAVA's\b", '[[ ˈeɪvəz ]]'), (r'\bAVA\b', '[[ ˈeɪvə ]]'),
        (r'\bVIP\b', 'V I P'), (r'\bN\.D\.I\.', 'N D I'), (r'\bNDI\b', 'N D I'),
        (r'\bQR\b', 'Q R'), (r'\bLED\b', 'L E D'), (r'\bEC\$', 'E C dollars ')]

TREATMENT = ('aresample=44100,highpass=f=80,afftdn=nr=10:nf=-42,'
             'equalizer=f=250:t=q:w=1:g=-3,equalizer=f=3000:t=q:w=1.4:g=2.5,treble=g=2:f=8000,'
             'deesser=i=0.5:m=0.5:f=0.55,'
             'agate=threshold=0.02:ratio=3:attack=3:release=60,'
             'acompressor=threshold=-18dB:ratio=2.5:attack=8:release=120:makeup=2,'
             'aecho=1.0:0.9:18|31|47:0.07|0.05|0.03,'
             'alimiter=limit=0.9,loudnorm=I=-16:TP=-1.5')


def pron(text):
    for a, b in PRON:
        text = re.sub(a, b, text)
    return text


def ff(x, sr, filt):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-f', 's16le', '-ar', str(sr), '-ac', '1', '-i', '-', '-af', filt, '-f', 's16le', '-'],
                       input=x.astype(np.int16).tobytes(), capture_output=True, check=True).stdout
    return np.frombuffer(r, np.int16).astype(np.float32)


def take(text, voice='B'):
    """One take, steadier delivery. Returns (samples, sample_rate)."""
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        out = f.name
    subprocess.run(['piper', '--model', MODEL, '--speaker', VOICES.get(voice, voice), '--length_scale', '1.03',
                    '--noise_scale', '0.45', '--noise_w', '0.5', '--sentence_silence', '0.35', '--output_file', out],
                   input=pron(text).encode(), capture_output=True, check=True)
    with wave.open(out) as w:
        sr = w.getframerate(); a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32)
    os.remove(out)
    return a, sr


def voiced(a, sr):
    fr = int(sr * .01)
    return fr, np.array([np.abs(a[i:i + fr]).mean() for i in range(0, len(a), fr)]) > 300


def pace(a, sr, snappy_opener=False):
    """Approved pacing: optional snappy first word, longer pauses, whole take 8% slower."""
    fr, on = voiced(a, sr)
    head = np.zeros(0, np.float32); body = a
    if snappy_opener:
        s = int(np.argmax(on)); i = s; q = 0
        while i < len(on):
            q = q + 1 if not on[i] else 0
            if q >= 8: break
            i += 1
        e = i - q + 1; p = i
        while p < len(on) and not on[p]: p += 1
        head = np.concatenate([a[:s * fr], ff(a[s * fr:e * fr], sr, 'atempo=1.22'), a[e * fr:p * fr][:int(sr * .08)]])
        body = a[p * fr:]
    fr, on = voiced(body, sr)
    out = []; i = 0
    while i < len(on):
        j = i
        while j < len(on) and on[j] == on[i]: j += 1
        chunk = body[i * fr:j * fr]
        if not on[i] and j < len(on) and (j - i) >= 3:
            extra = int(sr * min(0.22, 0.04 + (j - i) * 10 / 1000 * 0.6))
            chunk = np.concatenate([chunk, np.zeros(extra, np.float32)])
        out.append(chunk); i = j
    return np.concatenate([head, ff(np.concatenate(out), sr, 'atempo=0.92')])


def render(text, out_mp3, voice='B', snappy_opener=False):
    a, sr = take(text, voice)
    a = pace(a, sr, snappy_opener)
    r = subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 's16le', '-ar', str(sr), '-ac', '1', '-i', '-', '-af', TREATMENT,
                        '-ac', '1', '-b:a', '96k', out_mp3], input=a.astype(np.int16).tobytes(), capture_output=True)
    if r.returncode: sys.exit(r.stderr.decode())
    return len(a) / sr


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('text', nargs='?'); ap.add_argument('out')
    ap.add_argument('--file'); ap.add_argument('--voice', default='B', help='B (default), F, or AVA (her female voice), or a Piper speaker number')
    ap.add_argument('--snappy-opener', action='store_true', help='tighten a quick first word like "Alright,"')
    a = ap.parse_args()
    text = open(a.file).read() if a.file else a.text
    if not text: sys.exit('give the text, or --file')
    print('%.1f s -> %s' % (render(text, a.out, a.voice, a.snappy_opener), a.out))
