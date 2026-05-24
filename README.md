# Hub Frontend

Angular 19 (standalone) + Bootstrap 5 + Google Identity Services.

## Quick start

```bash
npm install
# point to your backend (default http://localhost:3000) and Google client id
# edit src/environments/environment.ts
npm start
# → http://localhost:4200
```

## Auth model

- **Zero token handling on the client.** A Google ID token is sent **once** to the backend at sign-in.
- Every other request goes out with `withCredentials: true` (the credentials interceptor) so the browser sends the `sid` cookie.
- The backend rotates the session silently and updates the cookie on responses.

## Routes

| Path | Component | Guard |
|---|---|---|
| `/login` | `LoginComponent` | – |
| `/chat` | `ChatComponent` | `authGuard` |

## Structure

```
src/app/
├── app.component.ts
├── app.config.ts
├── app.routes.ts
├── core/
│   ├── auth.service.ts          # session signal + Google login
│   ├── auth.guard.ts            # canActivate
│   ├── credentials.interceptor.ts
│   ├── chat.service.ts          # chats + messages signals
│   ├── usage.service.ts         # today + week usage signals
│   ├── user.service.ts          # PUT /users/me
│   └── models.ts
├── pages/
│   ├── login/login.component.ts
│   └── chat/chat.component.ts
└── components/
    ├── sidebar/
    ├── topbar/
    ├── composer/
    ├── message/
    ├── empty-state/
    ├── profile-modal/
    └── usage-modal/
```
