import { HttpInterceptorFn } from '@angular/common/http';

/**
 * Ensures every request includes the session cookie.
 * The browser handles auth automatically — no token logic on the client.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req.clone({ withCredentials: true }));
};
