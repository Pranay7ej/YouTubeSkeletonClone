// What ffprobe tells us about an upload, reduced to what the ladder needs.

export interface ProbeResult {
  width: number; // as displayed (rotation already applied)
  height: number;
  durationSec: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  rotation: number; // 0, 90, 180, 270
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export const PROBE_ARGS = [
  "-v", "error",
  "-print_format", "json",
  "-show_streams",
  "-show_format",
];

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!den) return num || 0;
  return num / den;
}

// Phones record portrait video as landscape pixels plus a rotation flag.
// Newer ffprobe reports it in side data, older builds in a "rotate" tag.
function rotationOf(s: FfprobeStream): number {
  let deg = 0;
  const side = s.side_data_list?.find((d) => typeof d.rotation === "number");
  if (side && typeof side.rotation === "number") deg = side.rotation;
  else if (s.tags?.rotate) deg = Number(s.tags.rotate);
  deg = ((Math.round(deg) % 360) + 360) % 360;
  return deg;
}

export function parseProbeOutput(json: string): ProbeResult {
  let data: FfprobeOutput;
  try {
    data = JSON.parse(json) as FfprobeOutput;
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) {
    throw new Error("no video stream found");
  }
  const audio = streams.find((s) => s.codec_type === "audio");
  const rotation = rotationOf(video);
  const swap = rotation === 90 || rotation === 270;

  // avg_frame_rate is what a VFR phone clip averages to; r_frame_rate can be
  // a huge timebase-ish number (e.g. 90000/1) for those files.
  let fps = parseRate(video.avg_frame_rate);
  if (!(fps > 0 && fps <= 240)) fps = parseRate(video.r_frame_rate);
  if (!(fps > 0 && fps <= 240)) fps = 30;

  const duration = Number(data.format?.duration ?? video.duration ?? 0);
  if (!(duration > 0)) throw new Error("could not determine duration");

  return {
    width: swap ? video.height : video.width,
    height: swap ? video.width : video.height,
    durationSec: duration,
    fps,
    videoCodec: video.codec_name ?? "unknown",
    audioCodec: audio?.codec_name ?? null,
    rotation,
  };
}
