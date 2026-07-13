import { env } from '../config/env.js';
import { fromMinorUnits } from '../lib/money.js';
import { sendEmail } from './email.service.js';

interface RecipientInviteInput {
  to: string;
  recipientName: string;
  payerName: string;
  passName: string;
  amountMinor: number;
  currency: string;
  claimUrl: string;
  expiresAt: Date;
  expectedPaymentAt?: Date;
  reference?: string;
  conditionSummary?: string;
  timeZone?: string;
}

interface PayoutReceiptInput {
  to: string;
  recipientName: string;
  payerName: string;
  passName: string;
  amountMinor: number;
  currency: string;
  txHash: string;
  explorerUrl?: string;
  paidAt: Date;
  reference?: string;
  timeZone?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function normalizeTimeZone(value?: string): string {
  const candidate = value?.trim() || env.EMAIL_DEFAULT_TIME_ZONE || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'UTC';
  }
}

function formatDate(date?: Date, timeZone?: string): string {
  if (!date) return 'Not set';
  const resolvedTimeZone = normalizeTimeZone(timeZone);
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: resolvedTimeZone,
    timeZoneName: 'short'
  }).format(date);
}

function formatAmount(minor: number, currency: string): string {
  return fromMinorUnits(minor, currency).toLocaleString('en-US', { maximumFractionDigits: 8 }) + ' ' + currency;
}

function detailRow(label: string, value: string): string {
  return '<tr><td style="padding:10px 0;color:#9aa4b8;font-size:13px;">' + escapeHtml(label) + '</td><td align="right" style="padding:10px 0;color:#ffffff;font-size:13px;font-weight:700;">' + escapeHtml(value) + '</td></tr>';
}

function emailShell(title: string, preheader: string, body: string): string {
  return '<!doctype html>' +
    '<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>' + escapeHtml(title) + '</title></head>' +
    '<body style="margin:0;background:#10131a;color:#e7eaf3;font-family:Inter,Segoe UI,Arial,sans-serif;">' +
    '<div style="display:none;max-height:0;overflow:hidden;color:transparent;">' + escapeHtml(preheader) + '</div>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10131a;padding:28px 12px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#171b24;border:1px solid #2a3140;border-radius:18px;overflow:hidden;">' +
    '<tr><td style="padding:24px 26px;border-bottom:1px solid #2a3140;background:#1c2230;">' +
    '<div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#b0c6ff;font-weight:800;">FiberPass</div>' +
    '<div style="font-size:24px;line-height:1.2;color:#ffffff;font-weight:800;margin-top:6px;">' + escapeHtml(title) + '</div>' +
    '</td></tr><tr><td style="padding:26px;">' + body + '</td></tr>' +
    '<tr><td style="padding:18px 26px;border-top:1px solid #2a3140;color:#9aa4b8;font-size:12px;line-height:1.6;">' +
    'Try FiberPass. Prepaid, revocable CKB payment sessions for invoices, subscriptions, and app payments.<br />Sent from ' + escapeHtml(env.EMAIL_FROM_ADDRESS) + '.' +
    '</td></tr></table></td></tr></table></body></html>';
}

export async function sendRecipientInviteEmail(input: RecipientInviteInput): Promise<void> {
  const amount = formatAmount(input.amountMinor, input.currency);
  const expectedPaymentAt = formatDate(input.expectedPaymentAt, input.timeZone);
  const expiresAt = formatDate(input.expiresAt, input.timeZone);
  const rows = detailRow('Payer / contractor', input.payerName) + detailRow('Pass', input.passName) + detailRow('Amount', amount) + detailRow('Expected payment', expectedPaymentAt) + detailRow('Magic link expires', expiresAt) + (input.reference ? detailRow('Reference', input.reference) : '') + (input.conditionSummary ? detailRow('Condition', input.conditionSummary) : '');
  const body = '<p style="margin:0 0 18px;color:#d7ddeb;font-size:15px;line-height:1.7;">Hi ' + escapeHtml(input.recipientName) + ', ' + escapeHtml(input.payerName) + ' added you to a FiberPass payment. Add your CKB wallet address before the link expires so the payout can be released automatically.</p>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #2a3140;border-bottom:1px solid #2a3140;margin:18px 0;">' + rows + '</table>' +
    '<a href="' + escapeHtml(input.claimUrl) + '" style="display:inline-block;background:#b0c6ff;color:#10131a;text-decoration:none;font-weight:800;border-radius:12px;padding:13px 18px;font-size:13px;">Add CKB wallet</a>' +
    '<p style="margin:18px 0 0;color:#9aa4b8;font-size:12px;line-height:1.6;">If the button does not work, open this link: ' + escapeHtml(input.claimUrl) + '</p>';
  await sendEmail({
    to: input.to,
    subject: 'FiberPass details for ' + input.passName,
    text: 'Hi ' + input.recipientName + ', ' + input.payerName + ' added you to ' + input.passName + '. Amount: ' + amount + '. Expected payment: ' + expectedPaymentAt + '. Link expires: ' + expiresAt + '. Add your CKB wallet: ' + input.claimUrl,
    html: emailShell('Payment details needed', 'Add your CKB wallet to receive this FiberPass transfer.', body),
    headers: {
      'X-FiberPass-Notification': 'recipient-invite'
    }
  });
}

export async function sendRecipientPayoutReceiptEmail(input: PayoutReceiptInput): Promise<void> {
  const amount = formatAmount(input.amountMinor, input.currency);
  const explorer = input.explorerUrl ?? '';
  const paidAt = formatDate(input.paidAt, input.timeZone);
  const rows = detailRow('Payer / contractor', input.payerName) + detailRow('Pass', input.passName) + detailRow('Amount', amount) + detailRow('Paid at', paidAt) + (input.reference ? detailRow('Reference', input.reference) : '');
  const explorerButton = explorer ? '<a href="' + escapeHtml(explorer) + '" style="display:inline-block;background:#b0c6ff;color:#10131a;text-decoration:none;font-weight:800;border-radius:12px;padding:13px 18px;font-size:13px;margin-top:18px;">View on explorer</a>' : '';
  const body = '<p style="margin:0 0 18px;color:#d7ddeb;font-size:15px;line-height:1.7;">Hi ' + escapeHtml(input.recipientName) + ', your FiberPass payout from ' + escapeHtml(input.payerName) + ' was sent successfully.</p>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #2a3140;border-bottom:1px solid #2a3140;margin:18px 0;">' + rows + '</table>' +
    '<div style="background:#10131a;border:1px solid #2a3140;border-radius:12px;padding:14px;margin-top:16px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:#9aa4b8;font-weight:800;">Transaction hash</div><div style="font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#ffffff;font-size:12px;line-height:1.6;word-break:break-all;margin-top:6px;">' + escapeHtml(input.txHash) + '</div></div>' + explorerButton;
  await sendEmail({
    to: input.to,
    subject: 'FiberPass receipt for ' + input.passName,
    text: 'Hi ' + input.recipientName + ', your FiberPass payout from ' + input.payerName + ' was sent. Amount: ' + amount + '. Paid at: ' + paidAt + '. Transaction: ' + input.txHash + (explorer ? '. Explorer: ' + explorer : ''),
    html: emailShell('Payout sent', 'Your FiberPass transfer was sent successfully.', body),
    headers: {
      'X-FiberPass-Notification': 'payout-receipt'
    }
  });
}
