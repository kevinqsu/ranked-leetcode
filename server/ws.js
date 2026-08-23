// Minimal RFC 6455 WebSocket server (text frames only). No dependencies.
// Enough for push notifications from the server plus small client messages.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 64 * 1024;

export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.alive = true;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
    socket.on("end", () => this.finish());
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_MESSAGE_BYTES * 2) return this.close(1009);

    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      if (frame === "toolarge") return this.close(1009);
      if (frame === "error") return this.close(1002);
      this.handleFrame(frame);
      if (this.closed) return;
    }
  }

  readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const first = buf[0];
    const second = buf[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (!masked) return "error"; // clients must mask
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) return "toolarge";
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_MESSAGE_BYTES) return "toolarge";
    if (buf.length < offset + 4 + length) return null;

    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragmentOpcode) return this.close(1002);
        this.fragments.push(payload);
        if (fin) this.deliver(this.fragmentOpcode, Buffer.concat(this.fragments));
        return undefined;
      case 0x1:
      case 0x2:
        if (fin) return this.deliver(opcode, payload);
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return undefined;
      case 0x8: // close
        this.sendFrame(0x8, payload.subarray(0, 2));
        return this.finish();
      case 0x9: // ping
        return this.sendFrame(0xa, payload);
      case 0xa: // pong
        this.alive = true;
        return undefined;
      default:
        return this.close(1002);
    }
  }

  deliver(opcode, payload) {
    this.fragments = [];
    this.fragmentOpcode = 0;
    if (opcode !== 0x1) return; // ignore binary
    const total = payload.length;
    if (total > MAX_MESSAGE_BYTES) return this.close(1009);
    this.alive = true;
    this.emit("message", payload.toString("utf8"));
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.finish();
    }
  }

  send(text) {
    this.sendFrame(0x1, Buffer.from(String(text), "utf8"));
  }

  ping() {
    this.alive = false;
    this.sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.sendFrame(0x8, payload);
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.emit("close");
  }
}

export function isWebSocketUpgrade(req) {
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  const connection = String(req.headers.connection || "").toLowerCase();
  return upgrade === "websocket" && connection.includes("upgrade") && !!req.headers["sec-websocket-key"];
}

// Completes the handshake and returns a WsConnection (or null after rejecting).
export function acceptWebSocket(req, socket, head) {
  if (!isWebSocketUpgrade(req)) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
  const conn = new WsConnection(socket);
  if (head && head.length) conn.onData(head);
  return conn;
}
