import { createHash } from 'node:crypto';
import type { Tx } from '../../config/db';

/**
 * Storage for tenant branding assets. The default implementation keeps the
 * bytes in Postgres (tenant_assets, RLS-protected). An S3 implementation only
 * has to satisfy this interface; nothing else in the app knows where bytes live.
 */
export type AssetKind = 'logo';
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface StoredAsset {
  contentType: ImageType;
  byteSize: number;
  sha256: string;
  updatedAt: string;
}

export interface AssetStorage {
  head(tx: Tx, kind: AssetKind): Promise<StoredAsset | null>;
  get(tx: Tx, kind: AssetKind): Promise<(StoredAsset & { data: Buffer }) | null>;
  put(tx: Tx, tenantId: number, kind: AssetKind, contentType: ImageType, data: Buffer, userId: number): Promise<StoredAsset>;
  remove(tx: Tx, kind: AssetKind): Promise<boolean>;
}

export const MAX_LOGO_BYTES = 512 * 1024;

/** Identify an image by its magic bytes; the declared Content-Type is never trusted on its own. SVG is rejected (it can carry script). */
export function sniffImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const toAsset = (r: any): StoredAsset => ({
  contentType: r.content_type,
  byteSize: r.byte_size,
  sha256: r.sha256,
  updatedAt: r.updated_at,
});

export const postgresAssetStorage: AssetStorage = {
  async head(tx, kind) {
    const r = await tx.query(
      `SELECT content_type, byte_size, sha256, updated_at FROM tenant_assets WHERE kind = $1`, [kind]);
    return r.rowCount ? toAsset(r.rows[0]) : null;
  },
  async get(tx, kind) {
    const r = await tx.query(
      `SELECT content_type, byte_size, sha256, updated_at, data FROM tenant_assets WHERE kind = $1`, [kind]);
    return r.rowCount ? { ...toAsset(r.rows[0]), data: r.rows[0].data as Buffer } : null;
  },
  async put(tx, tenantId, kind, contentType, data, userId) {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const r = await tx.query(
      `INSERT INTO tenant_assets (tenant_id, kind, content_type, byte_size, sha256, data, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, kind) DO UPDATE
         SET content_type = EXCLUDED.content_type, byte_size = EXCLUDED.byte_size,
             sha256 = EXCLUDED.sha256, data = EXCLUDED.data,
             updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING content_type, byte_size, sha256, updated_at`,
      [tenantId, kind, contentType, data.length, sha256, data, userId],
    );
    return toAsset(r.rows[0]);
  },
  async remove(tx, kind) {
    const r = await tx.query(`DELETE FROM tenant_assets WHERE kind = $1`, [kind]);
    return (r.rowCount ?? 0) > 0;
  },
};

export const assetStorage: AssetStorage = postgresAssetStorage;
