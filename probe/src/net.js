// TCP client for port 25. The caller passes an address it has already checked.
import net from "node:net";

export function connectSmtp(ip, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (port !== 25) { reject(new Error("bad_port")); return; }
    const socket = net.connect({ host: ip, port, family: String(ip).includes(":") ? 6 : 4 });
    let buf = "";
    const lines = [];
    const pending = [];
    let failed = null;
    let settled = false;
    const timer = setTimeout(() => fail(new Error("timeout")), timeoutMs);
    const fail = (err) => {
      failed = failed || err || new Error("connect_failed");
      clearTimeout(timer);
      socket.destroy();
      while (pending.length) pending.shift().reject(failed);
      if (!settled) { settled = true; reject(failed); }
    };
    const pushLine = (line) => {
      if (pending.length) pending.shift().resolve(line);
      else lines.push(line);
    };
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (buf.length > 64 * 1024) { fail(new Error("banner_too_large")); return; }
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 512) { fail(new Error("line_too_long")); return; }
        pushLine(line);
      }
    });
    socket.on("timeout", () => fail(new Error("timeout")));
    socket.on("error", (err) => fail(err));
    socket.on("close", () => { if (!failed) fail(new Error("closed")); });
    const readLine = () => {
      if (lines.length) return Promise.resolve(lines.shift());
      if (failed) return Promise.reject(failed);
      return new Promise((res, rej) => pending.push({ resolve: res, reject: rej }));
    };
    const api = {
      async readReply() {
        const got = [];
        for (;;) {
          const line = await readLine();
          got.push(line);
          if (/^\d{3} /.test(line)) return got;
          if (!/^\d{3}-/.test(line) || got.length > 40) throw new Error("bad_reply");
        }
      },
      write(s) { socket.write(s); },
      close() { clearTimeout(timer); socket.end(); },
    };
    socket.once("connect", () => {
      if (failed) return;
      settled = true;
      socket.setTimeout(timeoutMs);
      resolve(api);
    });
  });
}
