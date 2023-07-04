import assert from "node:assert/strict";
import { test } from "node:test";

import { PlaybackMetrics } from "../lib/playbackMetrics";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("time to first frame runs from load start to the first playing event", () => {
  const c = clock();
  const m = new PlaybackMetrics(c.now);
  m.loadStart();
  c.advance(250);
  m.waiting(); // startup buffering, not a rebuffer
  c.advance(400);
  m.playing();
  c.advance(1000);
  m.playing(); // later playing events don't move it
  const s = m.snapshot();
  assert.equal(s.ttffMs, 650);
  assert.equal(s.rebufferCount, 0);
});

test("stalls after the first frame are rebuffers", () => {
  const c = clock();
  const m = new PlaybackMetrics(c.now);
  m.loadStart();
  m.playing();
  c.advance(5000);
  m.waiting();
  c.advance(1200);
  m.waiting(); // duplicate event during the same stall
  c.advance(300);
  m.playing();
  c.advance(4000);
  m.waiting();
  c.advance(700);
  const s = m.snapshot(); // still stalled: counted up to now
  assert.equal(s.rebufferCount, 2);
  assert.equal(s.rebufferMs, 1500 + 700);
});

test("seeking isn't a rebuffer, but a stall cut short by a seek still counts", () => {
  const c = clock();
  const m = new PlaybackMetrics(c.now);
  m.loadStart();
  m.playing();
  m.seekStart();
  m.waiting();
  c.advance(800);
  m.seekEnd();
  m.playing();
  assert.equal(m.snapshot().rebufferCount, 0);

  m.waiting();
  c.advance(300);
  m.seekStart();
  c.advance(500);
  m.seekEnd();
  m.playing();
  const s = m.snapshot();
  assert.equal(s.rebufferCount, 1);
  assert.equal(s.rebufferMs, 300);
});

test("quality switches: the first level is the start, repeats are ignored", () => {
  const c = clock();
  const m = new PlaybackMetrics(c.now);
  m.loadStart();
  m.levelSwitched(0, 360);
  c.advance(8000);
  m.levelSwitched(1, 720);
  m.levelSwitched(1, 720);
  c.advance(12000);
  m.levelSwitched(2, 1080);
  assert.equal(m.switchCount, 2);
  assert.deepEqual(m.snapshot().switches, [
    { atSec: 0, level: 0, height: 360 },
    { atSec: 8, level: 1, height: 720 },
    { atSec: 20, level: 2, height: 1080 },
  ]);
});

test("watched time adds up forward progress and skips seeks", () => {
  const m = new PlaybackMetrics(clock().now);
  for (let t = 0; t <= 10; t += 0.25) m.timeUpdate(t);
  m.seekStart();
  m.timeUpdate(60);
  m.seekEnd();
  for (let t = 60.25; t <= 65; t += 0.25) m.timeUpdate(t);
  assert.equal(m.snapshot().watchedSec, 15);
});
