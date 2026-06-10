/** Examiner voice via the browser's SpeechSynthesis (no assets, fully static). */

let voice: SpeechSynthesisVoice | null = null;
let enabled = true;

function pickVoice(): void {
  if (voice || !('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  voice =
    voices.find((v) => v.lang.startsWith('en-CA')) ??
    voices.find((v) => v.lang.startsWith('en-GB')) ??
    voices.find((v) => v.lang.startsWith('en')) ??
    null;
}

if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = pickVoice;
  pickVoice();
}

export function setVoiceEnabled(on: boolean): void {
  enabled = on;
  if (!on) stopSpeaking();
}

export function speak(text: string): void {
  if (!enabled || !('speechSynthesis' in window)) return;
  pickVoice();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.02;
  u.pitch = 0.95;
  u.volume = 0.95;
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
