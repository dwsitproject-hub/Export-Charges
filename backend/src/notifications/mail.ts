import { Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import type { AppConfig } from '../config';

export const MAIL_SENDER = Symbol('MAIL_SENDER');

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Where the email-outbox job hands each message (Technical Design §4.2.7 "email-outbox"). */
export interface MailSender {
  send(mail: Mail): Promise<void>;
}

/** Corporate SMTP relay; STARTTLS is required unless the connection is TLS from the start or SMTP_REQUIRE_TLS=false. */
export class SmtpMailSender implements MailSender {
  private readonly transport: Transporter;

  constructor(private readonly from: string, smtp: NonNullable<AppConfig['smtp']>) {
    this.transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: !smtp.secure && smtp.requireTls,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}

/** Local development: the message goes to the application log instead of a mailbox. */
export class LogMailSender implements MailSender {
  private readonly logger = new Logger('Mail');

  async send(mail: Mail): Promise<void> {
    this.logger.log(`To ${mail.to}: ${mail.subject}\n${mail.text}`);
  }
}

/** Tests: messages are kept in memory; `failNext` simulates relay failures. */
export class MemoryMailSender implements MailSender {
  readonly sent: Mail[] = [];
  failNext = 0;

  async send(mail: Mail): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('SMTP relay unavailable');
    }
    this.sent.push(mail);
  }
}

export function mailSender(config: AppConfig): MailSender {
  if (config.mailTransport === 'smtp') return new SmtpMailSender(config.mailFrom, config.smtp!);
  if (config.mailTransport === 'memory') return new MemoryMailSender();
  return new LogMailSender();
}
