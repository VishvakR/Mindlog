import { randomBytes } from 'node:crypto';
import { connect as connectNet } from 'node:net';
import type { Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { err, mindlogError, ok } from '@mindlog/core';
import type { Logger, MindlogError, Result } from '@mindlog/core';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Sends email for the opt-in OTP, verification and reset flows (ADR-0035). */
export interface Mailer {
  send(message: MailMessage): Promise<Result<void, MindlogError>>;
}

/** Development mailer: logs the message instead of sending it (the code shows in the server log). */
export class ConsoleMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  send(message: MailMessage): Promise<Result<void, MindlogError>> {
    this.logger.info('mail (console mailer)', {
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return Promise.resolve(ok(undefined));
  }
}

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS (port 465); otherwise STARTTLS when the server offers it. */
  readonly tls: boolean;
  /** Refuse to send in clear text when the server offers no STARTTLS. */
  readonly requireTls: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly from: string;
  readonly timeoutMs: number;
  /** Test servers use self-signed certificates. */
  readonly rejectUnauthorized?: boolean;
}

const CRLF = /[\r\n]/;

/** RFC 2047 encoded-word for a non-ASCII subject. */
const encodeHeader = (s: string): string =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;

/** A minimal SMTP client over `node:net`/`node:tls`: EHLO, STARTTLS, AUTH PLAIN, MAIL, RCPT, DATA. */
export class SmtpMailer implements Mailer {
  constructor(private readonly o: SmtpOptions) {}

  async send(message: MailMessage): Promise<Result<void, MindlogError>> {
    if (CRLF.test(message.to) || CRLF.test(message.subject) || CRLF.test(this.o.from)) {
      return err(mindlogError('INVALID_ARGUMENT', 'mail headers cannot contain line breaks'));
    }
    let session: SmtpSession | undefined;
    try {
      session = await SmtpSession.open(this.o);
      await session.expect(220);
      let features = await session.command(`EHLO mindlog`, 250);
      if (!this.o.tls && features.some((f) => f.toUpperCase().startsWith('STARTTLS'))) {
        await session.command('STARTTLS', 220);
        await session.upgrade(this.o);
        features = await session.command('EHLO mindlog', 250);
      } else if (!this.o.tls && this.o.requireTls) {
        throw new Error('the SMTP server offers no STARTTLS');
      }
      if (this.o.username !== undefined && this.o.password !== undefined) {
        const plain = Buffer.from(`\0${this.o.username}\0${this.o.password}`).toString('base64');
        await session.command(`AUTH PLAIN ${plain}`, 235);
      }
      await session.command(`MAIL FROM:<${this.o.from}>`, 250);
      await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await session.command('DATA', 354);
      await session.command(`${this.#format(message)}\r\n.`, 250);
      await session.command('QUIT', 221).catch(() => undefined);
      return ok(undefined);
    } catch (e) {
      return err(
        mindlogError(
          'UNAVAILABLE',
          `mail was not sent: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    } finally {
      session?.close();
    }
  }

  #format(m: MailMessage): string {
    const host = this.o.from.split('@')[1] ?? 'mindlog';
    const headers = [
      `From: <${this.o.from}>`,
      `To: <${m.to}>`,
      `Subject: ${encodeHeader(m.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString('hex')}@${host}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
    ];
    // Dot-stuffing: a line starting with "." gets another (RFC 5321 4.5.2).
    const body = m.text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    return `${headers.join('\r\n')}\r\n\r\n${body}`;
  }
}

/** One SMTP connection: reads replies (multi-line `250-…`) and sends commands. */
class SmtpSession {
  #buffer = '';
  #waiters: (() => void)[] = [];
  #error: Error | undefined;

  private constructor(private socket: Socket) {
    this.#listen(socket);
  }

  static open(o: SmtpOptions): Promise<SmtpSession> {
    return new Promise((resolve, reject) => {
      const socket = o.tls
        ? connectTls({
            host: o.host,
            port: o.port,
            rejectUnauthorized: o.rejectUnauthorized ?? true,
          })
        : connectNet({ host: o.host, port: o.port });
      socket.setTimeout(o.timeoutMs, () => socket.destroy(new Error('SMTP timeout')));
      socket.once(o.tls ? 'secureConnect' : 'connect', () => {
        resolve(new SmtpSession(socket));
      });
      socket.once('error', reject);
    });
  }

  #listen(socket: Socket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk;
      this.#wake();
    });
    socket.on('error', (e) => {
      this.#error = e;
      this.#wake();
    });
    socket.on('close', () => {
      this.#error ??= new Error('SMTP connection closed');
      this.#wake();
    });
  }

  #wake(): void {
    for (const w of this.#waiters.splice(0)) w();
  }

  async upgrade(o: SmtpOptions): Promise<void> {
    this.socket.removeAllListeners('data');
    const secure = await new Promise<Socket>((resolve, reject) => {
      const s = connectTls({
        socket: this.socket,
        servername: o.host,
        rejectUnauthorized: o.rejectUnauthorized ?? true,
      });
      s.once('secureConnect', () => {
        resolve(s);
      });
      s.once('error', reject);
    });
    this.socket = secure;
    this.#buffer = '';
    this.#listen(secure);
  }

  /** The lines of the next complete reply, after checking its code. */
  async expect(codes: number | number[]): Promise<string[]> {
    const wanted = Array.isArray(codes) ? codes : [codes];
    for (;;) {
      const lines = this.#buffer.split('\r\n');
      const end = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
      if (end !== -1) {
        const reply = lines.slice(0, end + 1);
        this.#buffer = lines.slice(end + 1).join('\r\n');
        const code = Number((reply[end] ?? '').slice(0, 3));
        if (!wanted.includes(code)) throw new Error(`SMTP ${reply.join(' ')}`);
        return reply.map((l) => l.slice(4));
      }
      if (this.#error) throw this.#error;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  command(line: string, codes: number | number[]): Promise<string[]> {
    this.socket.write(`${line}\r\n`);
    return this.expect(codes);
  }

  close(): void {
    this.socket.destroy();
  }
}
