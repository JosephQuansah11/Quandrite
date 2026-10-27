/**
 * Mail.
 *
 * Quandrite sends exactly one kind of message: the host password for a room, so
 * the person who created it has the credential somewhere other than the screen.
 *
 * Two transports are supported and neither needs a dependency:
 *
 * - `smtp://user:pass@host:port` - a plain SMTP conversation (STARTTLS when the
 *   server offers it, implicit TLS on 465).
 * - an HTTP webhook (`QUANDRITE_MAIL_WEBHOOK`) - a JSON POST, which is what most
 *   automation providers accept.
 *
 * With neither configured the mailer reports itself as disabled and `send()`
 * resolves with `{ ok: false }` instead of throwing, so room creation never
 * depends on a mail server being reachable.
 */

import net from 'node:net';
import tls from 'node:tls';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailResult {
  ok: boolean;
  via?: string;
  error?: string;
}

export interface MailerOptions {
  from?: string;
  smtpUrl?: string | null;
  webhookUrl?: string | null;
  timeoutMs?: number;
  logger?: any;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value.trim());
}

/** Line-oriented SMTP session: one command, one reply. */
class SmtpSession {
  socket: any;
  buffer: string;
  lines: string[];
  waiters: Array<(line: string) => void>;

  constructor(socket: any) {
    this.socket = socket;
    this.buffer = '';
    // Replies can arrive before anyone is waiting for them (the greeting always
    // does), so they are queued rather than dropped.
    this.lines = [];
    this.waiters = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this._onData(chunk));
  }

  _onData(chunk: string) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
      index = this.buffer.indexOf('\n');
    }
  }

  nextLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** One full reply: continuation lines use `250-`, the last uses `250 `. */
  async reply(): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      lines.push(line);
      if (/^\d{3} /.test(line)) return lines;
    }
  }

  async command(line: string): Promise<string[]> {
    this.socket.write(`${line}\r\n`);
    return this.reply();
  }

  async auth(user: string, pass: string): Promise<string[]> {
    await this.command('AUTH LOGIN');
    await this.command(Buffer.from(user, 'utf8').toString('base64'));
    return this.command(Buffer.from(pass, 'utf8').toString('base64'));
  }

  close() {
    try {
      this.socket.end();
    } catch {
      // already gone
    }
  }
}

export class Mailer {
  from: string;
  smtpUrl: string | null;
  webhookUrl: string | null;
  timeoutMs: number;
  logger: any;
  sent: number;

  constructor({ from = '', smtpUrl = null, webhookUrl = null, timeoutMs = 10000, logger = console }: MailerOptions = {}) {
    this.from = from || 'Quandrite <no-reply@quandrite.local>';
    this.smtpUrl = smtpUrl || null;
    this.webhookUrl = webhookUrl || null;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.sent = 0;
  }

  get enabled(): boolean {
    return Boolean(this.smtpUrl || this.webhookUrl);
  }

  get transport(): string | null {
    if (this.smtpUrl) return 'smtp';
    if (this.webhookUrl) return 'webhook';
    return null;
  }

  /** Never throws: a broken mail server must not break room creation. */
  async send(message: MailMessage): Promise<MailResult> {
    if (!this.enabled) return { ok: false, error: 'mail is not configured on this server' };
    if (!isEmail(message.to)) return { ok: false, error: 'that is not a valid email address' };

    const to = message.to.trim();
    try {
      if (this.smtpUrl) {
        await this._withTimeout(this._sendSmtp({ ...message, to }));
        this.sent += 1;
        return { ok: true, via: 'smtp' };
      }
      await this._withTimeout(this._sendWebhook({ ...message, to }));
      this.sent += 1;
      return { ok: true, via: 'webhook' };
    } catch (error: any) {
      this.logger.warn?.(`mail to ${to} failed: ${error?.message || error}`);
      return { ok: false, error: error?.message || 'mail could not be sent' };
    }
  }

  /** The one message Quandrite sends: where the host password lives. */
  async sendHostPassword({
    to,
    roomId,
    roomName,
    hostPassword,
    cohostPassword,
    joinUrl,
  }: {
    to: string;
    roomId: string;
    roomName?: string;
    hostPassword: string;
    cohostPassword?: string | null;
    joinUrl?: string;
  }): Promise<MailResult> {
    const lines = [
      `The room "${roomName || roomId}" is ready.`,
      '',
      `Room code: ${roomId}`,
      joinUrl ? `Join: ${joinUrl}` : null,
      '',
      `Host password: ${hostPassword}`,
      cohostPassword ? `Co-host password: ${cohostPassword}` : null,
      '',
      'Open the studio, pick Host (or Co-host) and paste the password to claim the seat.',
      'You can rotate both passwords any time from the People tab.',
    ].filter((line) => line !== null);

    return this.send({
      to,
      subject: `Quandrite host password for ${roomName || roomId}`,
      text: lines.join('\n'),
    });
  }

  _withTimeout(promise: Promise<unknown>): Promise<unknown> {
    let timer: any;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`mail timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async _sendWebhook(message: MailMessage): Promise<void> {
    const response = await fetch(this.webhookUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, ...message }),
    });
    if (!response.ok) throw new Error(`the mail webhook answered ${response.status}`);
  }

  async _sendSmtp(message: MailMessage): Promise<void> {
    const url = new URL(this.smtpUrl!);
    const implicitTls = url.protocol === 'smtps:' || url.port === '465';
    const port = Number(url.port || (implicitTls ? 465 : 587));
    const host = url.hostname;
    const user = decodeURIComponent(url.username || '');
    const pass = decodeURIComponent(url.password || '');

    const socket: any = implicitTls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    const session = new SmtpSession(socket);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once(implicitTls ? 'secureConnect' : 'connect', () => resolve());
        socket.once('error', reject);
      });

      const greeting = await session.reply();
      if (!/^2\d\d/.test(greeting[0])) throw new Error(`smtp greeting: ${greeting[0]}`);

      const ehlo = await session.command(`EHLO ${host}`);
      if (!implicitTls && ehlo.some((line) => /STARTTLS/i.test(line))) {
        await session.command('STARTTLS');
        await new Promise<void>((resolve, reject) => {
          const secured = tls.connect({ socket, servername: host }, () => resolve());
          secured.once('error', reject);
          session.socket = secured;
          secured.setEncoding('utf8');
          secured.on('data', (chunk: string) => session._onData(chunk));
        });
        await session.command(`EHLO ${host}`);
      }

      if (user) {
        const auth = await session.auth(user, pass);
        if (!/^2\d\d/.test(auth[auth.length - 1])) throw new Error(`smtp auth: ${auth[auth.length - 1]}`);
      }

      const envelopeFrom = (this.from.match(/<([^>]+)>/)?.[1] || this.from).trim();
      const mailFrom = await session.command(`MAIL FROM:<${envelopeFrom}>`);
      if (!/^2\d\d/.test(mailFrom[0])) throw new Error(`smtp MAIL FROM: ${mailFrom[0]}`);

      const rcptTo = await session.command(`RCPT TO:<${message.to}>`);
      if (!/^2\d\d/.test(rcptTo[0])) throw new Error(`smtp RCPT TO: ${rcptTo[0]}`);

      const data = await session.command('DATA');
      if (!/^3\d\d/.test(data[0])) throw new Error(`smtp DATA: ${data[0]}`);

      const headers = [
        `From: ${this.from}`,
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
      ];
      // Dot-stuffing keeps a body line that is just "." from ending the message.
      const body = message.text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      await session.command(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.`);
      await session.command('QUIT');
    } finally {
      session.close();
    }
  }
}

export default Mailer;
