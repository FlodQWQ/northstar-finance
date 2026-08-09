import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { ConnectionTestResult } from "../providers/price";
import type { SqliteDatabase } from "../db/database";
import type { FinanceRepository } from "./repository";

interface OutboxRow {
  id: string;
  run_id: string | null;
  recipient: string;
  subject: string;
  text_body: string;
  html_body: string;
  attempts: number;
}

function smtpPort(): number {
  const parsed = Number(process.env.SMTP_PORT ?? 587);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : 587;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export interface EmailOutbox {
  enqueue(input: {
    runId: string;
    recipient: string;
    subject: string;
    body: string;
  }): "pending" | "skipped";
  processDue(limit?: number): Promise<void>;
  testConnection(): Promise<ConnectionTestResult>;
}

export class SmtpEmailOutbox implements EmailOutbox {
  public constructor(
    private readonly db: SqliteDatabase,
    private readonly repository: FinanceRepository,
  ) {}

  private getTransportConfig() {
    const host = process.env.SMTP_HOST?.trim() ?? "";
    const from = process.env.SMTP_FROM?.trim() ?? "";
    return {
      configured: Boolean(host && from),
      transport: {
        host,
        port: smtpPort(),
        secure: process.env.SMTP_SECURE?.trim().toLowerCase() === "true",
      },
      from,
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    };
  }

  public enqueue(input: {
    runId: string;
    recipient: string;
    subject: string;
    body: string;
  }): "pending" | "skipped" {
    const { configured } = this.getTransportConfig();
    const status = configured && input.recipient ? "pending" : "skipped";
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO email_outbox (
        id, owner_id, run_id, recipient, subject, text_body, html_body, status,
        attempts, next_attempt_at, provider_message_id, last_error, created_at, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '', ?, ?, NULL)
    `).run(
      randomUUID(),
      this.repository.ownerId,
      input.runId,
      input.recipient,
      input.subject.replace(/[\r\n]/g, " "),
      input.body,
      `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(input.body)}</pre>`,
      status,
      now,
      status === "skipped" ? "SMTP is not configured" : "",
      now,
    );
    this.db.prepare(`
      UPDATE monitor_runs SET email_status = ? WHERE owner_id = ? AND id = ?
    `).run(status, this.repository.ownerId, input.runId);
    return status;
  }

  public async processDue(limit = 10): Promise<void> {
    const { configured, transport, from, auth } = this.getTransportConfig();
    if (!configured) {
      this.db.prepare(`
        UPDATE email_outbox
        SET status = 'skipped', last_error = 'SMTP is not configured'
        WHERE owner_id = ? AND status = 'pending'
      `).run(this.repository.ownerId);
      this.db.prepare(`
        UPDATE monitor_runs SET email_status = 'skipped'
        WHERE owner_id = ? AND id IN (
          SELECT run_id FROM email_outbox WHERE owner_id = ? AND status = 'skipped'
        )
      `).run(this.repository.ownerId, this.repository.ownerId);
      return;
    }

    const rows = this.db.prepare(`
      SELECT id, run_id, recipient, subject, text_body, html_body, attempts
      FROM email_outbox
      WHERE owner_id = ? AND status = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at LIMIT ?
    `).all(this.repository.ownerId, new Date().toISOString(), limit) as OutboxRow[];
    if (rows.length === 0) return;

    const transporter = nodemailer.createTransport({
      ...transport,
      auth,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    for (const row of rows) {
      try {
        const result = await transporter.sendMail({
          from: from.replace(/[\r\n]/g, " "),
          to: row.recipient,
          subject: row.subject,
          text: row.text_body,
          html: row.html_body,
        });
        const now = new Date().toISOString();
        this.db.prepare(`
          UPDATE email_outbox
          SET status = 'sent', attempts = attempts + 1, provider_message_id = ?,
              last_error = '', sent_at = ?
          WHERE owner_id = ? AND id = ?
        `).run(result.messageId ?? "", now, this.repository.ownerId, row.id);
        if (row.run_id) {
          this.db.prepare(`
            UPDATE monitor_runs SET email_status = 'sent' WHERE owner_id = ? AND id = ?
          `).run(this.repository.ownerId, row.run_id);
        }
      } catch (error) {
        const attempts = row.attempts + 1;
        const terminal = attempts >= 3;
        const delayMinutes = 2 ** attempts;
        const nextAttempt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
        const message = error instanceof Error ? error.message : "Unknown SMTP error";
        this.db.prepare(`
          UPDATE email_outbox
          SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
          WHERE owner_id = ? AND id = ?
        `).run(
          terminal ? "failed" : "pending",
          attempts,
          nextAttempt,
          message.slice(0, 2_000),
          this.repository.ownerId,
          row.id,
        );
        if (terminal && row.run_id) {
          this.db.prepare(`
            UPDATE monitor_runs SET email_status = 'failed' WHERE owner_id = ? AND id = ?
          `).run(this.repository.ownerId, row.run_id);
        }
      }
    }
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    const { configured, transport, auth } = this.getTransportConfig();
    if (!configured) {
      return { ok: false, status: "skipped", message: "SMTP is not configured." };
    }
    try {
      const transporter = nodemailer.createTransport({
        ...transport,
        auth,
        connectionTimeout: 10_000,
      });
      await transporter.verify();
      return { ok: true, status: "connected", message: "SMTP connection succeeded." };
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        message: error instanceof Error ? error.message : "SMTP connection failed.",
      };
    }
  }
}
