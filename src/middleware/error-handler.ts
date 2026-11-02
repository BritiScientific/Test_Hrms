import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, fromPgError } from '../shared/errors';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId;

  if (err instanceof ZodError) {
    return res.status(422).json({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid request', details: err.flatten(), requestId },
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body', requestId } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', requestId } });
  }

  const appErr = err instanceof AppError ? err : fromPgError(err);
  if (appErr) {
    return res.status(appErr.status).json({
      error: { code: appErr.code, message: appErr.message, details: appErr.details, requestId },
    });
  }

  // Unknown: log server-side, never leak internals.
  console.error(JSON.stringify({ level: 'error', requestId, msg: err?.message, stack: err?.stack }));
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error', requestId } });
};
