import assert from "node:assert/strict";
import { test } from "node:test";

import { parseProbeOutput } from "../src/ffmpeg/probe";

const json = (streams: object[], duration = "12.5") => JSON.stringify({ streams, format: { duration } });

test("reads size, duration, frame rate and codecs", () => {
  const p = parseProbeOutput(
    json([
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001" },
      { codec_type: "audio", codec_name: "aac" },
    ]),
  );
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
  assert.equal(p.durationSec, 12.5);
  assert.ok(Math.abs(p.fps - 29.97) < 0.01);
  assert.equal(p.videoCodec, "h264");
  assert.equal(p.audioCodec, "aac");
  assert.equal(p.rotation, 0);
});

test("phone rotation swaps the displayed size", () => {
  const side = parseProbeOutput(
    json([{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1", side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }]),
  );
  assert.equal(side.rotation, 270);
  assert.deepEqual([side.width, side.height], [1080, 1920]);

  const tag = parseProbeOutput(json([{ codec_type: "video", width: 1280, height: 720, avg_frame_rate: "30/1", tags: { rotate: "90" } }]));
  assert.deepEqual([tag.width, tag.height], [720, 1280]);

  const flipped = parseProbeOutput(json([{ codec_type: "video", width: 1280, height: 720, avg_frame_rate: "30/1", tags: { rotate: "180" } }]));
  assert.deepEqual([flipped.width, flipped.height], [1280, 720]);
});

test("falls back when avg_frame_rate is missing or silly", () => {
  const p = parseProbeOutput(json([{ codec_type: "video", width: 640, height: 360, avg_frame_rate: "0/0", r_frame_rate: "25/1" }]));
  assert.equal(p.fps, 25);
  const q = parseProbeOutput(json([{ codec_type: "video", width: 640, height: 360, avg_frame_rate: "0/0", r_frame_rate: "90000/1" }]));
  assert.equal(q.fps, 30);
});

test("audio is optional", () => {
  const p = parseProbeOutput(json([{ codec_type: "video", width: 640, height: 360, avg_frame_rate: "30/1" }]));
  assert.equal(p.audioCodec, null);
});

test("rejects files without video or duration", () => {
  assert.throws(() => parseProbeOutput(json([{ codec_type: "audio", codec_name: "mp3" }])), /no video/);
  assert.throws(() => parseProbeOutput(json([{ codec_type: "video", width: 10, height: 10 }], "N/A")), /duration/);
  assert.throws(() => parseProbeOutput("not json"), /invalid JSON/);
});
