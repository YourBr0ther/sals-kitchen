"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// one audio element for the whole app: iPhones only let a page play sound from an element
// that was first started by a tap, so a tap "unlocks" it and later replies reuse it
let player: HTMLAudioElement | null = null;
/** A tenth of a second of silence as a WAV data URL, for unlocking audio on a tap. */
function silence(): string {
  const samples = 800; // 8 kHz, 8-bit mono
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function getPlayer() {
  player ??= new Audio();
  return player;
}

/** Call from a tap handler (like starting a voice note) so a reply can be read out later. */
export function unlockAudio() {
  const p = getPlayer();
  if (p.src && !p.paused) return;
  p.src = silence();
  p.play().catch(() => {});
}

const speakable = (md: string) =>
  md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]/g, "")
    .trim();

/** Sal reads a reply out loud: his voice from the server, or the phone's own voice if that fails. */
export function useSpeaker() {
  const [speaking, setSpeaking] = useState<number | null>(null);
  const current = useRef<number | null>(null);

  const stop = useCallback(() => {
    current.current = null;
    setSpeaking(null);
    player?.pause();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }, []);

  useEffect(() => stop, [stop]);

  const speak = useCallback(
    async (id: number, text: string) => {
      stop();
      current.current = id;
      setSpeaking(id);
      const done = () => {
        if (current.current === id) {
          current.current = null;
          setSpeaking(null);
        }
      };
      let fellBack = false;
      const fallback = () => {
        // a failed load can report through both the error event and play()'s rejection
        if (current.current !== id || fellBack) return;
        fellBack = true;
        // the phone's built-in voice is better than silence
        if (typeof speechSynthesis === "undefined") return done();
        const spoken = speakable(text);
        const u = new SpeechSynthesisUtterance(spoken);
        u.rate = 0.95;
        u.onend = done;
        u.onerror = done;
        speechSynthesis.speak(u);
        // some phones never report the end of built-in speech; don't leave the button stuck
        setTimeout(done, 4000 + spoken.length * 90);
      };
      const p = getPlayer();
      p.onended = done;
      // a stream that breaks partway ends there; starting over in another voice would repeat it
      p.onerror = () => (p.currentTime > 0.5 ? done() : fallback());
      try {
        // the server streams the audio, so playback starts before the whole reply is spoken
        p.src = `/api/tts?id=${id}`;
        await p.play();
      } catch (e) {
        // the phone refused to play without a tap; built-in speech would be refused too
        if ((e as Error).name === "NotAllowedError") return done();
        fallback();
      }
    },
    [stop],
  );

  return { speaking, speak, stop };
}
