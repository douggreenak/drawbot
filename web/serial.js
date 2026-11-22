/* Web Serial streaming to Marlin using character-count flow control (host waits for "ok"). */
(function (g) {
  const RX_BUDGET = 96;  // Marlin RX buffer is 128 bytes on the 8-bit board; stay under it.
  const MAX_INFLIGHT = 4;

  class Printer {
    constructor() {
      this.port = null; this.writer = null; this.reader = null;
      this.queue = []; this.inflight = []; this.inflightChars = 0;
      this.paused = false; this.connected = false;
      this.onLog = () => {}; this.onState = () => {}; this.onAck = () => {}; this.onIdle = () => {};
      this.firmware = '';
      this.halted = false;
    }

    static supported() { return 'serial' in navigator; }

    async connect(baud) {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: baud, bufferSize: 4096 });
      this.writer = this.port.writable.getWriter();
      this.connected = true; this.halted = false; this.firmware = '';
      this.onState('connecting');
      this.readLoop();
      // Opening the port usually resets the board. Give the bootloader + banner time.
      await new Promise(r => setTimeout(r, 2200));
      this.sendNow('M115');
      await new Promise(r => setTimeout(r, 1500));
      this.onState(this.firmware ? 'ready' : 'silent');
    }

    async readLoop() {
      const dec = new TextDecoder();
      let buf = '';
      try {
        this.reader = this.port.readable.getReader();
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r/g, '').trim();
            buf = buf.slice(i + 1);
            if (line) this.handle(line);
          }
        }
      } catch (e) {
        this.onLog('err', 'Serial read error: ' + e.message);
      } finally {
        try { this.reader && this.reader.releaseLock(); } catch (e) { /* ignore */ }
        if (this.connected) this.cleanup();
      }
    }

    handle(line) {
      if (/^ok\b/i.test(line)) {
        const done = this.inflight.shift();
        if (done) { this.inflightChars -= done.len; this.onAck(done.tag, done.line); }
        this.pump();
        if (!this.inflight.length && !this.queue.length) this.onIdle();
        return;
      }
      if (/FIRMWARE_NAME/i.test(line)) {
        this.firmware = (line.match(/FIRMWARE_NAME:([^ ]+(?: [\d.x]+)?)/i) || [, 'Marlin'])[1];
        this.onLog('rx', line);
        return;
      }
      if (/^echo:busy/i.test(line)) return;
      if (/Printer halted|kill\(\)|Error:/i.test(line)) {
        this.onLog('err', line);
        if (/halted|kill\(\)/i.test(line)) { this.halted = true; this.onState('halted'); }
        return;
      }
      this.onLog('rx', line);
    }

    /** Fire-and-forget write, ignores flow control (used for M115 / M410). */
    async sendNow(line) {
      if (!this.writer) return;
      this.onLog('tx', line);
      await this.writer.write(new TextEncoder().encode(line + '\n'));
    }

    /** Queue lines. tags[i] is passed back to onAck when line i is acknowledged. */
    enqueue(lines, tags) {
      lines.forEach((l, i) => {
        const clean = l.replace(/;.*$/, '').trim();
        if (clean) this.queue.push({ line: clean, tag: tags ? tags[i] : -1, len: clean.length + 1 });
        else if (tags && tags[i] >= 0) this.queue.push({ line: '', tag: tags[i], len: 0 });
      });
      this.pump();
    }

    async pump() {
      if (this.pumping) return;
      this.pumping = true;
      try {
        while (this.queue.length && !this.paused && this.connected) {
          const next = this.queue[0];
          if (next.len === 0) { this.queue.shift(); this.onAck(next.tag, ''); continue; }
          if (this.inflight.length >= MAX_INFLIGHT || this.inflightChars + next.len > RX_BUDGET) {
            if (this.inflight.length) break;
          }
          this.queue.shift();
          this.inflight.push(next); this.inflightChars += next.len;
          this.onLog('tx', next.line, next.tag >= 0);
          await this.writer.write(new TextEncoder().encode(next.line + '\n'));
        }
      } catch (e) {
        this.onLog('err', 'Serial write error: ' + e.message);
      } finally { this.pumping = false; }
      if (this.paused && !this.inflight.length) this.onState('paused-idle');
    }

    pause() { this.paused = true; if (!this.inflight.length) this.onState('paused-idle'); }
    resume() { this.paused = false; this.pump(); }

    /** Drop everything queued and ask Marlin to stop the planner now. */
    async stop(after) {
      this.queue = []; this.paused = false;
      await this.sendNow('M410');
      await new Promise(r => setTimeout(r, 600));
      this.inflight = []; this.inflightChars = 0;
      if (after) this.enqueue(after);
    }

    cleanup() {
      this.connected = false; this.queue = []; this.inflight = []; this.inflightChars = 0;
      this.writer = null; this.reader = null; this.port = null;
      this.onState('disconnected');
    }

    async disconnect() {
      this.connected = false;
      try { this.reader && (await this.reader.cancel()); } catch (e) { /* ignore */ }
      try { this.writer && this.writer.releaseLock(); } catch (e) { /* ignore */ }
      try { this.port && (await this.port.close()); } catch (e) { /* ignore */ }
      this.cleanup();
    }
  }

  g.DBPrinter = Printer;
})(window);
