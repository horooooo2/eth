import { ref } from 'vue';

const SOUND_KEY = 'whale-tracker-alert-sound';

function readSoundEnabled() {
  try {
    const raw = localStorage.getItem(SOUND_KEY);
    if (raw == null) return true;
    return raw === '1' || raw === 'true';
  } catch {
    return true;
  }
}

export const alertSoundEnabled = ref(readSoundEnabled());

export function setAlertSoundEnabled(on: boolean) {
  alertSoundEnabled.value = Boolean(on);
  localStorage.setItem(SOUND_KEY, alertSoundEnabled.value ? '1' : '0');
}

export function toggleAlertSound() {
  setAlertSoundEnabled(!alertSoundEnabled.value);
  return alertSoundEnabled.value;
}

let ctx: AudioContext | null = null;
let pending = false;

function getCtx() {
  const AC = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

function chime(audio: AudioContext, start: number, freq: number, duration: number) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.16, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(start);
  osc.stop(start + duration + 0.03);
}

function ping(audio: AudioContext) {
  const now = audio.currentTime;
  chime(audio, now, 1046.5, 0.16);
  chime(audio, now + 0.11, 1568, 0.22);
}

function flush(audio: AudioContext) {
  if (audio.state === 'suspended') return;
  if (!pending) return;
  pending = false;
  ping(audio);
}

export function unlockAlertSound() {
  const audio = getCtx();
  if (!audio) return;
  audio.resume().then(() => flush(audio)).catch(() => undefined);
}

export function playAlertDing() {
  if (!alertSoundEnabled.value) return;
  const audio = getCtx();
  if (!audio) return;
  pending = true;
  if (audio.state === 'suspended') {
    audio.resume().then(() => flush(audio)).catch(() => undefined);
    return;
  }
  flush(audio);
}
