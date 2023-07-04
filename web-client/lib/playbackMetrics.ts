// Turns <video> / hls.js events into the numbers we log per viewing session.
// No DOM or hls.js imports here, so it runs under node:test.

export interface QualitySwitch {
  atSec: number; // since the source was attached
  level: number;
  height: number;
}

export interface PlaybackSnapshot {
  ttffMs: number | null;
  rebufferCount: number;
  rebufferMs: number;
  watchedSec: number;
  switches: QualitySwitch[];
}

export class PlaybackMetrics {
  private t0: number | null = null;
  private ttff: number | null = null;
  private stallStart: number | null = null;
  private rebuffers = 0;
  private rebufferMs = 0;
  private seeking = false;
  private lastTime: number | null = null;
  private watched = 0;
  private switches: QualitySwitch[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  // Source attached: the TTFF clock starts.
  loadStart(): void {
    this.t0 = this.now();
  }

  playing(): void {
    const t = this.now();
    if (this.ttff === null && this.t0 !== null) this.ttff = t - this.t0;
    if (this.stallStart !== null) {
      this.rebufferMs += t - this.stallStart;
      this.stallStart = null;
    }
  }

  // The element ran out of data. Before the first frame that's just startup,
  // and during a seek it's expected; neither counts as a rebuffer.
  waiting(): void {
    if (this.ttff === null || this.seeking || this.stallStart !== null) return;
    this.stallStart = this.now();
    this.rebuffers += 1;
  }

  seekStart(): void {
    this.seeking = true;
    if (this.stallStart !== null) {
      // A stall that ends because the user seeked away still counts up to here.
      this.rebufferMs += this.now() - this.stallStart;
      this.stallStart = null;
    }
    this.lastTime = null;
  }

  seekEnd(): void {
    this.seeking = false;
  }

  // hls.js LEVEL_SWITCHED. The first one is the starting quality, not a switch.
  levelSwitched(level: number, height: number): void {
    const last = this.switches[this.switches.length - 1];
    if (last && last.level === level) return;
    const atSec = this.t0 === null ? 0 : (this.now() - this.t0) / 1000;
    this.switches.push({ atSec: Math.round(atSec * 10) / 10, level, height });
  }

  // timeupdate fires ~4x a second; add up real forward progress only.
  timeUpdate(currentTime: number): void {
    if (this.lastTime !== null && !this.seeking) {
      const d = currentTime - this.lastTime;
      if (d > 0 && d < 2) this.watched += d;
    }
    this.lastTime = currentTime;
  }

  get switchCount(): number {
    return Math.max(0, this.switches.length - 1);
  }

  snapshot(): PlaybackSnapshot {
    const ongoing = this.stallStart !== null ? this.now() - this.stallStart : 0;
    return {
      ttffMs: this.ttff === null ? null : Math.round(this.ttff),
      rebufferCount: this.rebuffers,
      rebufferMs: Math.round(this.rebufferMs + ongoing),
      watchedSec: Math.round(this.watched * 10) / 10,
      switches: [...this.switches],
    };
  }
}
