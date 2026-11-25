# Voice-over tool (Rohan's approved voice)

`voiceover.py` makes narration in the voice and style Rohan approved for the Event Pal promoter video
(Nov 2026). `reference-voice-b.mp3` is the approved sample: match it.

```
pip install piper-tts numpy        # plus ffmpeg
export PIPER_MODEL=/path/to/en-us-libritts-high.onnx   # Piper "en_US-libritts-high" voice (CC BY 4.0)
python3 voiceover.py --snappy-opener "Alright, so this is Event Pal..." out.mp3
python3 voiceover.py --file script.txt out.mp3 --voice F
```

- **Voices:** B = LibriTTS speaker 847 (main), F = speaker 784 (alternate).
- **Pronunciation:** AVA = "AY-vuh"; "live" rhymes with "five"; VIP/NDI/QR/LED spelled out; "Event Pal" two words.
- **Delivery:** one take per passage (never split at commas), steadier settings, pauses lengthened, 8% slower, never rushed.
- **Sound:** dead booth plus a hint of short reverb; no bass boost; de-essed; gentle compression.
- **Process:** preview first; when revising, keep the approved take and change only what was asked.

Credit line for anything published: "Narration voice: LibriTTS speaker 847 via Piper TTS, licensed CC BY 4.0."
