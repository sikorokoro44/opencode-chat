/**
 * Incremental SSE frame parser.
 *
 * Feed it arbitrary chunk boundaries; it emits complete events only. It is a pure
 * function of the text seen so far, which makes it exhaustively unit-testable.
 */

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private pending = "";
  private eventName = "";
  private dataLines: string[] = [];
  private lastId: string | undefined;
  private readonly frames: SseFrame[] = [];

  /** Feeds a chunk and returns every complete frame it produced. */
  push(chunk: string): SseFrame[] {
    this.frames.length = 0;
    if (chunk === "") return [];
    this.pending += chunk;
    this.processCompleteLines();
    return [...this.frames];
  }

  /**
   * Flushes a trailing frame that was not terminated by a blank line.
   * A held-back lone `\r` is treated as a line terminator here.
   */
  flush(): SseFrame[] {
    this.frames.length = 0;
    if (this.pending !== "") {
      this.pending += "\n";
      this.processCompleteLines();
    }
    this.emitFrame();
    return [...this.frames];
  }

  private processCompleteLines(): void {
    let lineStart = 0;
    let index = 0;
    while (index < this.pending.length) {
      const char = this.pending[index];
      if (char === "\r") {
        // A `\r` in the final position may be the first half of a `\r\n` that
        // is split across chunks, so it is left in the buffer until more arrives.
        if (index + 1 >= this.pending.length) break;
        this.handleLine(this.pending.slice(lineStart, index));
        index += this.pending[index + 1] === "\n" ? 2 : 1;
        lineStart = index;
        continue;
      }
      if (char === "\n") {
        this.handleLine(this.pending.slice(lineStart, index));
        index += 1;
        lineStart = index;
        continue;
      }
      index += 1;
    }
    this.pending = this.pending.slice(lineStart);
  }

  private handleLine(line: string): void {
    if (line === "") {
      this.emitFrame();
      return;
    }
    if (line.startsWith(":")) return; // comment / heartbeat

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        this.lastId = value;
        break;
      default:
        break; // `retry` and unknown fields are ignored per the SSE spec
    }
  }

  private emitFrame(): void {
    if (this.dataLines.length === 0 && this.eventName === "") return;
    const frame: SseFrame = {
      event: this.eventName === "" ? "message" : this.eventName,
      data: this.dataLines.join("\n"),
    };
    if (this.lastId !== undefined) frame.id = this.lastId;
    this.frames.push(frame);
    this.eventName = "";
    this.dataLines = [];
  }
}

/** Parses an OpenAI-compatible chat-completions chunk into text/usage/finish/tool calls. */
export interface OpenAiChunk {
  text?: string;
  finishReason?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  toolCalls?: {
    index: number;
    id?: string;
    name?: string;
    argsDelta?: string;
  }[];
}

export function parseOpenAiChunk(json: unknown): OpenAiChunk {
  const out: OpenAiChunk = {};
  if (typeof json !== "object" || json === null) return out;
  const record = json as Record<string, unknown>;
  const choices = record["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    const delta = choice["delta"];
    if (typeof delta === "object" && delta !== null) {
      const deltaRecord = delta as Record<string, unknown>;
      const content = deltaRecord["content"];
      if (typeof content === "string") out.text = content;
      const toolCalls = deltaRecord["tool_calls"];
      if (Array.isArray(toolCalls)) {
        out.toolCalls = toolCalls.flatMap((raw, position) => {
          if (typeof raw !== "object" || raw === null) return [];
          const call = raw as Record<string, unknown>;
          const fn = typeof call["function"] === "object" && call["function"] !== null
            ? (call["function"] as Record<string, unknown>)
            : {};
          return [
            {
              index: typeof call["index"] === "number" ? call["index"] : position,
              ...(typeof call["id"] === "string" ? { id: call["id"] } : {}),
              ...(typeof fn["name"] === "string" ? { name: fn["name"] } : {}),
              ...(typeof fn["arguments"] === "string" ? { argsDelta: fn["arguments"] } : {}),
            },
          ];
        });
      }
    }
    if (typeof choice["finish_reason"] === "string") out.finishReason = choice["finish_reason"];
    // Legacy completions API shape.
    if (typeof choice["text"] === "string") out.text = choice["text"];
  }
  const usage = record["usage"];
  if (typeof usage === "object" && usage !== null) {
    const usageRecord = usage as Record<string, unknown>;
    if (typeof usageRecord["prompt_tokens"] === "number") out.promptTokens = usageRecord["prompt_tokens"];
    if (typeof usageRecord["completion_tokens"] === "number") out.completionTokens = usageRecord["completion_tokens"];
  }
  return out;
}
