import { APP_INITIALIZER, ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { credentialsInterceptor } from './core/credentials.interceptor';
import { encryptionInterceptor } from './core/encryption.interceptor';
import { EncryptionService } from './core/encryption.service';

/**
 * Run ECDH key exchange before Angular renders anything.
 * If it fails the app continues — HTTPS still protects all traffic.
 */
function initEncryption(enc: EncryptionService) {
  return () => enc.init();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(
      withFetch(),
      // credentials first (cookies) → then encryption headers
      withInterceptors([credentialsInterceptor, encryptionInterceptor]),
    ),
    {
      provide:    APP_INITIALIZER,
      useFactory: initEncryption,
      deps:       [EncryptionService],
      multi:      true,
    },
  ],
};
