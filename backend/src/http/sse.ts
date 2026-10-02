/**
 * Server-sent-event writer.
 *
 * Handles the details that matter for a phone client on a flaky mobile link:
 *  - no buffering (socket writes are flushed immediately),
 *  - a comment heartbeat keeps intermediaries from closing an idle stream,
 *  - backpressure is respected so a slow client cannot grow server memory,
 *  - aborting is idempotent and always closes the stream exactly once.
 */

export interface SseWriterOptions {
  res: import("node:http").ServerResponse;
  heartbeatMs?: number;
  /** Default 4 MB of unflushed data after which the stream is considered dead. */
  maxBufferedBytes?: number;
}

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

export class SseStreamClosedError extends Error {
  constructor() {
    super("sse stream closed by client");
    this.name = "SseStreamClosedError";
  }
}

export class SseWriter {
  private readonly res: import("node:http").ServerResponse;
  private readonly heartbeatMs: number;
  private readonly maxBufferedBytes: number;
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: SseWriterOptions) {
    this.res = options.res;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 4 * 1024 * 1024;
  }

  get isClosed(): boolean {
    return this.closed || this.res.writableEnded || this.res.destroyed;
  }

  /** Sends response headers. Safe to call once per response. */
  start(): void {
    if (this.res.headersSent) return;
    this.res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tell reverse proxies (and nginx-style CDNs) not to buffer the stream.
      "x-accel-buffering": "no",
    });
    this.res.flushHeaders?.();
    if (this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.comment("keep-alive"), this.heartbeatMs);
      this.heartbeat.unref?.();
    }
  }

  send(event: SseEvent): void {
    this.sendNamed(event.type, event);
  }

  sendNamed(name: string, data: unknown): void {
    if (this.isClosed) throw new SseStreamClosedError();
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    // A newline inside data must be split across multiple data: lines per the SSE spec.
    const lines = payload.split("\n").map((line) => `data: ${line}`).join("\n");
    this.write(`event: ${name}\n${lines}\n\n`);
  }

  comment(text: string): void {
    if (this.isClosed) return;
    this.write(`: ${text}\n\n`);
  }

  private write(chunk: string): void {
    const buffered = this.res.writableLength ?? 0;
    if (buffered > this.maxBufferedBytes) {
      this.close();
      throw new SseStreamClosedError();
    }
    this.res.write(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (!this.res.writableEnded) {
      this.res.end();
    }
  }
}
