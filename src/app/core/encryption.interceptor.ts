/**
 * HTTP interceptor — transparently handles all encryption, signing, and decryption.
 * Business logic code requires zero changes (AC #4).
 *
 * Outgoing authenticated requests:
 *   1. Generate nonce (UUID) + timestamp
 *   2. HMAC-sign "{METHOD}\n{PATH}\n{TIMESTAMP}\n{NONCE}"
 *   3. Add headers: X-Enc-Session, X-Request-Nonce, X-Request-Timestamp, X-Request-Signature
 *   4. If body present: AES-256-GCM encrypt → send as application/octet-stream binary
 *   5. Set responseType: 'arraybuffer' so we receive the encrypted binary response
 *
 * Incoming responses:
 *   - Content-Type application/octet-stream → AES-GCM decrypt → gunzip → JSON object
 *   - Any other Content-Type as ArrayBuffer  → decode as UTF-8 JSON (plain response)
 *   - Non-ArrayBuffer body                   → pass through unchanged
 */
import {
  HttpInterceptorFn,
  HttpRequest,
  HttpHandlerFn,
  HttpEvent,
  HttpResponse,
  HttpErrorResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, of, map, throwError } from 'rxjs';
import { EncryptionService } from './encryption.service';
import { environment } from '../../environments/environment';

const API_BASE = environment.apiUrl;

/**
 * Routes that must be passed through without any encryption/signing:
 *  - Key-exchange bootstrap endpoints (no session exists yet)
 *  - Auth endpoints rely on secure session cookie auth and should not block on
 *    encryption handshake readiness.
 */
const SKIP_PATHS = ['/session/key', '/session/init', '/auth/google', '/auth/me', '/auth/logout', '/auth/logout-all'];

export const encryptionInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): ReturnType<HttpHandlerFn> => {
  const encSvc = inject(EncryptionService);

  // Only intercept our own API calls
  if (!req.url.startsWith(API_BASE)) return next(req);
  if (SKIP_PATHS.some((p) => req.url.includes(p))) return next(req);
  if (!encSvc.ready() || !encSvc.sessionId) return next(req);

  return from(buildRequest(req, encSvc)).pipe(
    switchMap((encReq) =>
      next(encReq).pipe(
        switchMap((event: HttpEvent<unknown>) => {
          if (!(event instanceof HttpResponse)) return of(event);
          if (!(event.body instanceof ArrayBuffer)) return of(event);

          const ct = event.headers.get('content-type') ?? '';

          if (ct.includes('application/octet-stream')) {
            // ── Encrypted binary response → decrypt + decompress → JSON ──────
            return from(encSvc.decryptResponse(event.body)).pipe(
              map((parsed) => event.clone({ body: parsed })),
            );
          }

          // ── Plain JSON received as ArrayBuffer (shouldn't happen for auth
          //    routes since they're in SKIP_PATHS, but guard anyway) ──────────
          try {
            const text = new TextDecoder().decode(event.body);
            return of(event.clone({ body: JSON.parse(text) }));
          } catch {
            return of(event); // unparseable — pass raw body through
          }
        }),
        catchError((err) =>
          from(normalizeEncryptedError(err, encSvc)).pipe(
            switchMap((normalized) => throwError(() => normalized)),
          ),
        ),
      ),
    ),
  );
};

async function normalizeEncryptedError(error: unknown, encSvc: EncryptionService): Promise<unknown> {
  if (!(error instanceof HttpErrorResponse)) return error;
  if (!(error.error instanceof ArrayBuffer)) return error;

  const ct = error.headers.get('content-type') ?? '';
  let parsed: unknown = error.error;

  try {
    if (ct.includes('application/octet-stream')) {
      parsed = await encSvc.decryptResponse(error.error);
    } else {
      const text = new TextDecoder().decode(error.error);
      parsed = text ? JSON.parse(text) : null;
    }
  } catch {
    return error;
  }

  return new HttpErrorResponse({
    error: parsed,
    headers: error.headers,
    status: error.status,
    statusText: error.statusText,
    url: error.url ?? undefined,
  });
}

// ── Request builder ───────────────────────────────────────────────────────────

async function buildRequest(
  req: HttpRequest<unknown>,
  encSvc: EncryptionService,
): Promise<HttpRequest<unknown>> {
  const sessionId = encSvc.sessionId!;
  const nonce     = crypto.randomUUID();
  const timestamp = String(Date.now());

  // Use only the pathname for HMAC so it matches what Fastify sees in req.url
  const path = new URL(req.url).pathname;

  const signature = await encSvc.sign(req.method, path, timestamp, nonce);

  const securityHeaders = {
    'X-Enc-Session':       sessionId,
    'X-Request-Nonce':     nonce,
    'X-Request-Timestamp': timestamp,
    'X-Request-Signature': signature,
    'X-Api-Version':       '1',
  };

  const hasBody = req.body !== null && ['POST', 'PUT', 'PATCH'].includes(req.method);

  if (!hasBody) {
    return req.clone({
      setHeaders: securityHeaders,
      responseType: 'arraybuffer' as const,
    });
  }

  // POST / PUT / PATCH — AES-256-GCM encrypt body
  const encryptedBody = await encSvc.encryptBody(req.body);
  return req.clone({
    body: encryptedBody,
    setHeaders: {
      ...securityHeaders,
      'Content-Type': 'application/octet-stream',
    },
    responseType: 'arraybuffer' as const,
  });
}
