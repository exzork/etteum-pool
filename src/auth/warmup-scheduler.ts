import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { warmupQueue } from "./warmup-queue";
import { broadcast } from "../ws/index";
import { addAuthLog } from "./logs";
import { config } from "../config";

const INTERVAL_KEY = "auto_warmup_interval_minutes";
const ENABLED_KEY_PREFIX = "auto_warmup_provider_";
const DEFAULT_INTERVAL_MINUTES = 15;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
const WARMUP_STATUSES = ["active", "exhausted", "error"] as const;

export function isAutoWarmupSettingKey(key: string): boolean {
  return key === INTERVAL_KEY || key.startsWith(ENABLED_KEY_PREFIX);
}

class AutoWarmupScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private intervalMinutes: number = DEFAULT_INTERVAL_MINUTES;
  private enabledProviders: string[] = [];
  private nextRunAt: Date | null = null;
  private lastRunAt: Date | null = null;
  private running = false;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.reload();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
    this.running = false;
  }

  async reload(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const keys = [INTERVAL_KEY, ...config.providers.map((p) => `${ENABLED_KEY_PREFIX}${p}`)];
    const rows = await db.select().from(settings).where(inArray(settings.key, keys));
    const map = new Map(rows.map((row) => [row.key, row.value]));

    const rawInterval = Number(map.get(INTERVAL_KEY));
    this.intervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0
      ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.floor(rawInterval)))
      : DEFAULT_INTERVAL_MINUTES;

    this.enabledProviders = config.providers.filter(
      (provider) => map.get(`${ENABLED_KEY_PREFIX}${provider}`) === "true",
    );

    this.broadcastStatus();

    if (!this.running || this.enabledProviders.length === 0) {
      this.nextRunAt = null;
      return;
    }

    this.scheduleNext();
  }

  private scheduleNext(): void {
    const delay = this.intervalMinutes * 60_000;
    this.nextRunAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    this.broadcastStatus();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    this.lastRunAt = new Date();

    if (this.enabledProviders.length > 0) {
      try {
        const count = await warmupQueue.queueAll({
          providers: this.enabledProviders,
          statuses: [...WARMUP_STATUSES],
        });
        addAuthLog({
          type: "warmup_auto_tick",
          message: `Auto WarmUp queued ${count} accounts across ${this.enabledProviders.join(", ")}`,
          data: { providers: this.enabledProviders, queued: count },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addAuthLog({
          type: "warmup_auto_error",
          error: message,
          message: `Auto WarmUp failed: ${message}`,
        });
      }
    }

    if (this.running && this.enabledProviders.length > 0) {
      this.scheduleNext();
    } else {
      this.nextRunAt = null;
      this.broadcastStatus();
    }
  }

  getStatus() {
    return {
      running: this.running,
      intervalMinutes: this.intervalMinutes,
      enabledProviders: this.enabledProviders,
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null,
      lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
    };
  }

  private broadcastStatus(): void {
    broadcast({ type: "auto_warmup_status", data: this.getStatus() });
  }
}

export const autoWarmupScheduler = new AutoWarmupScheduler();
