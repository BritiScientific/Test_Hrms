import { createHash } from 'node:crypto';
import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { conflict, forbidden, notFound, unprocessable } from '../../shared/errors';
import { sniffImageType } from '../organization/asset-storage';
import { P } from './leave-common';
import { canViewLeaveById } from './leave-request.service';

/**
 * Supporting documents. Bytes live in Postgres (RLS-protected), like the tenant
 * logo; moving to object storage only touches this file. Upload first, then link
 * when the request is created. Unlinked uploads are removed by the daily job.
 */

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export function sniffAttachmentType(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return sniffImageType(buf);
}

/** Keep the name readable but safe to put in a Content-Disposition header. */
export const safeFileName = (name: string | undefined) => {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 200).trim();
  return clean || 'attachment';
};

export async function uploadAttachment(tx: Tx, auth: AuthContext, fileName: string | undefined, data: Buffer) {
  if (!auth.employeeId) throw forbidden('NO_EMPLOYEE_RECORD', 'Your login is not linked to an employee record');
  if (!Buffer.isBuffer(data) || data.length === 0) throw unprocessable('EMPTY_FILE', 'The file is empty');
  if (data.length > MAX_ATTACHMENT_BYTES) throw unprocessable('FILE_TOO_LARGE', 'Files can be at most 5 MB');
  const contentType = sniffAttachmentType(data);
  if (!contentType) throw unprocessable('UNSUPPORTED_FILE', 'Upload a PDF, PNG, JPEG or WebP file');
  const r = await tx.query(
    `INSERT INTO leave_request_attachments (tenant_id, employee_id, file_name, content_type, byte_size, sha256, data, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, file_name, content_type, byte_size, created_at`,
    [auth.tenantId, auth.employeeId, safeFileName(fileName), contentType, data.length,
     createHash('sha256').update(data).digest('hex'), data, auth.userId],
  );
  return r.rows[0];
}

export async function getAttachment(tx: Tx, auth: AuthContext, id: number) {
  const r = await tx.query(
    `SELECT id, leave_request_id, employee_id, file_name, content_type, byte_size, sha256, data
       FROM leave_request_attachments WHERE id = $1`,
    [id],
  );
  if (!r.rowCount) throw notFound('Attachment');
  const a = r.rows[0];
  const allowed = a.leave_request_id
    ? await canViewLeaveById(tx, auth, a.leave_request_id)
    : a.employee_id === auth.employeeId || auth.permissions.has(P.requestViewAll);
  if (!allowed) throw notFound('Attachment');
  return a;
}

export async function removeUnlinkedAttachment(tx: Tx, auth: AuthContext, id: number) {
  const r = await tx.query(`SELECT employee_id, leave_request_id FROM leave_request_attachments WHERE id = $1`, [id]);
  if (!r.rowCount || r.rows[0].employee_id !== auth.employeeId) throw notFound('Attachment');
  if (r.rows[0].leave_request_id) throw conflict('ATTACHMENT_LINKED', 'This file is part of a submitted request');
  await tx.query(`DELETE FROM leave_request_attachments WHERE id = $1`, [id]);
}

export async function purgeOrphanAttachments(tx: Tx) {
  const r = await tx.query(
    `DELETE FROM leave_request_attachments WHERE leave_request_id IS NULL AND created_at < now() - interval '1 day'`,
  );
  return r.rowCount ?? 0;
}
