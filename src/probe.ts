import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomBytes } from "node:crypto";

export function httpStatus(url: string, headers: Record<string, string> = {}, timeout = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, { headers, signal: AbortSignal.timeout(timeout) }, res => {
      const status = res.statusCode ?? 0; res.destroy(); resolve(status);
    });
    req.on("error", reject); req.end();
  });
}
export function websocketUpgrade(url: string, origin: string, headers: Record<string, string> = {}, timeout = 3000): Promise<boolean> {
  return new Promise(resolve => {
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const request = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, { signal: AbortSignal.timeout(timeout), headers: {
      ...headers, Origin: origin, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
    } });
    req.once("upgrade", (res, socket) => { const valid = res.statusCode === 101 && res.headers["sec-websocket-accept"] === expected; socket.destroy(); resolve(valid); });
    req.once("response", res => { res.destroy(); resolve(false); });
    req.once("error", () => resolve(false)); req.end();
  });
}
