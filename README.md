# paperclip-session-api

Kleiner REST-Service vor der bestehenden Paperclip-Postgres-DB.

Zweck:
- Issues lesen
- neues Ticket mit bestehendem User-Session-Token anlegen
- Kommentar auf bestehendes Ticket schreiben

Auth:
- `Authorization: Session <token>`
- alternativ `X-Session-Token: <token>`

Endpunkte:
- `GET /healthz`
- `GET /v1/companies`
- `GET /v1/projects?companyId=<uuid>[&limit=<n>]`
- `GET /v1/projects/:projectId`
- `GET /v1/agents?companyId=<uuid>[&limit=<n>]`
- `GET /v1/issues?companyId=<uuid>[&status=<status>][&limit=<n>]`
- `GET /v1/issues/:issueRef`
- `GET /v1/issues/:issueRef/comments`
- `PATCH /v1/issues/:issueRef`
- `POST /v1/issues`
- `POST /v1/issues/:issueRef/comments`

`issueRef` kann entweder die UUID des Issues oder der Identifier wie `SYN-19` sein.

## Start

```bash
export DATABASE_URL='postgresql://paperclip_app:...@127.0.0.1:5432/paperclip'
npm install
npm start
```

## Beispiel

```bash
curl 'https://pc.melchinger.net/session-api/v1/companies' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://pc.melchinger.net/session-api/v1/projects?companyId=c2656035-8c2e-49a8-b946-4906aabbeb9a' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://pc.melchinger.net/session-api/v1/projects/11111111-1111-4111-8111-111111111111' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://pc.melchinger.net/session-api/v1/agents?companyId=c2656035-8c2e-49a8-b946-4906aabbeb9a' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://pc.melchinger.net/session-api/v1/issues?companyId=c2656035-8c2e-49a8-b946-4906aabbeb9a' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://pc.melchinger.net/session-api/v1/issues/SYN-19' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://pc.melchinger.net/session-api/v1/issues/SYN-19/comments' \
  -H 'Authorization: Session <token>'
```

```bash
curl -X PATCH 'https://pc.melchinger.net/session-api/v1/issues/SYN-19' \
  -H 'Authorization: Session <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "todo"
  }'
```

```bash
curl -X POST http://127.0.0.1:4310/v1/issues \
  -H 'Authorization: Session <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "companyId": "c2656035-8c2e-49a8-b946-4906aabbeb9a",
    "projectId": "11111111-1111-4111-8111-111111111111",
    "title": "API-Test",
    "description": "erstellt ueber den session service",
    "priority": "medium"
  }'
```

```bash
curl -X POST http://127.0.0.1:4310/v1/issues/SYN-19/comments \
  -H 'Authorization: Session <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "body": "Kommentar ueber den session service"
  }'
```

## Reverse Proxy

Beispiel fuer Nginx:

```nginx
siehe `deploy/nginx.conf.example`
```

Hinweise:
- den Service nur hinter TLS exponieren
- Request-Body-Limits und Rate-Limits besser im Proxy erzwingen
- Session-Token nicht in URLs oder Query-Strings uebergeben
- fuer `systemd` gibt es `deploy/paperclip-session-api.service.example`
- `issueRef` akzeptiert UUID oder Identifier wie `SYN-19`
- `POST /v1/issues` verlangt jetzt immer ein gueltiges `projectId`, das zur angegebenen Company gehoert und fuer den User zugaenglich ist
- `PATCH /v1/issues/:issueRef` erlaubt: `status`, `title`, `description`, `priority`, `projectId`, `goalId`, `parentId`, `assigneeUserId`, `billingCode`, `hiddenAt`
