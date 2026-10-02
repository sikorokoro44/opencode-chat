import assert from "node:assert/strict";
import { test } from "node:test";

import { SseParser, parseOpenAiChunk } from "../src/http/sse-parser.ts";
import { SseWriter, SseStreamClosedError } from "../src/http/sse.ts";
import { ServerResponse } from "node:http";
import { Socket } from "node:net";

test("parses a simple named event", () => {
  const parser = new SseParser();
  const frames = parser.push("event: delta\ndata: {\"text\":\"hi\"}\n\n");
  assert.deepEqual(frames, [{ event: "delta", data: '{"text":"hi"}' }]);
});

test("reassembles frames split across arbitrary chunk boundaries", () => {
  const parser = new SseParser();
  const stream = 'event: delta\ndata: {"text":"hel';
  assert.deepEqual(parser.push(stream), []);
  assert.deepEqual(parser.push('lo"}\n'), []);
  const frames = parser.push("\n");
  assert.deepEqual(frames, [{ event: "delta", data: '{"text":"hello"}' }]);
});

test("handles CRLF and a CRLF pair split across chunks", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: ping\r"), []);
  const frames = parser.push("\ndata: 1\r\n\r\n");
  assert.deepEqual(frames, [{ event: "ping", data: "1" }]);
});

test("defers a trailing CR until the next chunk disambiguates CRLF", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: x\r"), []);
  // Per the SSE spec, two data lines before one blank line are a single frame.
  assert.deepEqual(parser.push("\ndata: y\r\n\r\n"), [{ event: "message", data: "x\ny" }]);
});

test("flush resolves a stream that ended with a lone CR", () => {
  const parser = new SseParser();
  parser.push("data: tail\r");
  assert.deepEqual(parser.flush(), [{ event: "message", data: "tail" }]);
});

test("flush is a no-op when the buffer is empty", () => {
  const parser = new SseParser();
  parser.push("data: done\n\n");
  assert.deepEqual(parser.flush(), []);
});

test("joins multiple data lines with newlines and keeps the id field", () => {
  const parser = new SseParser();
  const frames = parser.push("id: 42\nevent: chunk\ndata: line one\ndata: line two\n\n");
  assert.deepEqual(frames, [{ event: "chunk", data: "line one\nline two", id: "42" }]);
});

test("ignores comments (heartbeats) and unknown fields", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(": keep-alive\n\n"), []);
  const frames = parser.push("retry: 1000\nunknown: value\ndata: real\n\n");
  assert.deepEqual(frames, [{ event: "message", data: "real" }]);
});

test("defaults the event name to 'message'", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: bare\n\n"), [{ event: "message", data: "bare" }]);
});

test("tolerates fields without a colon and a single leading space only", () => {
  const parser = new SseParser();
  const frames = parser.push("event:ping\ndata:  two spaces\n\n");
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.event, "ping");
  assert.equal(frames[0]?.data, " two spaces");
});

test("flush emits an unterminated trailing frame", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: tail"), []);
  assert.deepEqual(parser.flush(), [{ event: "message", data: "tail" }]);
});

test("blank lines between empty frames produce nothing", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("\n\n\n"), []);
});

test("parseOpenAiChunk extracts content, finish reason and usage", () => {
  assert.deepEqual(
    parseOpenAiChunk({ choices: [{ delta: { content: "tok" } }] }),
    { text: "tok" },
  );
  assert.deepEqual(
    parseOpenAiChunk({ choices: [{ delta: {}, finish_reason: "length" }] }),
    { finishReason: "length" },
  );
  assert.deepEqual(
    parseOpenAiChunk({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 7 } }),
    { promptTokens: 5, completionTokens: 7 },
  );
});

test("parseOpenAiChunk collects incremental tool calls", () => {
  const chunk = parseOpenAiChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } },
          ],
        },
      },
    ],
  });
  assert.equal(chunk.toolCalls?.length, 1);
  assert.equal(chunk.toolCalls?.[0]?.name, "read_file");
  assert.equal(chunk.toolCalls?.[0]?.argsDelta, '{"pa');
  assert.equal(chunk.toolCalls?.[0]?.index, 0);
});

test("parseOpenAiChunk is defensive against junk", () => {
  assert.deepEqual(parseOpenAiChunk(null), {});
  assert.deepEqual(parseOpenAiChunk("string"), {});
  assert.deepEqual(parseOpenAiChunk({ choices: "not-an-array" }), {});
  assert.deepEqual(parseOpenAiChunk({}), {});
});

/**
 * Minimal ServerResponse double.
 *
 * Only the surface `SseWriter` touches is implemented; using an explicit fake
 * keeps the writer's contract (headers, framing, backpressure) testable without
 * opening a socket.
 */
class FakeServerResponse {
  headers = new Map<string, string>();
  headersSent = false;
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  chunks: string[] = [];

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    for (const [key, value] of Object.entries(headers)) this.headers.set(key.toLowerCase(), value);
    this.headersSent = true;
    return this;
  }

  statusCode = 200;

  setHeader(key: string, value: string | number | readonly string[]): this {
    this.headers.set(key.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    return this;
  }

  getHeader(key: string): string | undefined {
    return this.headers.get(key.toLowerCase());
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }

  asResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

function fakeResponse(): { res: ServerResponse; chunks: string[]; ended: () => boolean; raw: FakeServerResponse } {
  const raw = new FakeServerResponse();
  return { res: raw.asResponse(), chunks: raw.chunks, ended: () => raw.writableEnded, raw };
}

test("SseWriter emits headers that defeat proxy buffering", () => {
  const { res, chunks } = fakeResponse();
  const writer = new SseWriter({ res, heartbeatMs: 0 });
  writer.start();
  assert.equal(res.getHeader("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(res.getHeader("cache-control"), "no-cache, no-transform");
  assert.equal(res.getHeader("x-accel-buffering"), "no");
  writer.sendNamed("delta", { text: "a" });
  assert.equal(chunks.join(""), 'event: delta\ndata: {"text":"a"}\n\n');
  writer.close();
});

test("SseWriter splits embedded newlines across data lines", () => {
  const { res, chunks } = fakeResponse();
  const writer = new SseWriter({ res, heartbeatMs: 0 });
  writer.start();
  writer.sendNamed("delta", "first\nsecond");
  assert.equal(chunks.join(""), "event: delta\ndata: first\ndata: second\n\n");
});

test("SseWriter heartbeats as SSE comments", async () => {
  const { res, chunks } = fakeResponse();
  const writer = new SseWriter({ res, heartbeatMs: 5 });
  writer.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  writer.close();
  assert.ok(chunks.some((chunk) => chunk.startsWith(": keep-alive")));
});

test("SseWriter refuses to write after close and close is idempotent", () => {
  const { res, chunks, ended } = fakeResponse();
  const writer = new SseWriter({ res, heartbeatMs: 0 });
  writer.start();
  writer.close();
  writer.close();
  assert.equal(ended(), true);
  assert.equal(writer.isClosed, true);
  assert.throws(() => writer.sendNamed("delta", { text: "x" }), SseStreamClosedError);
  assert.equal(chunks.length, 0);
});

test("SseWriter closes a stream that accumulates too much unflushed data", () => {
  const { res, ended, raw } = fakeResponse();
  const writer = new SseWriter({ res, heartbeatMs: 0, maxBufferedBytes: 10 });
  writer.start();
  raw.writableLength = 100;
  assert.throws(() => writer.sendNamed("delta", { text: "x" }), SseStreamClosedError);
  assert.equal(ended(), true);
});
