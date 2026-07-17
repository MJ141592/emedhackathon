import { useCallback, useEffect, useRef, useState } from "react";

type RecorderState = "idle" | "recording" | "ready" | "error";

export function useAudioRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [audio, setAudio] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const reset = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setAudio(null);
    setError(null);
    setState("idle");
  }, [previewUrl]);

  const start = useCallback(async () => {
    reset();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError("Audio recording is not supported in this browser.");
      setState("error");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setAudio(blob);
        setPreviewUrl(URL.createObjectURL(blob));
        setState("ready");
        releaseStream();
      };
      recorder.start();
      setState("recording");
    } catch {
      setError("Microphone access was not available.");
      setState("error");
      releaseStream();
    }
  }, [releaseStream, reset]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  useEffect(() => {
    return () => {
      releaseStream();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl, releaseStream]);

  return { state, audio, previewUrl, error, start, stop, reset };
}

