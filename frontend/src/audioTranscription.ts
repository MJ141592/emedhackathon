const TRANSCRIPTION_SAMPLE_RATE = 16_000;

type DecodedAudio = Pick<AudioBuffer, "numberOfChannels" | "length" | "sampleRate" | "getChannelData">;

export function encodeTranscriptionWav(audio: DecodedAudio): ArrayBuffer {
  const sampleRate = Math.min(audio.sampleRate, TRANSCRIPTION_SAMPLE_RATE);
  const frameCount = Math.ceil((audio.length * sampleRate) / audio.sampleRate);
  const bytes = new ArrayBuffer(44 + frameCount * 2);
  const view = new DataView(bytes);
  const writeText = (offset: number, value: string) => {
    [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + frameCount * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, frameCount * 2, true);

  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sourceFrame = (frame * audio.sampleRate) / sampleRate;
    const lower = Math.floor(sourceFrame);
    const upper = Math.min(lower + 1, audio.length - 1);
    const mix = channels.reduce((sum, channel) => {
      const fraction = sourceFrame - lower;
      return sum + channel[lower] + (channel[upper] - channel[lower]) * fraction;
    }, 0) / channels.length;
    const clamped = Math.max(-1, Math.min(1, mix));
    view.setInt16(44 + frame * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return bytes;
}

export async function prepareVoiceNoteForTranscription(recording: Blob): Promise<Blob> {
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return recording;

  const context = new AudioContextConstructor();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    return new Blob([encodeTranscriptionWav(decoded)], { type: "audio/wav" });
  } finally {
    await context.close();
  }
}
