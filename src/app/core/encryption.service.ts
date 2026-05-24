/**
 * Client-side crypto — mirrors backend/src/infra/encryption.ts exactly.
 * Uses only the browser's built-in Web Crypto API (SubtleCrypto).
 * Zero external dependencies. Nothing is ever written to disk or localStorage.
 *
 * Key derivation:
 *   shared_secret = ECDH(client_private, server_public)
 *   aes_key       = HKDF(shared_secret, info="aes-key",  len=256)
 *   hmac_key      = HKDF(shared_secret, info="hmac-key", len=256)
 *
 * Request bodies : AES-256-GCM(JSON)       → ArrayBuffer [IV‖CT‖TAG]
 * Response bodies: AES-256-GCM(gzip(JSON)) → ArrayBuffer [IV‖CT‖TAG]
 */
import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

const BASE = environment.apiUrl + '/v1';
const enc  = new TextEncoder();
const dec  = new TextDecoder();

@Injectable({ providedIn: 'root' })
export class EncryptionService {
  private http = inject(HttpClient);

  /** True once the ECDH handshake has completed and keys are in memory. */
  readonly ready = signal(false);

  private _sessionId: string | null = null;
  private _aesKey:    CryptoKey | null = null;
  private _hmacKey:   CryptoKey | null = null;
  private initPromise: Promise<void> | null = null;

  get sessionId(): string | null { return this._sessionId; }

  // ── Initialisation ─────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.ready()) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      // 1. Fetch server's ECDH public key
      const { publicKey: serverJwk } = await firstValueFrom(
        this.http.get<{ publicKey: JsonWebKey }>(`${BASE}/session/key`, { withCredentials: true }),
      );
      const serverPublicKey = await crypto.subtle.importKey(
        'jwk', serverJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false, [],
      );

      // 2. Generate ephemeral client key pair (public key will be sent to server)
      const clientKP = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,           // public key must be extractable to POST to server
        ['deriveBits'],
      );

      // 3. ECDH → 256-bit shared secret
      const sharedBits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: serverPublicKey },
        clientKP.privateKey,
        256,
      );

      // 4. Import as HKDF key material
      const hkdfKey = await crypto.subtle.importKey(
        'raw', sharedBits, 'HKDF', false, ['deriveBits'],
      );
      const salt = new Uint8Array(32);

      // 5. Derive AES-256-GCM key
      const aesBits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('aes-key') },
        hkdfKey, 256,
      );
      this._aesKey = await crypto.subtle.importKey(
        'raw', aesBits,
        { name: 'AES-GCM', length: 256 },
        false, ['encrypt', 'decrypt'],
      );

      // 6. Derive HMAC-SHA256 key
      const hmacBits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('hmac-key') },
        hkdfKey, 256,
      );
      this._hmacKey = await crypto.subtle.importKey(
        'raw', hmacBits,
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign'],
      );

      // 7. POST client public key → receive session ID
      const clientPublicKeyJwk = await crypto.subtle.exportKey('jwk', clientKP.publicKey);
      const { sessionId } = await firstValueFrom(
        this.http.post<{ sessionId: string }>(
          `${BASE}/session/init`,
          { clientPublicKey: clientPublicKeyJwk },
          { withCredentials: true },
        ),
      );

      this._sessionId = sessionId;
      this.ready.set(true);
    } catch (err) {
      // Non-fatal: the interceptor skips encryption if not ready.
      // HTTPS still protects the wire.
      console.warn('[EncryptionService] handshake failed — continuing without payload encryption', err);
    }
  }

  // ── HMAC request signing ───────────────────────────────────────────────────

  /**
   * Signs "{METHOD}\n{PATH}\n{TIMESTAMP}\n{NONCE}" with HMAC-SHA256.
   * Returns base64-encoded signature.
   */
  async sign(method: string, path: string, timestamp: string, nonce: string): Promise<string> {
    if (!this._hmacKey) throw new Error('EncryptionService not ready');
    const sigString = `${method}\n${path}\n${timestamp}\n${nonce}`;
    const sig = await crypto.subtle.sign('HMAC', this._hmacKey, enc.encode(sigString));
    return this.toBase64(sig);
  }

  // ── AES-256-GCM request encryption ────────────────────────────────────────

  /**
   * Encrypts a JS value to [IV(12)‖CT‖TAG] ArrayBuffer.
   * The server expects this exact binary layout.
   */
  async encryptBody(data: unknown): Promise<ArrayBuffer> {
    if (!this._aesKey) throw new Error('EncryptionService not ready');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = enc.encode(JSON.stringify(data));
    const ctWithTag = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._aesKey, plain);
    // Prepend IV
    const out = new Uint8Array(12 + ctWithTag.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ctWithTag), 12);
    return out.buffer;
  }

  // ── AES-256-GCM response decryption ───────────────────────────────────────

  /**
   * Decrypts a [IV(12)‖CT‖TAG] ArrayBuffer from the server.
   * Responses are gzip-compressed before encryption, so we decompress after.
   */
  async decryptResponse(buf: ArrayBuffer): Promise<unknown> {
    if (!this._aesKey) throw new Error('EncryptionService not ready');
    const iv           = buf.slice(0, 12);
    const ctWithTag    = buf.slice(12);
    const compressed   = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      this._aesKey,
      ctWithTag,
    );
    const json = await this.gunzip(compressed);
    return JSON.parse(json);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async gunzip(compressed: ArrayBuffer): Promise<string> {
    const ds      = new DecompressionStream('gzip');
    const writer  = ds.writable.getWriter();
    const reader  = ds.readable.getReader();
    writer.write(new Uint8Array(compressed));
    writer.close();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    return dec.decode(merged);
  }

  private toBase64(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
}
