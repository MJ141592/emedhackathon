import { describe, expect, test } from "vitest";
import { encodeTranscriptionWav } from "./audioTranscription";

describe("encodeTranscriptionWav", () => {
  test("produces compact 16 kHz mono WAV data from a stereo recording", async () => {
    const wav = encodeTranscriptionWav({
      numberOfChannels: 2,
      length: 4,
      sampleRate: 32_000,
      getChannelData: (channel) =>
        channel === 0 ? new Float32Array([0, 1, 0, -1]) : new Float32Array([0, -1, 0, 1]),
    });

    const bytes = new Uint8Array(wav);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
    expect(new DataView(bytes.buffer).getUint16(22, true)).toBe(1);
    expect(bytes.length).toBe(48);
  });
});
